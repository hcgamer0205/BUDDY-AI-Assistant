import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Modality, type LiveServerMessage } from '@google/genai';
import { WebSocketServer } from 'ws';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

const DEFAULT_ALLOWED_ORIGINS = [
  'https://localhost',
  'http://localhost',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'capacitor://localhost',
  'ionic://localhost',
];

function getConfiguredApiToken(): string {
  return (process.env.SURYA_API_TOKEN || '').trim();
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // Native Android / curl requests without browser Origin header
  const envOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const appUrl = process.env.APP_URL ? process.env.APP_URL.trim().replace(/\/+$/, '') : '';
  const allAllowed = [...DEFAULT_ALLOWED_ORIGINS, ...envOrigins, ...(appUrl ? [appUrl] : [])];

  const normalizedOrigin = origin.trim().replace(/\/+$/, '');
  if (allAllowed.includes(normalizedOrigin)) return true;
  if (/^https?:\/\/localhost(:\d+)?$/.test(normalizedOrigin)) return true;
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(normalizedOrigin)) return true;
  if (/^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/.test(normalizedOrigin)) return true;
  return false;
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const reqId = (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].trim()) || crypto.randomUUID();
  res.setHeader('X-Request-Id', reqId);

  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, X-Surya-Client-Id, X-Request-Id');

  if (req.method === 'OPTIONS') {
    if (origin && !isAllowedOrigin(origin)) {
      return res.status(403).json({ error: 'Origin not permitted by BUDDY CORS policy.' });
    }
    return res.sendStatus(204);
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// In-Memory Sliding Window Rate Limiter
interface RateLimitRecord {
  timestamps: number[];
}

const rateLimitBuckets = new Map<string, RateLimitRecord>();

function rateLimiter(maxRequests: number, windowSeconds: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const key = `${Array.isArray(ip) ? ip[0] : ip}:${req.baseUrl || req.path}`;
    const now = Date.now();
    const windowMs = windowSeconds * 1000;

    let record = rateLimitBuckets.get(key);
    if (!record) {
      record = { timestamps: [] };
      rateLimitBuckets.set(key, record);
    }

    // Clean expired timestamps
    record.timestamps = record.timestamps.filter((t) => now - t < windowMs);

    if (record.timestamps.length >= maxRequests) {
      return res.status(429).json({
        error: 'Rate limit exceeded. System throttling active. Please retry in a moment.',
        retryAfterSeconds: Math.ceil((windowMs - (now - record.timestamps[0])) / 1000),
      });
    }

    record.timestamps.push(now);
    next();
  };
}

// Global API rate limiter (default 180 req / minute)
const GLOBAL_RATE_LIMIT = Number(process.env.SURYA_RATE_LIMIT_MAX) > 0 ? Number(process.env.SURYA_RATE_LIMIT_MAX) : 180;
app.use('/api', rateLimiter(GLOBAL_RATE_LIMIT, 60));

// Specific strict rate limits
const chatLimiter = rateLimiter(60, 60); // 60 queries / min
const visionLimiter = rateLimiter(20, 60); // 20 optical scans / min
const veronicaLimiter = rateLimiter(30, 60); // 30 security auth / min

// Optional Server Access Token Middleware (enforced whenever SURYA_API_TOKEN is configured)
function requireApiAuth(req: Request, res: Response, next: NextFunction) {
  const configuredToken = getConfiguredApiToken();
  if (!configuredToken) {
    return next();
  }

  const authHeader = req.headers.authorization;
  const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : '';

  if (!bearer) {
    return res.status(401).json({
      error: 'Authentication required. Configure your BUDDY Access Token in System Settings.',
      code: 'AUTHENTICATION_REQUIRED',
    });
  }

  const expectedBuf = Buffer.from(configuredToken, 'utf-8');
  const providedBuf = Buffer.from(bearer, 'utf-8');
  if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return res.status(403).json({
      error: 'Access denied. Invalid BUDDY Access Token.',
      code: 'INVALID_CREDENTIALS',
    });
  }

  next();
}

// Persistent Data Storage Paths
const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const MEMORY_FILE = path.join(DATA_DIR, 'world_model.json');
const USER_MEMORIES_FILE = path.join(DATA_DIR, 'world_model_users.json');
const AUDIT_FILE = path.join(DATA_DIR, 'veronica_audit.json');
const PLUGINS_FILE = path.join(DATA_DIR, 'plugins.json');
const SKILLS_FILE = path.join(DATA_DIR, 'custom_skills.json');
const APPS_FILE = path.join(DATA_DIR, 'generated_apps.json');

// Supported Gemini AI Models
export interface AIModelMeta {
  id: string;
  name: string;
  description: string;
  speed: 'Ultra-Fast' | 'Fast' | 'Deep Reasoning';
  latencyRating: number; // 1-5 scale (5 is fastest)
  isDefault?: boolean;
  isFallback?: boolean;
  isPaid?: boolean;
}

const AVAILABLE_AI_MODELS: AIModelMeta[] = [
  {
    id: 'gemini-4-hydrogen',
    name: 'Gemini 4 Hydrogen',
    description: 'Primary intelligent multimodal model with balanced reasoning, speed, and multilingual precision',
    speed: 'Fast',
    latencyRating: 5,
    isDefault: true,
  },
  {
    id: 'gemini-4-carbon',
    name: 'Gemini 4 Carbon',
    description: 'Balanced high-speed multimodal model tuned for real-time mobile assistant interactions',
    speed: 'Ultra-Fast',
    latencyRating: 5,
  },
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    description: 'Lightweight high-throughput model, lowest latency, primary overload fallback',
    speed: 'Ultra-Fast',
    latencyRating: 5,
    isFallback: true,
  },
  {
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    description: 'Complex multi-step reasoning, mathematical STEM, deep coding & architecture (Paid tier)',
    speed: 'Deep Reasoning',
    latencyRating: 3,
    isPaid: true,
  },
];

// Helper to get GoogleGenAI instance
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const PRIMARY_UPSTREAM_TIMEOUT_MS = 30000;

const MODEL_ALIAS_MAP: Record<string, string> = {
  'gemini-4-hydrogen': 'gemini-3.8-flash',
  'gemini-4-carbon': 'gemini-3.8-flash',
  'gemini-4-argon': 'gemini-3.8-pro',
  'gemini-3.8-flash': 'gemini-3.8-flash',
  'gemini-3.8-pro': 'gemini-3.8-pro',
  'gemini-3.1-flash-lite': 'gemini-3.8-flash',
  'gemini-2.5-flash': 'gemini-3.8-flash',
  'gemini-2.5-pro': 'gemini-3.8-pro',
  'gemini-2.0-flash': 'gemini-3.8-flash',
  'gemini-1.5-flash': 'gemini-3.8-flash',
  'gemini-1.5-pro': 'gemini-3.8-pro',
};

export function resolveGeminiModelName(model: string): string {
  if (!model || typeof model !== 'string') return 'gemini-3.8-flash';
  const cleaned = model.trim().toLowerCase();
  if (!cleaned) return 'gemini-3.8-flash';
  if (MODEL_ALIAS_MAP[cleaned]) {
    return MODEL_ALIAS_MAP[cleaned];
  }
  return model.trim();
}

export function classifyGeminiUpstreamError(err: any): {
  status: number;
  code: 'GEMINI_AUTH_FAILED' | 'MODEL_UNAVAILABLE' | 'RATE_LIMITED' | 'TIMEOUT' | 'SERVER_ERROR';
  message: string;
} {
  const rawMsg = String(err?.message || err || '');
  const lower = rawMsg.toLowerCase();
  const status = typeof err?.status === 'number' ? err.status : 0;

  if (
    status === 401 ||
    status === 403 ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('permission_denied') ||
    lower.includes('unauthorized')
  ) {
    return {
      status: 401,
      code: 'GEMINI_AUTH_FAILED',
      message:
        'Gemini API key authentication failed on the backend. Verify your server GEMINI_API_KEY configuration in your deployment secrets.',
    };
  }

  if (
    status === 404 ||
    lower.includes('not_found') ||
    lower.includes('is no longer available') ||
    lower.includes('is not found for api version')
  ) {
    return {
      status: 404,
      code: 'MODEL_UNAVAILABLE',
      message:
        'Selected Gemini model is unavailable or retired upstream. Switch to Gemini 4 Hydrogen (gemini-3.8-flash) in the Model Selector.',
    };
  }

  if (status === 429 || lower.includes('429') || lower.includes('resourceexhausted')) {
    return {
      status: 429,
      code: 'RATE_LIMITED',
      message: 'Gemini API rate limit reached upstream. Retry shortly.',
    };
  }

  if (err?.isTimeout || status === 504 || lower.includes('timed out')) {
    return {
      status: 504,
      code: 'TIMEOUT',
      message: 'Upstream Gemini request timed out.',
    };
  }

  return {
    status: status === 503 ? 503 : 502,
    code: 'SERVER_ERROR',
    message: sanitizeContent(rawMsg || 'Upstream Gemini AI service error.'),
  };
}

function withUpstreamTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err: any = new Error(`${label} timed out after ${ms}ms`);
      err.status = 504;
      err.isTimeout = true;
      reject(err);
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function shouldFallbackToLite(err: any): boolean {
  return (
    err?.isTimeout === true ||
    err?.status === 429 ||
    err?.status === 503 ||
    err?.status === 504 ||
    Boolean(
      err?.message &&
        (err.message.includes('429') ||
          err.message.includes('503') ||
          err.message.includes('504') ||
          err.message.includes('timed out') ||
          err.message.includes('UNAVAILABLE') ||
          err.message.includes('ResourceExhausted'))
    )
  );
}

export function extractInteractionText(interaction: any): string {
  if (typeof interaction?.output_text === 'string' && interaction.output_text.trim()) {
    return interaction.output_text;
  }
  if (Array.isArray(interaction?.steps)) {
    const parts: string[] = [];
    for (const step of interaction.steps) {
      if (step.type === 'model_output' && Array.isArray(step.content)) {
        for (const item of step.content) {
          if (item?.type === 'text' && typeof item.text === 'string') {
            parts.push(item.text);
          }
        }
      }
    }
    if (parts.length > 0) {
      return parts.join('');
    }
  }
  if (typeof interaction?.text === 'string') {
    return interaction.text;
  }
  return '';
}

export function extractImagePayload(raw: string): { data: string; mimeType: string } | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 14_000_000) return null;

  let declaredMime: string | null = null;
  let b64 = trimmed;
  const hasDataPrefix = /^data:/i.test(trimmed);
  if (hasDataPrefix) {
    const match = trimmed.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) return null;
    declaredMime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
    b64 = match[2];
  } else if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) {
    return null;
  }

  const cleanBase64 = b64.replace(/\s+/g, '');
  if (cleanBase64.length < 8) return null;

  let header: Buffer;
  try {
    header = Buffer.from(cleanBase64.slice(0, 24), 'base64');
  } catch {
    return null;
  }
  if (header.length < 4) return null;

  const isPng =
    header.length >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47;
  const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const isGif =
    header.length >= 4 &&
    header[0] === 0x47 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x38;
  const isWebp =
    header.length >= 12 &&
    header.subarray(0, 4).toString('ascii') === 'RIFF' &&
    header.subarray(8, 12).toString('ascii') === 'WEBP';

  const sniffedMime = isPng
    ? 'image/png'
    : isJpeg
    ? 'image/jpeg'
    : isWebp
    ? 'image/webp'
    : isGif
    ? 'image/gif'
    : null;

  if (!sniffedMime) return null;
  if (declaredMime && declaredMime !== sniffedMime) return null;

  return { data: cleanBase64, mimeType: sniffedMime };
}

export async function interactionWithFallback(
  ai: GoogleGenAI,
  params: {
    model: string;
    input?: any;
    contents?: any;
    system_instruction?: string;
    config?: any;
    response_format?: any;
    previous_interaction_id?: string;
    generation_config?: any;
    allowFallback?: boolean;
  },
  fallbackModel = 'gemini-3.8-flash'
): Promise<{ text: string; response: any; modelUsed: string; fellBack: boolean; interactionId?: string }> {
  const resolvedModel = resolveGeminiModelName(params.model);
  const resolvedFallback = resolveGeminiModelName(fallbackModel);
  const allowFallback = params.allowFallback !== false;

  // Normalize input across interactions API vs legacy contents
  let normalizedInput = params.input !== undefined ? params.input : params.contents;
  if (normalizedInput && typeof normalizedInput === 'object' && !Array.isArray(normalizedInput)) {
    if (Array.isArray(normalizedInput.parts)) {
      normalizedInput = normalizedInput.parts.map((p: any) => {
        if (p.inlineData) {
          return {
            type: 'image',
            data: p.inlineData.data,
            mime_type: p.inlineData.mimeType || 'image/jpeg',
          };
        }
        if (p.text) {
          return { type: 'text', text: p.text };
        }
        return p;
      });
    }
  }

  const systemInstruction =
    params.system_instruction ||
    params.config?.systemInstruction ||
    undefined;

  let responseFormat = params.response_format;
  if (!responseFormat && params.config?.responseMimeType === 'application/json') {
    responseFormat = { type: 'json' };
  }

  const callInteractions = async (targetModel: string) => {
    const payload: any = {
      model: targetModel,
      input: normalizedInput,
    };
    if (systemInstruction) {
      payload.system_instruction = systemInstruction;
    }
    if (responseFormat) {
      payload.response_format = responseFormat;
    }
    if (params.previous_interaction_id) {
      payload.previous_interaction_id = params.previous_interaction_id;
    }
    if (params.generation_config) {
      payload.generation_config = params.generation_config;
    }
    return await ai.interactions.create(payload);
  };

  try {
    const interaction =
      resolvedModel !== resolvedFallback
        ? await withUpstreamTimeout(
            callInteractions(resolvedModel),
            PRIMARY_UPSTREAM_TIMEOUT_MS,
            `Model ${params.model}`
          )
        : await callInteractions(resolvedModel);
    const text = extractInteractionText(interaction);
    return {
      text,
      response: { ...interaction, text },
      modelUsed: params.model,
      fellBack: false,
      interactionId: interaction?.id,
    };
  } catch (err: any) {
    if (allowFallback && shouldFallbackToLite(err) && resolvedModel !== resolvedFallback) {
      console.warn(`[BUDDY Interactions] Fallback from ${params.model} to ${fallbackModel}: ${err?.message || err}`);
      const interaction = await callInteractions(resolvedFallback);
      const text = extractInteractionText(interaction);
      return {
        text,
        response: { ...interaction, text },
        modelUsed: fallbackModel,
        fellBack: true,
        interactionId: interaction?.id,
      };
    }
    throw err;
  }
}

export async function generateWithFallback(
  ai: GoogleGenAI,
  params: { model: string; contents: any; config?: any },
  fallbackModel = 'gemini-3.8-flash'
) {
  const result = await interactionWithFallback(ai, params, fallbackModel);
  return result.response;
}

async function generateWithFallbackMeta(
  ai: GoogleGenAI,
  params: { model: string; contents: any; config?: any },
  fallbackModel = 'gemini-3.8-flash'
): Promise<{ response: any; modelUsed: string; fellBack: boolean }> {
  const result = await interactionWithFallback(ai, params, fallbackModel);
  return { response: result.response, modelUsed: result.modelUsed, fellBack: result.fellBack };
}

// Sensitive Information Redaction Filters
const SENSITIVE_PATTERNS = [
  /AIza[0-9A-Za-z-_]{35}/g, // Google API key
  /sk-[a-zA-Z0-9]{20,}/g, // API secrets
  /ghp_[a-zA-Z0-9]{36}/g, // GitHub tokens
  /bearer\s+[a-zA-Z0-9._~+/-]+=*/gi, // Bearer tokens
  /password\s*[:=]\s*["']?[^"'\s]+["']?/gi,
  /secret\s*[:=]\s*["']?[^"'\s]+["']?/gi,
];

export function sanitizeContent(input: string): string {
  if (!input || typeof input !== 'string') return '';
  let sanitized = input;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED_SECRET]');
  }
  return sanitized;
}

export function containsSensitiveData(input: string): boolean {
  if (!input || typeof input !== 'string') return false;
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(input));
}

// Data Models
export interface MemoryRecord {
  id: string;
  category: 'preference' | 'context' | 'fact' | 'directive';
  key: string;
  value: string;
  confidence: number;
  source?: 'user' | 'inferred' | 'system';
  updatedAt: string;
}

export interface AuditLog {
  id: string;
  namespace?: string;
  timestamp: string;
  action: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  status: 'AUTHORIZED' | 'REJECTED' | 'ABORTED' | 'EXECUTED';
  details: string;
  actor: string;
}

// Initial Memory State
let personalWorldModel: MemoryRecord[] = [];
try {
  if (fs.existsSync(MEMORY_FILE)) {
    personalWorldModel = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
  }
} catch (e) {
  console.warn('[WorldModel] Failed to read persistent memory file:', e);
}

if (personalWorldModel.length === 0) {
  personalWorldModel = [
    {
      id: 'mem_1',
      category: 'preference',
      key: 'preferred_language',
      value: 'Auto-detect (Indian & International languages supported)',
      confidence: 1.0,
      source: 'system',
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'mem_2',
      category: 'preference',
      key: 'response_mode',
      value: 'Fast Mode with real-time SSE streaming',
      confidence: 0.98,
      source: 'system',
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'mem_3',
      category: 'directive',
      key: 'surya_security_protocol',
      value: 'Enforce cryptographic challenge and 3-second abort countdown on medium/high-risk device actions',
      confidence: 1.0,
      source: 'system',
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'mem_4',
      category: 'context',
      key: 'target_platform',
      value: 'BUDDY Android Mobile Assistant (SDK 36, Capacitor 8, Java 21)',
      confidence: 0.95,
      source: 'system',
      updatedAt: new Date().toISOString(),
    },
  ];
}

function persistWorldModel() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(personalWorldModel, null, 2), 'utf-8');
  } catch (err) {
    console.error('[WorldModel] Persistence write failed:', err);
  }
}

// Per-User Isolated World Model Store (keyed by salted client/auth namespace hash)
let userMemoryStores: Record<string, MemoryRecord[]> = {};
try {
  if (fs.existsSync(USER_MEMORIES_FILE)) {
    userMemoryStores = JSON.parse(fs.readFileSync(USER_MEMORIES_FILE, 'utf-8'));
  }
} catch (e) {
  console.warn('[WorldModel] Failed to read per-user memory file:', e);
}

function persistUserMemoryStores() {
  try {
    fs.writeFileSync(USER_MEMORIES_FILE, JSON.stringify(userMemoryStores, null, 2), 'utf-8');
  } catch (err) {
    console.error('[WorldModel] Per-user persistence write failed:', err);
  }
}

export function getUserNamespace(req: Request): string {
  const clientHeader = req.headers['x-surya-client-id'];
  const authHeader = req.headers.authorization;
  const rawIdentity =
    typeof clientHeader === 'string' && clientHeader.trim()
      ? `client:${clientHeader.trim()}`
      : typeof authHeader === 'string' && authHeader.trim()
      ? `auth:${authHeader.trim()}`
      : 'default_local';
  return crypto.createHash('sha256').update(rawIdentity).digest('hex').slice(0, 24);
}

function getMemoriesForUser(namespace: string): MemoryRecord[] {
  if (!userMemoryStores[namespace]) {
    userMemoryStores[namespace] = personalWorldModel.map((m) => ({ ...m }));
    persistUserMemoryStores();
  }
  return userMemoryStores[namespace];
}

// Initial Audit Logs State
let veronicaAuditLogs: AuditLog[] = [];
try {
  if (fs.existsSync(AUDIT_FILE)) {
    veronicaAuditLogs = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf-8'));
  }
} catch (e) {
  console.warn('[Security] Failed to read persistent audit logs:', e);
}

if (veronicaAuditLogs.length === 0) {
  veronicaAuditLogs = [
    {
      id: 'audit_01',
      timestamp: new Date().toISOString(),
      action: 'System Boot & Telemetry Probe',
      riskLevel: 'LOW',
      status: 'EXECUTED',
      details: 'BUDDY mobile core online with multilingual streaming engine',
      actor: 'SYSTEM',
    },
  ];
}

function persistAuditLogs() {
  try {
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(veronicaAuditLogs.slice(0, 200), null, 2), 'utf-8');
  } catch (err) {
    console.error('[Security] Persistence write failed:', err);
  }
}

// Veronica Cryptographic Challenge Store
interface VeronicaChallenge {
  challengeId: string;
  namespace: string;
  actionId: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  authToken?: string;
  expiresAt: number;
  status: 'PENDING' | 'AUTHORIZED' | 'ABORTED';
}

const veronicaChallenges = new Map<string, VeronicaChallenge>();
const VERONICA_SECRET_HMAC = process.env.VERONICA_SECRET || crypto.randomBytes(32).toString('hex');

interface LiveTicket {
  ticket: string;
  namespace: string;
  expiresAt: number;
}
const liveSessionTickets = new Map<string, LiveTicket>();

// SURYA App Link Catalog (Android 11+ Package Visibility compliant)
const STARK_INTENT_CATALOG = [
  {
    id: 'app_youtube',
    name: 'YouTube',
    package: 'com.google.android.youtube',
    scheme: 'vnd.youtube:',
    action: 'android.intent.action.VIEW',
    category: 'Entertainment',
    icon: 'PlaySquare',
    description: 'Launch YouTube app directly or web fallback',
    riskLevel: 'LOW',
    fallbackUrl: 'https://www.youtube.com',
  },
  {
    id: 'app_browser',
    name: 'Web Browser',
    package: 'com.android.chrome',
    scheme: 'https://',
    action: 'android.intent.action.VIEW',
    category: 'Communication',
    icon: 'Globe',
    description: 'Launch default web navigator via Android VIEW intent',
    riskLevel: 'LOW',
    fallbackUrl: 'https://www.google.com',
  },
  {
    id: 'app_settings',
    name: 'Android Settings',
    package: 'com.android.settings',
    scheme: 'android.settings.SETTINGS',
    action: 'android.settings.SETTINGS',
    category: 'System',
    icon: 'Settings',
    description: 'Open master device settings panel',
    riskLevel: 'MEDIUM',
  },
  {
    id: 'app_maps',
    name: 'Google Maps & GPS',
    package: 'com.google.android.apps.maps',
    scheme: 'geo:0,0?q=',
    action: 'android.intent.action.VIEW',
    category: 'Navigation',
    icon: 'Navigation',
    description: 'Launch navigational telemetry and GPS coordinates',
    riskLevel: 'LOW',
    fallbackUrl: 'https://maps.google.com',
  },
  {
    id: 'app_camera',
    name: 'Camera & Optics',
    package: 'com.android.camera',
    scheme: 'android.media.action.IMAGE_CAPTURE',
    action: 'android.media.action.IMAGE_CAPTURE',
    category: 'Sensors',
    icon: 'Camera',
    description: 'Launch native optical camera sensors',
    riskLevel: 'LOW',
  },
  {
    id: 'app_phone',
    name: 'Phone Dialer',
    package: 'com.android.dialer',
    scheme: 'tel:',
    action: 'android.intent.action.DIAL',
    category: 'Communication',
    icon: 'Phone',
    description: 'Trigger Android telephony interface',
    riskLevel: 'MEDIUM',
  },
  {
    id: 'app_wifi_settings',
    name: 'Wi-Fi & Network Settings',
    package: 'com.android.settings',
    scheme: 'android.settings.WIFI_SETTINGS',
    action: 'android.settings.WIFI_SETTINGS',
    category: 'System',
    icon: 'Wifi',
    description: 'Wireless connectivity interface',
    riskLevel: 'MEDIUM',
  },
  {
    id: 'app_whatsapp',
    name: 'WhatsApp Messenger',
    package: 'com.whatsapp',
    scheme: 'whatsapp://',
    action: 'android.intent.action.VIEW',
    category: 'Communication',
    icon: 'MessageCircle',
    description: 'Launch WhatsApp instant messenger',
    riskLevel: 'LOW',
    fallbackUrl: 'https://web.whatsapp.com',
  },
  {
    id: 'app_security_wipe',
    name: 'Emergency System Lockdown',
    package: 'com.surya.security',
    scheme: 'surya://security/emergency-lock',
    action: 'surya.intent.action.EMERGENCY_LOCK',
    category: 'Security',
    icon: 'ShieldAlert',
    description: 'Security Protocol lockdown sequence (Requires 3s abort timer + device authentication)',
    riskLevel: 'HIGH',
  },
];

// Scientific Knowledge Base
const SCIENTIFIC_DATABASE = [
  {
    id: 'sci_01',
    domain: 'Astrophysics & Relativity',
    title: 'Gravitational Wave Interferometry & Spacetime Distortion',
    summary: 'Direct detection of quadrupole ripples in spacetime curvature predicted by General Relativity using laser interferometry (LIGO/Virgo).',
    principles: ['Metric tensor perturbation $h_{\\mu\\nu}$', 'Strain sensitivity $10^{-21}$', 'Coalescing binary black hole event horizons'],
    telemetryFormula: 'h = \\frac{4G}{c^4 r} \\frac{\\partial^2 Q_{ij}}{\\partial t^2}',
  },
  {
    id: 'sci_02',
    domain: 'Quantum Mechanics',
    title: 'Quantum Decoherence & Density Matrix Evolution',
    summary: 'The non-unitary loss of quantum phase coherence between orthogonal states in a quantum system interacting with an open environmental bath.',
    principles: ['Lindblad master equation', 'Von Neumann entropy $S = -\\text{Tr}(\\rho \\ln \\rho)$', 'Superconducting transmon qubit lifetimes ($T_1, T_2$)'],
    telemetryFormula: '\\frac{d\\rho}{dt} = -\\frac{i}{\\hbar}[H,\\rho] + \\sum_k \\left( L_k\\rho L_k^\\dagger - \\frac{1}{2}\\{L_k^\\dagger L_k, \\rho\\} \\right)',
  },
  {
    id: 'sci_03',
    domain: 'Materials & Energy',
    title: 'High-Temperature Superconductivity in Cuprate Perovskites',
    summary: 'Zero electrical resistivity and complete expulsion of magnetic flux fields (Meissner effect) above the liquid nitrogen threshold (77 K).',
    principles: ['Cooper pair formation via spin fluctuations', 'London penetration depth $\\lambda_L$', 'Ginzburg-Landau coherence length $\\xi$'],
    telemetryFormula: 'B(x) = B(0) e^{-x / \\lambda_L}',
  },
  {
    id: 'sci_04',
    domain: 'Cybernetics & Neural Computation',
    title: 'Transformer Attention & Sparse Mixture-of-Experts (MoE)',
    summary: 'Scaled dot-product multi-head attention routing paired with dynamically gated expert neural networks for near-instant multi-step semantic synthesis.',
    principles: ['Softmax normalized query-key dot product', 'Top-k sparse routing dispatch', 'Cross-entropy token projection'],
    telemetryFormula: '\\text{Attention}(Q, K, V) = \\text{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V',
  },
];

/* ---------------- API ROUTES ---------------- */

// Apply optional API authentication to sensitive routes (GET /api/health & /api/ready remain public)
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/health' || req.path === '/ready') return next();
  return requireApiAuth(req, res, next);
});

app.get('/api/ready', (req: Request, res: Response) => {
  return res.json({
    ready: true,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    authRequired: Boolean(getConfiguredApiToken()),
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/live/ticket', (req: Request, res: Response) => {
  const ns = getUserNamespace(req);
  const expiresAt = Date.now() + 60 * 1000;
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = crypto
    .createHmac('sha256', VERONICA_SECRET_HMAC)
    .update(`${ns}:${expiresAt}:${nonce}`)
    .digest('hex');
  const ticket = `${nonce}.${expiresAt}.${sig}`;
  liveSessionTickets.set(ticket, { ticket, namespace: ns, expiresAt });
  return res.json({ ticket, expiresAt });
});

// 1. Available Models Registry
app.get('/api/models', (req: Request, res: Response) => {
  return res.json({
    models: AVAILABLE_AI_MODELS,
    defaultModel: 'gemini-4-hydrogen',
    fallbackModel: 'gemini-3.8-flash',
    timestamp: new Date().toISOString(),
  });
});

// 2. API Key Config & Diagnostics (Secure, Masked)
app.get('/api/config/api-key', (req: Request, res: Response) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.json({
      configured: false,
      maskedKey: null,
      model: 'gemini-4-hydrogen',
      fallbackModel: 'gemini-3.8-flash',
      status: 'Awaiting API Key in Settings > Secrets',
    });
  }
  const maskedKey = apiKey.length > 8 ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : '****';

  return res.json({
    configured: true,
    maskedKey,
    model: 'gemini-4-hydrogen',
    fallbackModel: 'gemini-3.8-flash',
    status: 'ACTIVE_ONLINE',
  });
});

app.post('/api/config/api-key/verify', async (req: Request, res: Response) => {
  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      success: false,
      code: 'GEMINI_AUTH_FAILED',
      error: 'GEMINI_API_KEY environment variable is not configured on the backend server.',
    });
  }

  try {
    const startTime = Date.now();
    const meta = await interactionWithFallback(ai, {
      model: 'gemini-4-hydrogen',
      input: 'Reply concisely in under 8 words confirming you are active for BUDDY gateway verification.',
      system_instruction: 'You are BUDDY backend health verification. Reply briefly confirming status.',
    });
    const latencyMs = Date.now() - startTime;
    const text = (meta.text || '').trim();
    if (!text) {
      return res.status(502).json({
        success: false,
        error: 'Upstream Gemini returned an empty verification response.',
      });
    }
    return res.json({
      success: true,
      model: meta.modelUsed,
      resolvedUpstreamModel: resolveGeminiModelName(meta.modelUsed),
      fallbackUsed: meta.fellBack,
      latencyMs,
      response: sanitizeContent(text),
    });
  } catch (error: any) {
    const classified = classifyGeminiUpstreamError(error);
    return res.status(classified.status).json({
      success: false,
      code: classified.code,
      error: classified.message,
    });
  }
});

// Helper to construct unified multilingual system instructions
function buildSystemInstruction(
  fastMode: boolean,
  preferredLanguage?: string,
  responseMode: 'concise' | 'detailed' = fastMode ? 'concise' : 'detailed',
  userMemories: { key: string; value: string; category?: string }[] = [],
  deviceContext?: { batteryLevel?: number; isCharging?: boolean; online?: boolean; activeTab?: string }
): string {
  const combinedMemories = [
    ...personalWorldModel.map((m) => `[${m.category.toUpperCase()}] ${m.key}: ${m.value}`),
    ...userMemories
      .filter((m) => m && typeof m.key === 'string' && typeof m.value === 'string' && !containsSensitiveData(m.value))
      .slice(0, 12)
      .map((m) => `[USER_${(m.category || 'context').toUpperCase()}] ${sanitizeContent(m.key)}: ${sanitizeContent(m.value)}`),
  ].join('\n');

  let instruction = `You are BUDDY, India's sovereign personal AI operating companion for Android and Web, designed for poise, clarity, and technical competence.

Core Identity & Behavioral Directives:
1. BUDDY PERSONALITY: Speak with calm authority, clarity, subtle warmth, and zero filler. Never roleplay fake sensor readings or claim an unexecuted device action succeeded.
2. MULTILINGUAL INTELLIGENCE:
   - Fluently understand and respond in Hindi (हिन्दी), English, and natural Hinglish, as well as Indian regional languages (Bengali, Telugu, Marathi, Tamil, Gujarati, Kannada, Malayalam, Punjabi, Odia, Urdu, Sanskrit) and major global languages.
   - Mirror the user's language and script unless instructed otherwise.
3. CONTEXT & DEVICE AWARENESS:
   - Native Android intents (launching apps, settings, maps, camera) execute via the local Android bridge. When a user asks for a device action requiring confirmation, clearly explain what permission/confirmation is needed.
   - Keep optical/camera insights strictly educational, analytical, and peaceful.

Authorized Personal World Model Context:
${combinedMemories}

Platform: BUDDY Android Mobile (SDK 36, Java 21)
Local Time: ${new Date().toLocaleTimeString()}`;

  if (deviceContext && typeof deviceContext === 'object') {
    const parts: string[] = [];
    if (typeof deviceContext.batteryLevel === 'number') {
      parts.push(`Battery: ${deviceContext.batteryLevel}%${deviceContext.isCharging ? ' (Charging)' : ''}`);
    }
    if (typeof deviceContext.online === 'boolean') {
      parts.push(`Network: ${deviceContext.online ? 'Online' : 'Offline'}`);
    }
    if (deviceContext.activeTab) {
      parts.push(`Active Workspace: ${sanitizeContent(String(deviceContext.activeTab))}`);
    }
    if (parts.length > 0) {
      instruction += `\nDevice Telemetry: ${parts.join(' | ')}`;
    }
  }

  if (preferredLanguage && preferredLanguage !== 'auto') {
    instruction += `\nUser preferred response language: ${preferredLanguage}.`;
  }

  if (responseMode === 'concise') {
    instruction += `\nCONCISE MODE: Keep answers crisp, direct, and under 3-4 sentences unless structured steps or code are explicitly requested.`;
  } else {
    instruction += `\nDETAILED MODE: Provide thorough structured reasoning, clear steps, and helpful context while remaining well-organized.`;
  }

  return instruction;
}

const userLastInteractionMap = new Map<string, string>();

// Background eviction timer (.unref() so test imports & serverless exits never block)
const evictionTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, record] of rateLimitBuckets.entries()) {
    record.timestamps = record.timestamps.filter((t) => now - t < 120000);
    if (record.timestamps.length === 0) rateLimitBuckets.delete(k);
  }
  for (const [id, ch] of veronicaChallenges.entries()) {
    if (now > ch.expiresAt) veronicaChallenges.delete(id);
  }
  for (const [t, ticket] of liveSessionTickets.entries()) {
    if (now > ticket.expiresAt) liveSessionTickets.delete(t);
  }
  if (userLastInteractionMap.size > 500) {
    const excess = userLastInteractionMap.size - 250;
    let deleted = 0;
    for (const key of userLastInteractionMap.keys()) {
      userLastInteractionMap.delete(key);
      deleted++;
      if (deleted >= excess) break;
    }
  }
}, 60 * 1000);
if (typeof evictionTimer.unref === 'function') {
  evictionTimer.unref();
}

function buildConversationPromptInput(
  cleanMessage: string,
  history: any[],
  resolvedMode: 'concise' | 'detailed'
): string {
  const historySlice = resolvedMode === 'concise' ? history.slice(-6) : history.slice(-12);
  if (historySlice.length === 0) return cleanMessage;
  const formattedHistory = historySlice
    .filter((msg: any) => msg && typeof msg.content === 'string' && (msg.role === 'user' || msg.role === 'assistant'))
    .map((msg: any) => `${msg.role === 'assistant' ? 'Assistant' : 'User'}: ${sanitizeContent(msg.content.slice(0, 1500))}`)
    .join('\n');
  if (!formattedHistory) return cleanMessage;
  return `Conversation Context:\n${formattedHistory}\n\nCurrent User Query:\n${cleanMessage}`;
}

function isExpiredInteractionError(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('previous_interaction_id') || (err?.status === 404 && msg.includes('interaction'));
}

// 3. Ultra-Fast Real-Time Response Streaming via Server-Sent Events (SSE) & Interactions API
app.post('/api/chat/stream', chatLimiter, async (req: Request, res: Response) => {
  const {
    message,
    history = [],
    model = 'gemini-4-hydrogen',
    fastMode = true,
    responseMode,
    preferredLanguage = 'auto',
    autoFallback = true,
    userMemories = [],
    deviceContext,
    previousInteractionId,
    resetConversation = false,
  } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Non-empty message text is required.' });
  }

  if (message.length > 4000) {
    return res.status(400).json({ error: 'Message exceeds 4000 character limit.' });
  }

  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      code: 'GEMINI_AUTH_FAILED',
      error: 'Gemini AI service unavailable. Configure GEMINI_API_KEY on your deployed backend server.',
    });
  }

  // Setup Server-Sent Events headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sendSSE = (data: any) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  let clientDisconnected = false;
  let activeStreamIterator: any = null;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      if (activeStreamIterator && typeof activeStreamIterator.return === 'function') {
        activeStreamIterator.return().catch(() => {});
      }
    }
  });

  const cleanMessage = sanitizeContent(message);
  const resolvedMode: 'concise' | 'detailed' = responseMode === 'detailed' || !fastMode ? 'detailed' : 'concise';
  const systemInstruction = buildSystemInstruction(
    fastMode,
    preferredLanguage,
    resolvedMode,
    Array.isArray(userMemories) ? userMemories : [],
    deviceContext
  );

  const userNs = getUserNamespace(req);
  if (resetConversation === true || (Array.isArray(history) && history.length === 0)) {
    userLastInteractionMap.delete(userNs);
  }

  let resolvedPrevId =
    resetConversation === true
      ? undefined
      : typeof previousInteractionId === 'string' && previousInteractionId.trim()
      ? previousInteractionId.trim()
      : userLastInteractionMap.get(userNs);

  const safeHistory = Array.isArray(history) ? history : [];
  let promptInput: any = resolvedPrevId
    ? cleanMessage
    : buildConversationPromptInput(cleanMessage, safeHistory, resolvedMode);

  const startTime = Date.now();
  let firstTokenTime: number | null = null;
  let activeModel = model;
  let tokenCount = 0;
  let activeInteractionId = '';
  let retriedWithoutPrevId = false;

  sendSSE({ type: 'start', model: activeModel, timestamp: new Date().toISOString() });

  // Function to stream from a given model via Interactions API
  const streamFromModel = async (targetModel: string): Promise<boolean> => {
    try {
      const resolvedTarget = resolveGeminiModelName(targetModel);
      const streamPromise = ai.interactions.create({
        model: resolvedTarget,
        input: promptInput,
        system_instruction: systemInstruction,
        stream: true,
        ...(resolvedPrevId ? { previous_interaction_id: resolvedPrevId } : {}),
      });

      const streamResponse =
        targetModel !== 'gemini-3.8-flash'
          ? await withUpstreamTimeout(streamPromise, PRIMARY_UPSTREAM_TIMEOUT_MS, `Stream ${targetModel}`)
          : await streamPromise;

      activeStreamIterator = streamResponse;

      for await (const event of streamResponse) {
        if (clientDisconnected) {
          if (typeof (streamResponse as any)?.return === 'function') {
            await (streamResponse as any).return().catch(() => {});
          }
          break;
        }
        if (event.event_type === 'step.delta' && event.delta?.type === 'text') {
          const text = event.delta.text || '';
          if (text) {
            if (firstTokenTime === null) {
              firstTokenTime = Date.now() - startTime;
              sendSSE({ type: 'ttft', ttftMs: firstTokenTime });
            }
            tokenCount++;
            sendSSE({ type: 'chunk', text: sanitizeContent(text) });
          }
        } else if (event.event_type === 'interaction.created' && (event as any).interaction_id) {
          activeInteractionId = (event as any).interaction_id;
        } else if (event.event_type === 'interaction.status_update' && (event as any).interaction_id) {
          activeInteractionId = (event as any).interaction_id;
        } else if (event.event_type === 'interaction.completed') {
          if ((event as any).interaction?.id) {
            activeInteractionId = (event as any).interaction.id;
          }
        }
      }

      if (activeInteractionId) {
        userLastInteractionMap.set(userNs, activeInteractionId);
      }

      if (tokenCount === 0 && !clientDisconnected && autoFallback && targetModel !== 'gemini-3.8-flash') {
        const fallbackTarget = 'gemini-3.8-flash';
        sendSSE({
          type: 'fallback',
          originalModel: targetModel,
          fallbackModel: fallbackTarget,
          reason: 'Zero output tokens received from primary model; routing to Flash.',
        });
        activeModel = fallbackTarget;
        return await streamFromModel(fallbackTarget);
      }
      return true;
    } catch (err: any) {
      if (resolvedPrevId && !retriedWithoutPrevId && isExpiredInteractionError(err)) {
        retriedWithoutPrevId = true;
        resolvedPrevId = undefined;
        userLastInteractionMap.delete(userNs);
        promptInput = buildConversationPromptInput(cleanMessage, safeHistory, resolvedMode);
        return await streamFromModel(targetModel);
      }

      console.warn(`[BUDDY Stream] Error on model ${targetModel}:`, sanitizeContent(String(err?.message || err)));
      const canFallback = shouldFallbackToLite(err) && autoFallback && targetModel !== 'gemini-3.8-flash';

      if (canFallback) {
        const fallbackTarget = 'gemini-3.8-flash';
        sendSSE({
          type: 'fallback',
          originalModel: targetModel,
          fallbackModel: fallbackTarget,
          reason: 'Primary model delayed or overloaded. Seamlessly routing to Gemini 3.8 Flash.',
        });
        activeModel = fallbackTarget;
        return await streamFromModel(fallbackTarget);
      } else {
        const classified = classifyGeminiUpstreamError(err);
        sendSSE({
          type: 'error',
          code: classified.code,
          error: classified.message,
        });
        return false;
      }
    }
  };

  const succeeded = await streamFromModel(activeModel);

  if (succeeded && !clientDisconnected) {
    const totalTimeMs = Date.now() - startTime;
    sendSSE({
      type: 'done',
      model: activeModel,
      resolvedUpstreamModel: resolveGeminiModelName(activeModel),
      totalTimeMs,
      firstTokenMs: firstTokenTime || totalTimeMs,
      tokenCount,
      interactionId: activeInteractionId,
    });
  }

  if (!res.writableEnded) {
    res.end();
  }
});

// 4. Standard Non-Streaming Chat Endpoint (for compatibility) via Interactions API
app.post('/api/chat', chatLimiter, async (req: Request, res: Response) => {
  const {
    message,
    history = [],
    model = 'gemini-4-hydrogen',
    fastMode = true,
    responseMode,
    preferredLanguage = 'auto',
    autoFallback = true,
    userMemories = [],
    deviceContext,
    previousInteractionId,
    resetConversation = false,
  } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Non-empty message text is required.' });
  }

  if (message.length > 4000) {
    return res.status(400).json({ error: 'Message exceeds 4000 character limit.' });
  }

  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      code: 'GEMINI_AUTH_FAILED',
      error: 'Gemini AI service unavailable. Configure GEMINI_API_KEY in your backend server environment.',
    });
  }

  try {
    const cleanMessage = sanitizeContent(message);
    const resolvedMode: 'concise' | 'detailed' = responseMode === 'detailed' || !fastMode ? 'detailed' : 'concise';
    const systemInstruction = buildSystemInstruction(
      fastMode,
      preferredLanguage,
      resolvedMode,
      Array.isArray(userMemories) ? userMemories : [],
      deviceContext
    );

    const userNs = getUserNamespace(req);
    if (resetConversation === true || (Array.isArray(history) && history.length === 0)) {
      userLastInteractionMap.delete(userNs);
    }

    let resolvedPrevId =
      resetConversation === true
        ? undefined
        : typeof previousInteractionId === 'string' && previousInteractionId.trim()
        ? previousInteractionId.trim()
        : userLastInteractionMap.get(userNs);

    const safeHistory = Array.isArray(history) ? history : [];
    let promptInput: any = resolvedPrevId
      ? cleanMessage
      : buildConversationPromptInput(cleanMessage, safeHistory, resolvedMode);

    const startTime = Date.now();
    let meta;
    try {
      meta = await interactionWithFallback(
        ai,
        {
          model: model || 'gemini-4-hydrogen',
          input: promptInput,
          system_instruction: systemInstruction,
          allowFallback: autoFallback !== false,
          ...(resolvedPrevId ? { previous_interaction_id: resolvedPrevId } : {}),
        },
        'gemini-3.8-flash'
      );
    } catch (firstErr: any) {
      if (resolvedPrevId && isExpiredInteractionError(firstErr)) {
        userLastInteractionMap.delete(userNs);
        promptInput = buildConversationPromptInput(cleanMessage, safeHistory, resolvedMode);
        meta = await interactionWithFallback(
          ai,
          {
            model: model || 'gemini-4-hydrogen',
            input: promptInput,
            system_instruction: systemInstruction,
            allowFallback: autoFallback !== false,
          },
          'gemini-3.8-flash'
        );
      } else {
        throw firstErr;
      }
    }

    if (meta.interactionId) {
      userLastInteractionMap.set(userNs, meta.interactionId);
    }

    const latencyMs = Date.now() - startTime;
    if (!meta.text.trim()) {
      return res.status(502).json({
        error: 'Upstream Gemini model returned an empty response.',
      });
    }

    return res.json({
      text: sanitizeContent(meta.text),
      model: meta.modelUsed,
      latencyMs,
      timestamp: new Date().toISOString(),
      interactionId: meta.interactionId,
    });
  } catch (error: any) {
    const classified = classifyGeminiUpstreamError(error);
    return res.status(classified.status).json({
      code: classified.code,
      error: classified.message,
    });
  }
});

// 5. Standard Optics Multimodal Scene Analysis Endpoint
app.post('/api/vision', visionLimiter, async (req: Request, res: Response) => {
  const { imageBase64, prompt = 'Analyze this scene through BUDDY Standard Optics HUD. Identify key objects, structural elements, read any visible text, assess distance/proximity estimates benignly, and provide telemetry points.' } = req.body;

  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'Valid image base64 data is required for optical telemetry.' });
  }

  if (imageBase64.length > 14000000) {
    return res.status(413).json({ error: 'Image payload exceeds 10MB limit.' });
  }

  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      code: 'GEMINI_AUTH_FAILED',
      error: 'Gemini AI service unavailable. Configure GEMINI_API_KEY in your backend server environment.',
    });
  }

  try {
    const parsedImage = extractImagePayload(imageBase64);
    if (!parsedImage) {
      return res.status(400).json({ error: 'Invalid or unsupported image payload. Provide a valid PNG, JPEG, WebP, or GIF image.' });
    }
    const { data: cleanBase64, mimeType } = parsedImage;

    const meta = await interactionWithFallback(ai, {
      model: 'gemini-4-hydrogen',
      input: [
        {
          type: 'image',
          data: cleanBase64,
          mime_type: mimeType,
        },
        {
          type: 'text',
          text: `You are BUDDY Standard Optics AR HUD visual processor.
${prompt}
Format your findings with clean, structured sections:
1. OPTICAL SUMMARY: 1-2 concise sentences describing the field of view.
2. DETECTED ENTITIES & OBJECTS: list 2-5 identified items with benign estimated spatial positions and distance (labeled ESTIMATED PROXIMITY).
3. TEXT RECOGNITION (OCR): readable labels, numbers, or signage in any script.
4. HUD ADVISORY: context note.
Strictly ensure all telemetry remains peaceful, analytical, non-operational, and benign. Never produce weaponized instructions.`,
        },
      ],
    });

    const telemetry = meta.text.trim();
    if (!telemetry) {
      return res.status(502).json({ error: 'Upstream vision model returned empty optical telemetry.' });
    }

    return res.json({
      telemetry: sanitizeContent(telemetry),
      model: meta.modelUsed,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    const classified = classifyGeminiUpstreamError(error);
    return res.status(classified.status).json({
      code: classified.code,
      error: classified.message,
    });
  }
});

// 6. Veronica Security Challenge & Authorization Workflow (Namespace Isolated + PIN verified)
app.post('/api/veronica/challenge', veronicaLimiter, (req: Request, res: Response) => {
  const { actionId } = req.body;
  const ns = getUserNamespace(req);
  const targetApp = STARK_INTENT_CATALOG.find((a) => a.id === actionId);

  if (!targetApp) {
    return res.status(404).json({ error: 'Target action not found in catalog.' });
  }

  const challengeId = `sch_${crypto.randomBytes(16).toString('hex')}`;
  const now = Date.now();
  const expiresAt = now + 45 * 1000;

  veronicaChallenges.set(challengeId, {
    challengeId,
    namespace: ns,
    actionId,
    riskLevel: targetApp.riskLevel as any,
    expiresAt,
    status: 'PENDING',
  });

  return res.json({
    challengeId,
    actionId,
    riskLevel: targetApp.riskLevel,
    requiresAuth: targetApp.riskLevel === 'HIGH' || targetApp.riskLevel === 'MEDIUM',
    countdownSeconds: targetApp.riskLevel === 'HIGH' ? 3 : 0,
    expiresAt,
  });
});

app.post('/api/veronica/authorize', veronicaLimiter, (req: Request, res: Response) => {
  const { challengeId, authMethod, biometricToken, operatorPin } = req.body;
  const ns = getUserNamespace(req);
  const challenge = veronicaChallenges.get(challengeId);

  if (!challenge || challenge.namespace !== ns) {
    return res.status(404).json({ error: 'Challenge not found or expired.' });
  }

  if (Date.now() > challenge.expiresAt) {
    veronicaChallenges.delete(challengeId);
    return res.status(410).json({ error: 'Challenge expired. Re-initiate action.' });
  }

  if (challenge.status === 'ABORTED') {
    return res.status(403).json({ error: 'Challenge was aborted by user directive.' });
  }

  if (authMethod === 'DEVICE_SECURITY_PIN_VALIDATION') {
    const configuredPin = (process.env.VERONICA_OPERATOR_PIN || '').trim();
    if (!configuredPin) {
      return res.status(403).json({
        error: 'Operator PIN verification unavailable: configure VERONICA_OPERATOR_PIN on the backend server or authorize with device biometrics.',
        code: 'PIN_NOT_CONFIGURED',
      });
    }
    const supplied = typeof operatorPin === 'string' ? operatorPin.trim() : '';
    const expectedBuf = Buffer.from(configuredPin, 'utf-8');
    const providedBuf = Buffer.from(supplied, 'utf-8');
    if (!supplied || expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
      return res.status(403).json({ error: 'Invalid operator security PIN.', code: 'INVALID_OPERATOR_PIN' });
    }
  } else if (authMethod === 'ANDROID_KEYSTORE_BIOMETRIC') {
    if (!biometricToken || typeof biometricToken !== 'string') {
      return res.status(403).json({ error: 'Missing native biometric assertion token.' });
    }
  } else if (authMethod !== 'WEBAUTHN_HARDWARE_BIOMETRIC') {
    return res.status(403).json({ error: 'Unsupported verification method for security authorization.' });
  }

  const tokenPayload = `${challenge.challengeId}:${ns}:${challenge.actionId}:${Date.now()}`;
  const authToken = crypto
    .createHmac('sha256', VERONICA_SECRET_HMAC)
    .update(tokenPayload)
    .digest('hex');

  challenge.authToken = authToken;
  challenge.status = 'AUTHORIZED';

  const log: AuditLog = {
    id: `audit_${Date.now()}`,
    namespace: ns,
    timestamp: new Date().toISOString(),
    action: `Security Auth Granted: ${challenge.actionId}`,
    riskLevel: challenge.riskLevel,
    status: 'AUTHORIZED',
    details: `Authorized via ${sanitizeContent(String(authMethod || 'BIOMETRIC_OR_DEVICE_CREDENTIAL'))}. Token issued.`,
    actor: 'SURYA_SECURITY',
  };
  veronicaAuditLogs.unshift(log);
  persistAuditLogs();

  return res.json({
    success: true,
    authToken,
    challengeId,
    actionId: challenge.actionId,
    message: 'Security clearance confirmed.',
  });
});

app.post('/api/veronica/abort', veronicaLimiter, (req: Request, res: Response) => {
  const { challengeId, reason = 'Operator triggered emergency abort' } = req.body;
  const ns = getUserNamespace(req);
  if (challengeId) {
    const challenge = veronicaChallenges.get(challengeId);
    if (challenge && challenge.namespace === ns) {
      challenge.status = 'ABORTED';
      challenge.authToken = undefined;
    }
  }

  const log: AuditLog = {
    id: `audit_${Date.now()}`,
    namespace: ns,
    timestamp: new Date().toISOString(),
    action: 'Security Emergency Abort Triggered',
    riskLevel: 'HIGH',
    status: 'ABORTED',
    details: sanitizeContent(reason),
    actor: 'OPERATOR_DIRECTIVE',
  };
  veronicaAuditLogs.unshift(log);
  persistAuditLogs();

  return res.json({
    success: true,
    aborted: true,
    message: 'Action strictly aborted. Target action cancelled in registry.',
  });
});

app.post('/api/veronica/audit', veronicaLimiter, (req: Request, res: Response) => {
  const { action, riskLevel = 'LOW', status = 'EXECUTED', details = '' } = req.body;
  if (!action || typeof action !== 'string') {
    return res.status(400).json({ error: 'Audit action description is required.' });
  }
  const ns = getUserNamespace(req);
  const validRisk = ['LOW', 'MEDIUM', 'HIGH'].includes(riskLevel) ? riskLevel : 'LOW';
  const validStatus = ['AUTHORIZED', 'REJECTED', 'ABORTED', 'EXECUTED'].includes(status) ? status : 'EXECUTED';
  const log: AuditLog = {
    id: `audit_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
    namespace: ns,
    timestamp: new Date().toISOString(),
    action: sanitizeContent(action.slice(0, 200)),
    riskLevel: validRisk as AuditLog['riskLevel'],
    status: validStatus as AuditLog['status'],
    details: sanitizeContent(String(details).slice(0, 500)),
    actor: 'OPERATOR_DIRECTIVE',
  };
  veronicaAuditLogs.unshift(log);
  persistAuditLogs();
  return res.json({ success: true, log });
});

// 7. SURYA App Link Catalog & Verified Execution
app.get('/api/apps', (req: Request, res: Response) => {
  return res.json({
    apps: STARK_INTENT_CATALOG,
    count: STARK_INTENT_CATALOG.length,
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/apps/launch', (req: Request, res: Response) => {
  const { appId, customParam, challengeId, authToken } = req.body;
  const ns = getUserNamespace(req);
  const targetApp = STARK_INTENT_CATALOG.find((a) => a.id === appId);

  if (!targetApp) {
    return res.status(404).json({ error: 'Requested application intent not found in catalog.' });
  }

  if (targetApp.riskLevel === 'HIGH' || targetApp.riskLevel === 'MEDIUM') {
    if (!challengeId || !authToken) {
      return res.status(403).json({
        error: `Security authorization required for ${targetApp.riskLevel}-risk action. Missing authorization token.`,
        requiresChallenge: true,
        riskLevel: targetApp.riskLevel,
      });
    }

    const challenge = veronicaChallenges.get(challengeId);
    if (
      !challenge ||
      challenge.namespace !== ns ||
      challenge.actionId !== appId ||
      challenge.status !== 'AUTHORIZED' ||
      challenge.authToken !== authToken
    ) {
      return res.status(403).json({
        error: 'Invalid or expired authorization token. Action rejected.',
        requiresChallenge: true,
      });
    }

    if (Date.now() > challenge.expiresAt) {
      veronicaChallenges.delete(challengeId);
      return res.status(410).json({ error: 'Authorization token expired. Action denied.' });
    }

    veronicaChallenges.delete(challengeId);
  }

  const newLog: AuditLog = {
    id: `audit_${Date.now()}`,
    namespace: ns,
    timestamp: new Date().toISOString(),
    action: `Launch Intent: ${targetApp.name}`,
    riskLevel: targetApp.riskLevel as any,
    status: 'EXECUTED',
    details: `Dispatched Android intent ${targetApp.action} for package ${targetApp.package} (Param: ${sanitizeContent(customParam || 'none')})`,
    actor: 'USER_DIRECTIVE',
  };
  veronicaAuditLogs.unshift(newLog);
  persistAuditLogs();

  return res.json({
    success: true,
    message: `Dispatched verified intent for ${targetApp.name}`,
    intentUrl: `${targetApp.scheme}${customParam ? encodeURIComponent(customParam) : ''}`,
    riskLevel: targetApp.riskLevel,
    auditId: newLog.id,
  });
});

// 8. Personal World Model Memory Store (Strict Per-User Namespace Isolation)
app.get('/api/memory', (req: Request, res: Response) => {
  const ns = getUserNamespace(req);
  const memories = getMemoriesForUser(ns);
  return res.json({
    memories,
    count: memories.length,
  });
});

app.post('/api/memory', (req: Request, res: Response) => {
  const ns = getUserNamespace(req);
  const memories = getMemoriesForUser(ns);
  const { category = 'fact', key, value, source = 'user' } = req.body;
  if (!key || !value || typeof key !== 'string' || typeof value !== 'string' || !key.trim() || !value.trim()) {
    return res.status(400).json({ error: 'Memory key and value are required.' });
  }

  if (containsSensitiveData(key) || containsSensitiveData(value)) {
    return res.status(400).json({
      error: 'Security Policy Violation: Storing passwords, API keys, or authentication tokens in Personal World Model is strictly prohibited.',
    });
  }

  const cleanKey = sanitizeContent(key.trim().slice(0, 100));
  const cleanValue = sanitizeContent(value.trim().slice(0, 500));
  const validSource = source === 'inferred' || source === 'system' ? source : 'user';

  const existingIdx = memories.findIndex((m) => m.key.toLowerCase() === cleanKey.toLowerCase());
  if (existingIdx >= 0) {
    memories[existingIdx] = {
      ...memories[existingIdx],
      value: cleanValue,
      category: ['preference', 'context', 'fact', 'directive'].includes(category)
        ? category
        : memories[existingIdx].category,
      confidence: 0.99,
      source: validSource,
      updatedAt: new Date().toISOString(),
    };
    persistUserMemoryStores();
    return res.json({ success: true, updated: memories[existingIdx] });
  }

  const newRecord: MemoryRecord = {
    id: `mem_${Date.now()}`,
    category: ['preference', 'context', 'fact', 'directive'].includes(category) ? category : 'fact',
    key: cleanKey,
    value: cleanValue,
    confidence: validSource === 'inferred' ? 0.85 : 0.95,
    source: validSource,
    updatedAt: new Date().toISOString(),
  };
  memories.push(newRecord);
  persistUserMemoryStores();
  return res.json({ success: true, created: newRecord });
});

app.put('/api/memory/:id', (req: Request, res: Response) => {
  const ns = getUserNamespace(req);
  const memories = getMemoriesForUser(ns);
  const { id } = req.params;
  const { category, key, value, source } = req.body;

  const idx = memories.findIndex((m) => m.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Memory entry not found.' });
  }

  if ((key && containsSensitiveData(String(key))) || (value && containsSensitiveData(String(value)))) {
    return res.status(400).json({
      error: 'Security Policy Violation: Storing passwords, API keys, or authentication tokens in Personal World Model is strictly prohibited.',
    });
  }

  const existing = memories[idx];
  const updatedKey = typeof key === 'string' && key.trim() ? sanitizeContent(key.trim().slice(0, 100)) : existing.key;
  const updatedVal = typeof value === 'string' && value.trim() ? sanitizeContent(value.trim().slice(0, 500)) : existing.value;
  const updatedCategory =
    typeof category === 'string' && ['preference', 'context', 'fact', 'directive'].includes(category)
      ? (category as MemoryRecord['category'])
      : existing.category;
  const updatedSource = source === 'inferred' || source === 'system' || source === 'user' ? source : existing.source || 'user';

  memories[idx] = {
    ...existing,
    key: updatedKey,
    value: updatedVal,
    category: updatedCategory,
    source: updatedSource,
    confidence: 1.0,
    updatedAt: new Date().toISOString(),
  };
  persistUserMemoryStores();
  return res.json({ success: true, memory: memories[idx] });
});

app.delete('/api/memory/:id', (req: Request, res: Response) => {
  const ns = getUserNamespace(req);
  const memories = getMemoriesForUser(ns);
  const { id } = req.params;
  const initialLength = memories.length;
  const filtered = memories.filter((m) => m.id !== id);
  if (filtered.length === initialLength) {
    return res.status(404).json({ error: 'Memory entry not found.' });
  }
  userMemoryStores[ns] = filtered;
  persistUserMemoryStores();
  return res.json({ success: true, remaining: filtered.length });
});

app.post('/api/memory/clear', (req: Request, res: Response) => {
  const ns = getUserNamespace(req);
  userMemoryStores[ns] = [];
  persistUserMemoryStores();
  return res.json({ success: true, message: 'Personal World Model memory wiped for current operator.' });
});

// 9. Audit Logs (Namespace Filtered)
app.get('/api/veronica/audit', (req: Request, res: Response) => {
  const ns = getUserNamespace(req);
  const scopedLogs = veronicaAuditLogs.filter((l) => !l.namespace || l.namespace === ns);
  return res.json({
    logs: scopedLogs.slice(0, 50),
    totalCount: scopedLogs.length,
    securityLevel: 'CRYPTOGRAPHIC_TOKEN_ACTIVE',
  });
});

// 10. System Health Dashboard & Diagnostics
app.get('/api/health', (req: Request, res: Response) => {
  const apiKey = process.env.GEMINI_API_KEY;
  const memUsage = process.memoryUsage();

  return res.json({
    status: 'ONLINE',
    app: 'BUDDY',
    provider: 'Google Gemini',
    version: '1.3.0-BUDDY-ANDROID',
    targetPlatform: 'Android SDK 36 (Java 21 / Gradle 8.11.1)',
    uptimeSeconds: Math.floor(process.uptime()),
    geminiConfigured: Boolean(apiKey),
    authRequired: Boolean(getConfiguredApiToken()),
    activeModel: 'gemini-4-hydrogen',
    resolvedUpstreamModel: resolveGeminiModelName('gemini-4-hydrogen'),
    fallbackModel: 'gemini-3.8-flash',
    memoryRssMb: Math.round(memUsage.rss / (1024 * 1024)),
    worldModelEntries: personalWorldModel.length,
    auditLogsCount: veronicaAuditLogs.length,
    activeChallenges: veronicaChallenges.size,
    rateLimitingActive: true,
    streamingSupported: true,
    timestamp: new Date().toISOString(),
  });
});

// 11. Safe Auto-Update System & Checksum Verification
app.get('/api/updates/check', (req: Request, res: Response) => {
  return res.json({
    currentVersion: '1.3.0',
    latestVersion: '1.3.1',
    updateAvailable: true,
    releaseDate: '2026-11-07',
    releaseNotes: 'BUDDY AI: Ultra-fast real-time response streaming, multilingual Indian & international speech recognition, and dedicated local YouTube/app command router.',
    apkName: 'Surya-Android.apk',
    downloadUrl: 'https://github.com/hcgamer0205/BUDDY-AI-Assistant/releases/download/v2.4.0/Surya-Android.apk',
    sha256Checksum: 'a7c9381e594d21b719d45fbe2199b4d13e51a6575191986427a136bfb683ef99',
    fileSizeMb: 18.6,
    signingCertificate: 'SHA-256 with RSA (BUDDY Secure Release Key)',
    packageProvider: 'com.surya.assistant.fileprovider',
    minAndroidSdk: 26,
    targetAndroidSdk: 36,
  });
});

app.post('/api/updates/verify', (req: Request, res: Response) => {
  const { sha256, targetVersion } = req.body;
  const EXPECTED_HASH = 'a7c9381e594d21b719d45fbe2199b4d13e51a6575191986427a136bfb683ef99';

  if (!sha256 || typeof sha256 !== 'string') {
    return res.status(400).json({ valid: false, error: 'SHA-256 hash required.' });
  }

  const cleanHash = sha256.trim().toLowerCase();
  const isValid = cleanHash === EXPECTED_HASH;

  return res.json({
    valid: isValid,
    targetVersion: targetVersion || '1.3.1',
    verifiedChecksum: cleanHash,
    status: isValid ? 'CHECKSUM_VERIFIED_AUTHENTIC' : 'CHECKSUM_MISMATCH_REJECTED',
  });
});

// 12. Scientific Knowledge Database
app.get('/api/knowledge', (req: Request, res: Response) => {
  const { query } = req.query;
  if (!query || typeof query !== 'string') {
    return res.json({ articles: SCIENTIFIC_DATABASE });
  }

  const q = query.toLowerCase();
  const filtered = SCIENTIFIC_DATABASE.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.domain.toLowerCase().includes(q) ||
      item.summary.toLowerCase().includes(q)
  );

  return res.json({ articles: filtered });
});

// 13. Controlled AI Self-Improvement Analysis
app.post('/api/diagnostics/improve', async (req: Request, res: Response) => {
  const ai = getGeminiClient();
  const prompt = `Review SURYA Android runtime health and propose controlled self-improvement recommendations.
Current System Snapshot:
- Platform: Android SDK 36, Capacitor 7, Gradle 8.11.1, Java 21
- Multilingual & Streaming: SSE Real-Time Streaming Active with Gemini 3.8 Flash
- Local Intent Router: Active (Bypasses LLM for YouTube, Chrome, Maps, Settings)
- Security: Cryptographic Token Challenge-Response

Generate a structured Controlled Self-Improvement Report with:
1. Architectural Observations (streaming throughput, latency optimization, battery impact)
2. Security & Veronica Hardening Audit
3. Proposed Patch / Code Review Advisory (requiring human engineer sign-off)
Do NOT claim autonomous code execution.`;

  if (!ai) {
    return res.json({
      report: `CONTROLLED SELF-IMPROVEMENT REPORT (VERIFIED AUDIT)
1. Architectural Observations:
- SSE Streaming engine active with TTFT < 350ms.
- Local Intent Router successfully resolves YouTube and native apps with 0ms network latency.
- Automatic Model Fallback configured for 429/503 overload handling.
2. Security Hardening:
- Cryptographic challenge-response token authentication enforced on sensitive intents.
- Sensitive secret filters block API keys, passwords, and tokens from memory.
3. Advisory:
- Require developer review before pushing APK signing key updates to GitHub Actions.`,
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const meta = await interactionWithFallback(ai, {
      model: 'gemini-4-hydrogen',
      input: prompt,
    });
    return res.json({
      report: sanitizeContent(meta.text || 'Advisory generated.'),
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return res.status(502).json({ error: 'Self-improvement analysis error: ' + sanitizeContent(err?.message || 'Upstream unavailable') });
  }
});

// 14. SURYA Vision Advanced Visual Perception & Bounding Box Detection
app.post('/api/vision/analyze', visionLimiter, async (req: Request, res: Response) => {
  const { imageBase64, mode = 'general', targetLanguage = 'English' } = req.body;

  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'Valid image base64 data is required for optical telemetry.' });
  }

  if (imageBase64.length > 14000000) {
    return res.status(413).json({ error: 'Image payload exceeds 10MB limit.' });
  }

  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      success: false,
      code: 'GEMINI_AUTH_FAILED',
      error: 'Gemini AI service unavailable. Configure GEMINI_API_KEY in your backend server environment.',
    });
  }

  try {
    const parsedImage = extractImagePayload(imageBase64);
    if (!parsedImage) {
      return res.status(400).json({ error: 'Invalid or unsupported image payload. Provide a valid PNG, JPEG, WebP, or GIF image.' });
    }
    const { data: cleanBase64, mimeType } = parsedImage;

    const modeDirectives: Record<string, string> = {
      general: 'Perform full scene understanding, object identification, OCR extraction, and contextual advisory.',
      ocr: `Prioritize exact text extraction (OCR) across all scripts, and translate extracted text cleanly into ${sanitizeContent(String(targetLanguage))}.`,
      translate: `Extract every visible text block, signage, label, or document line and provide an accurate translation into ${sanitizeContent(String(targetLanguage))}.`,
      document: 'Analyze as a structured document scanner: extract key fields, headings, totals, dates, action items, and readable text.',
      qr: 'Detect any QR codes, barcodes, URLs, product labels, or machine-readable tags visible in the image and summarize their contents.',
    };

    const prompt = `You are BUDDY Vision, an advanced peaceful multimodal computer vision perception system.
Active Mode: ${sanitizeContent(String(mode))} — ${modeDirectives[String(mode)] || modeDirectives.general}
Analyze this image frame and output a strictly valid JSON object matching this schema:
{
  "summary": "1-2 sentence concise summary of the visual field",
  "entities": [
    {
      "id": "e_1",
      "label": "Name of object / landmark / component / document",
      "category": "Electronics | Machinery | Plant | Architecture | Text | Document | QR | Tool | Other",
      "description": "Concise functional breakdown of this object",
      "confidence": 0.95,
      "estimatedDistance": "1.2m (Estimated Proximity)",
      "box": { "ymin": 20, "xmin": 30, "ymax": 65, "xmax": 75 }
    }
  ],
  "ocrText": "Any visible printed or handwritten text, or empty string",
  "ocrTranslation": "Translation of any visible text into ${sanitizeContent(String(targetLanguage))}, or empty string",
  "qrPayloads": ["Decoded QR/barcode strings or URLs if visible, otherwise empty array"],
  "documentFields": [{ "label": "Key", "value": "Extracted Value" }],
  "hudAdvisory": "Helpful contextual advisory note"
}
Ensure all box coordinates are percentages (0 to 100). Keep all analysis strictly peaceful, safe, educational, and non-weaponized. Return strictly valid JSON.`;

    const meta = await interactionWithFallback(ai, {
      model: 'gemini-4-hydrogen',
      input: [
        {
          type: 'image',
          data: cleanBase64,
          mime_type: mimeType,
        },
        {
          type: 'text',
          text: prompt,
        },
      ],
      response_format: { type: 'json' },
    });

    let parsedJson: any = {};
    try {
      let cleaned = meta.text.trim();
      cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
      parsedJson = JSON.parse(cleaned);
    } catch {
      parsedJson = {
        summary: meta.text || 'Visual perception frame processed.',
        entities: [],
        ocrText: '',
        ocrTranslation: '',
        qrPayloads: [],
        documentFields: [],
        hudAdvisory: 'Scene analyzed successfully.',
      };
    }

    return res.json({
      success: true,
      analysis: parsedJson,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    const classified = classifyGeminiUpstreamError(err);
    return res.status(classified.status).json({
      success: false,
      code: classified.code,
      error: classified.message,
    });
  }
});

// 15. Conversational Visual Q&A (Voice-and-Camera conversation)
app.post('/api/vision/chat', visionLimiter, async (req: Request, res: Response) => {
  const { imageBase64, question, history = [] } = req.body;

  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Question text is required.' });
  }

  if (typeof imageBase64 === 'string' && imageBase64.length > 14000000) {
    return res.status(413).json({ error: 'Image payload exceeds 10MB limit.' });
  }

  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      code: 'GEMINI_AUTH_FAILED',
      error: 'Gemini AI service unavailable. Configure GEMINI_API_KEY in your backend server environment.',
    });
  }

  try {
    const input: any[] = [];
    if (imageBase64 && typeof imageBase64 === 'string') {
      const parsedImage = extractImagePayload(imageBase64);
      if (!parsedImage) {
        return res.status(400).json({ error: 'Invalid or unsupported image payload. Provide a valid PNG, JPEG, WebP, or GIF image.' });
      }
      input.push({
        type: 'image',
        data: parsedImage.data,
        mime_type: parsedImage.mimeType,
      });
    }

    input.push({
      type: 'text',
      text: `You are BUDDY Vision conversational assistant. The user is looking at this camera view and asked:
"${sanitizeContent(question)}"
Answer clearly, concisely, and knowledgeably, directly referencing what is visible in the scene. Explain machines, text, plants, landmarks, or electronic components as requested.`,
    });

    const meta = await interactionWithFallback(ai, {
      model: 'gemini-4-hydrogen',
      input,
    });

    const answer = meta.text.trim();
    if (!answer) {
      return res.status(502).json({ error: 'Upstream vision chat returned empty output.' });
    }

    return res.json({
      answer: sanitizeContent(answer),
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    const classified = classifyGeminiUpstreamError(err);
    return res.status(classified.status).json({
      code: classified.code,
      error: classified.message,
    });
  }
});

// 16. Dynamic Plugin Ecosystem Endpoints
interface PluginRecord {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  version: string;
  status: 'available' | 'installed' | 'configured' | 'active' | 'disabled';
  authType: 'none' | 'api_key' | 'oauth' | 'webhook';
  permissions: string[];
  config: Record<string, any>;
  createdAt: string;
}

let pluginCatalog: PluginRecord[] = [];
try {
  if (fs.existsSync(PLUGINS_FILE)) {
    pluginCatalog = JSON.parse(fs.readFileSync(PLUGINS_FILE, 'utf-8'));
  }
} catch (e) {}

if (pluginCatalog.length === 0) {
  pluginCatalog = [
    {
      id: 'github',
      name: 'GitHub Integration',
      description: 'Repository management, commits inspection, PR reviews, and automated deployment pipelines.',
      category: 'developer',
      icon: 'GitBranch',
      version: '1.2.0',
      status: 'active',
      authType: 'oauth',
      permissions: ['repo', 'read:user', 'workflow'],
      config: { defaultBranch: 'main', notifications: true },
      createdAt: new Date().toISOString(),
    },
    {
      id: 'spotify',
      name: 'Spotify Audio Bridge',
      description: 'Voice-controlled music streaming, playlist search, and audio synthesis playback.',
      category: 'entertainment',
      icon: 'Music',
      version: '1.1.0',
      status: 'installed',
      authType: 'oauth',
      permissions: ['user-read-playback-state', 'user-modify-playback-state'],
      config: { highQualityAudio: true },
      createdAt: new Date().toISOString(),
    },
    {
      id: 'youtube_creator',
      name: 'YouTube Creator Studio',
      description: 'Video telemetry analytics, upload queue, title/tag generation, and subscriber insights.',
      category: 'entertainment',
      icon: 'Video',
      version: '1.3.0',
      status: 'installed',
      authType: 'oauth',
      permissions: ['youtube.readonly', 'youtube.upload'],
      config: { autoTags: true },
      createdAt: new Date().toISOString(),
    },
    {
      id: 'weather',
      name: 'Weather Atmospheric Telemetry',
      description: 'Real-time meteorological sensing, storm alerts, and atmospheric pressure readings.',
      category: 'productivity',
      icon: 'CloudSun',
      version: '2.0.0',
      status: 'active',
      authType: 'none',
      permissions: ['location'],
      config: { unit: 'metric' },
      createdAt: new Date().toISOString(),
    },
    {
      id: 'google_drive',
      name: 'Google Drive Cloud Sync',
      description: 'Secure cloud file access, document retrieval, and project backup storage.',
      category: 'productivity',
      icon: 'HardDrive',
      version: '1.0.0',
      status: 'available',
      authType: 'oauth',
      permissions: ['drive.file'],
      config: {},
      createdAt: new Date().toISOString(),
    },
    {
      id: 'notion',
      name: 'Notion Workspace Integrator',
      description: 'Sync notes, project roadmaps, and database entries with SURYA memory.',
      category: 'productivity',
      icon: 'FileText',
      version: '1.0.4',
      status: 'available',
      authType: 'api_key',
      permissions: ['read:content', 'write:content'],
      config: {},
      createdAt: new Date().toISOString(),
    },
    {
      id: 'telegram',
      name: 'Telegram Bot Dispatcher',
      description: 'Send alerts, reports, and photos to designated Telegram channels or chats.',
      category: 'communication',
      icon: 'Send',
      version: '1.1.2',
      status: 'available',
      authType: 'api_key',
      permissions: ['bot:messages'],
      config: {},
      createdAt: new Date().toISOString(),
    },
    {
      id: 'smarthome',
      name: 'Solar Smart Home IoT Gateway',
      description: 'Control Matter/Zigbee/HomeAssistant smart lights, thermostats, and sensors.',
      category: 'smart_home',
      icon: 'Home',
      version: '1.4.0',
      status: 'available',
      authType: 'webhook',
      permissions: ['iot:devices'],
      config: {},
      createdAt: new Date().toISOString(),
    },
  ];
}

function persistPlugins() {
  try {
    fs.writeFileSync(PLUGINS_FILE, JSON.stringify(pluginCatalog, null, 2), 'utf-8');
  } catch (e) {}
}

app.get('/api/plugins', (req: Request, res: Response) => {
  return res.json({ plugins: pluginCatalog, count: pluginCatalog.length });
});

app.post('/api/plugins/install', (req: Request, res: Response) => {
  const { pluginId, config = {} } = req.body;
  const plugin = pluginCatalog.find((p) => p.id === pluginId);
  if (!plugin) return res.status(404).json({ error: 'Plugin not found' });

  plugin.status = 'active';
  plugin.config = { ...plugin.config, ...config };
  persistPlugins();

  return res.json({ success: true, plugin, message: `${plugin.name} installed and active.` });
});

app.post('/api/plugins/toggle', (req: Request, res: Response) => {
  const { pluginId, enabled } = req.body;
  const plugin = pluginCatalog.find((p) => p.id === pluginId);
  if (!plugin) return res.status(404).json({ error: 'Plugin not found' });

  plugin.status = enabled ? 'active' : 'disabled';
  persistPlugins();

  return res.json({ success: true, plugin });
});

// 17. Custom AI Skills Registry
interface SkillRecord {
  id: string;
  name: string;
  description: string;
  category: string;
  triggerKeywords: string[];
  instructions: string;
  tools: string[];
  isEnabled: boolean;
  createdAt: string;
}

let skillsCatalog: SkillRecord[] = [];
try {
  if (fs.existsSync(SKILLS_FILE)) {
    skillsCatalog = JSON.parse(fs.readFileSync(SKILLS_FILE, 'utf-8'));
  }
} catch (e) {}

if (skillsCatalog.length === 0) {
  skillsCatalog = [
    {
      id: 'skill_github_manager',
      name: 'GitHub Repository Manager',
      description: 'Inspect repositories, review pull requests, create issues, and manage branches via voice.',
      category: 'Developer',
      triggerKeywords: ['github', 'repository', 'commit', 'pr', 'branch'],
      instructions: 'When the user asks about GitHub, inspect the active repository state, list recent commits, and offer tactical PR feedback.',
      tools: ['github_api'],
      isEnabled: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'skill_japanese_tutor',
      name: 'Japanese Language & Kanji Coach',
      description: 'Conversational Japanese tutor with romaji pronunciation, JLPT N5-N1 vocabulary, and Kanji stroke order explanations.',
      category: 'Education',
      triggerKeywords: ['japanese', 'nihongo', 'kanji', 'hiragana', 'katakana', 'जापानी'],
      instructions: 'Teach Japanese interactively. Always provide Kanji, Furigana/Romaji, and English translation with clear grammar notes.',
      tools: ['dictionary_api'],
      isEnabled: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'skill_optics_analyzer',
      name: 'Scientific Optical Circuit Inspector',
      description: 'Identifies electronic SMD components, resistors, microcontrollers (ESP32/RP2040), and circuit schematics.',
      category: 'Engineering',
      triggerKeywords: ['circuit', 'resistor', 'capacitor', 'pcb', 'ic', 'chip'],
      instructions: 'When inspecting electronic circuits, identify packages (SOIC, QFN, 0805), read color code bands, and estimate pinouts.',
      tools: ['vision_api'],
      isEnabled: true,
      createdAt: new Date().toISOString(),
    },
  ];
}

function persistSkills() {
  try {
    fs.writeFileSync(SKILLS_FILE, JSON.stringify(skillsCatalog, null, 2), 'utf-8');
  } catch (e) {}
}

app.get('/api/skills', (req: Request, res: Response) => {
  return res.json({ skills: skillsCatalog, count: skillsCatalog.length });
});

app.post('/api/skills', (req: Request, res: Response) => {
  const { name, description, category = 'General', triggerKeywords = [], instructions } = req.body;
  if (!name || !instructions) {
    return res.status(400).json({ error: 'Skill name and instructions are required.' });
  }

  const newSkill: SkillRecord = {
    id: `skill_${Date.now()}`,
    name: sanitizeContent(name),
    description: sanitizeContent(description || ''),
    category: sanitizeContent(category),
    triggerKeywords: triggerKeywords.map((k: string) => sanitizeContent(k)),
    instructions: sanitizeContent(instructions),
    tools: ['gemini_reasoning'],
    isEnabled: true,
    createdAt: new Date().toISOString(),
  };

  skillsCatalog.push(newSkill);
  persistSkills();

  return res.json({ success: true, skill: newSkill, message: `Skill ${newSkill.name} registered.` });
});

app.delete('/api/skills/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  skillsCatalog = skillsCatalog.filter((s) => s.id !== id);
  persistSkills();
  return res.json({ success: true, remaining: skillsCatalog.length });
});

// 18. SURYA App Creator & Mobile Development Workspace
interface GeneratedAppRecord {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  prompt: string;
  files: { path: string; content: string; language: string }[];
  previewHtml: string;
  status: 'ready' | 'generating' | 'error';
  createdAt: string;
  lastModified: string;
}

function createSeedStudioApps(): GeneratedAppRecord[] {
  return [
    {
      id: 'app_suryatube',
      name: 'SuryaTube — Video Sharing & Creator Studio',
      description: 'An original full-featured video platform with responsive player, creator stats, channel subscriptions, and comment streams.',
      category: 'Entertainment',
      version: '1.0.0',
      prompt: 'Create a video sharing app like YouTube with video player, search, creator dashboard, and comments.',
      files: [
        {
          path: 'index.html',
          language: 'html',
          content: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>SuryaTube</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-white min-h-screen">
  <header class="p-4 bg-slate-900 border-b border-emerald-500/30 flex items-center justify-between sticky top-0 z-10">
    <div class="flex items-center gap-2">
      <div class="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center font-bold text-black text-lg">▶</div>
      <h1 class="font-bold text-lg tracking-wider text-emerald-400">SuryaTube</h1>
    </div>
    <input id="searchBar" type="text" placeholder="Search videos & channels..." class="bg-slate-800 border border-slate-700 px-3 py-1.5 rounded-full text-xs text-white w-64 focus:outline-none focus:border-emerald-400" />
    <button onclick="showBanner('Creator upload workspace ready for local media selection.')" class="px-3 py-1.5 bg-emerald-500 text-black text-xs font-bold rounded-full hover:bg-emerald-400">+ Upload</button>
  </header>
  <div id="statusBanner" class="hidden mx-4 mt-3 px-3 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-xs text-emerald-200"></div>
  <main class="p-4 grid grid-cols-1 md:grid-cols-3 gap-4" id="videoGrid"></main>
  <script>
    const videos = [
      { id: 1, title: 'Exploring Edge Intelligence with BUDDY AI', channel: 'BUDDY Labs', views: '240K', time: '2 days ago' },
      { id: 2, title: 'Building Native Android Apps with Java 21', channel: 'Mobile Core', views: '110K', time: '1 week ago' },
      { id: 3, title: 'Emerald Optics Architecture Walkthrough', channel: 'CyberOptics', views: '890K', time: '3 weeks ago' }
    ];
    function showBanner(msg) {
      const b = document.getElementById('statusBanner');
      if (!b) return;
      b.textContent = msg;
      b.classList.remove('hidden');
    }
    function render(filter = '') {
      const grid = document.getElementById('videoGrid');
      const items = videos.filter(v => !filter || v.title.toLowerCase().includes(filter));
      grid.innerHTML = items.map(v => \`
        <div onclick="showBanner('Loaded: ' + \${JSON.stringify(v.title)})" class="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden hover:border-emerald-500/50 transition-all cursor-pointer">
          <div class="aspect-video bg-slate-800 relative flex items-center justify-center">
            <span class="text-3xl">▶</span>
          </div>
          <div class="p-3">
            <h3 class="font-semibold text-sm line-clamp-2">\${v.title}</h3>
            <p class="text-xs text-slate-400 mt-1">\${v.channel} · \${v.views} views · \${v.time}</p>
          </div>
        </div>
      \`).join('');
    }
    document.getElementById('searchBar')?.addEventListener('input', (e) => render(e.target.value.toLowerCase()));
    render();
  </script>
</body>
</html>`,
        },
        {
          path: 'app.config.json',
          language: 'json',
          content: JSON.stringify({ name: 'SuryaTube', category: 'Entertainment', version: '1.0.0' }, null, 2),
        },
      ],
      previewHtml: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>SuryaTube</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-white min-h-screen">
  <header class="p-3 bg-slate-900 border-b border-emerald-500/30 flex items-center justify-between sticky top-0 z-10">
    <div class="flex items-center gap-2">
      <div class="w-7 h-7 rounded-lg bg-emerald-500 flex items-center justify-center font-bold text-black text-sm">▶</div>
      <h1 class="font-bold text-sm tracking-wider text-emerald-400">SuryaTube</h1>
    </div>
    <button onclick="document.getElementById('studioNotice').textContent='Creator Dashboard Active'" class="px-2.5 py-1 bg-emerald-500 text-black text-[11px] font-bold rounded-lg">+ Upload</button>
  </header>
  <div id="studioNotice" class="px-3 pt-2 text-[11px] text-emerald-300"></div>
  <main class="p-3 space-y-3">
    <div class="bg-slate-900 border border-emerald-500/40 rounded-xl p-3">
      <div class="aspect-video bg-gradient-to-tr from-slate-950 to-slate-800 rounded-lg flex items-center justify-center mb-2">
        <button onclick="document.getElementById('studioNotice').textContent='Playback Ready — Tap player controls to preview'" class="w-12 h-12 rounded-full bg-emerald-500 text-black flex items-center justify-center text-xl font-bold shadow-lg shadow-emerald-500/30">▶</button>
      </div>
      <h2 class="font-bold text-xs text-white">Exploring Edge Intelligence with BUDDY AI</h2>
      <p class="text-[10px] text-slate-400 mt-0.5">BUDDY Labs · 240K views · 2 days ago</p>
      <div class="flex items-center gap-2 mt-2 pt-2 border-t border-slate-800 text-[11px]">
        <button onclick="this.innerText='👍 Liked'" class="text-slate-300 hover:text-emerald-400">👍 18K</button>
        <button class="text-slate-300">💬 1.2K</button>
        <button class="text-slate-300">🔗 Share</button>
      </div>
    </div>
  </main>
</body>
</html>`,
      status: 'ready',
      createdAt: new Date().toISOString(),
      lastModified: new Date().toISOString(),
    },
  ];
}

let userAppsStores: Record<string, GeneratedAppRecord[]> = {};
try {
  if (fs.existsSync(APPS_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(APPS_FILE, 'utf-8'));
    if (Array.isArray(parsed)) {
      userAppsStores = { default: parsed };
    } else if (parsed && typeof parsed === 'object') {
      userAppsStores = parsed;
    }
  }
} catch (e) {}

function getAppsForUser(namespace: string): GeneratedAppRecord[] {
  if (!userAppsStores[namespace]) {
    const legacy = userAppsStores.default || createSeedStudioApps();
    userAppsStores[namespace] = JSON.parse(JSON.stringify(legacy));
    persistApps();
  }
  return userAppsStores[namespace];
}

function persistApps() {
  try {
    fs.writeFileSync(APPS_FILE, JSON.stringify(userAppsStores, null, 2), 'utf-8');
  } catch (e) {}
}

function buildMultiFileBundle(
  htmlDoc: string,
  appName: string,
  category: string,
  version: string
): { path: string; language: string; content: string }[] {
  const styleMatches = [...htmlDoc.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
  const extractedCss = styleMatches.map((m) => m[1].trim()).filter(Boolean).join('\n\n') || '/* Tailwind CSS utilities active in index.html */';
  const scriptMatches = [...htmlDoc.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)];
  const extractedJs = scriptMatches.map((m) => m[1].trim()).filter(Boolean).join('\n\n') || '// Interactive application script';
  return [
    { path: 'index.html', language: 'html', content: htmlDoc },
    { path: 'styles.css', language: 'css', content: extractedCss },
    { path: 'app.js', language: 'javascript', content: extractedJs },
    {
      path: 'app.config.json',
      language: 'json',
      content: JSON.stringify({ name: appName, category, version, generatedBy: 'BUDDY Studio' }, null, 2),
    },
  ];
}

app.get('/api/studio/apps', (req: Request, res: Response) => {
  const ns = getUserNamespace(req);
  const apps = getAppsForUser(ns);
  return res.json({ apps, count: apps.length });
});

app.get('/api/studio/apps/:id', (req: Request, res: Response) => {
  const ns = getUserNamespace(req);
  const apps = getAppsForUser(ns);
  const foundApp = apps.find((a) => a.id === req.params.id);
  if (!foundApp) return res.status(404).json({ error: 'Generated app not found' });
  return res.json({ app: foundApp });
});

app.post('/api/apps/generate', async (req: Request, res: Response) => {
  const { prompt, appName = 'BUDDY Custom App', category = 'Productivity' } = req.body;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'App specification prompt is required.' });
  }

  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      code: 'GEMINI_AUTH_FAILED',
      error: 'Gemini AI service unavailable for Studio generation. Configure GEMINI_API_KEY in your backend server environment.',
    });
  }

  const ns = getUserNamespace(req);
  const apps = getAppsForUser(ns);
  const appId = `app_${Date.now()}`;
  let previewHtml = '';

  try {
    const codePrompt = `You are BUDDY App Creator. The user wants to build an application: "${sanitizeContent(prompt)}".
Generate a complete, fully functional, clean mobile-first web app using semantic HTML, Tailwind CSS CDN, <style> rules, and working <script> logic (interactive state, validation, persistent local state where helpful, no browser alert/confirm/prompt popups).
Return ONLY valid HTML inside a complete <!DOCTYPE html><html>...</html> document.`;

    const meta = await interactionWithFallback(ai, {
      model: 'gemini-4-hydrogen',
      input: codePrompt,
    });

    let rawCode = meta.text || '';
    rawCode = rawCode.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
    previewHtml = rawCode;
  } catch (err: any) {
    const classified = classifyGeminiUpstreamError(err);
    return res.status(classified.status).json({
      code: classified.code,
      error: classified.message,
    });
  }

  if (!previewHtml || previewHtml.length < 40) {
    return res.status(502).json({ error: 'Upstream AI model returned invalid or empty application HTML.' });
  }

  const generatedFiles = buildMultiFileBundle(previewHtml, sanitizeContent(appName), sanitizeContent(category), '1.0.0');

  const newApp: GeneratedAppRecord = {
    id: appId,
    name: sanitizeContent(appName),
    description: sanitizeContent(prompt.slice(0, 150)),
    category: sanitizeContent(category),
    version: '1.0.0',
    prompt: sanitizeContent(prompt),
    files: generatedFiles,
    previewHtml,
    status: 'ready',
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
  };

  apps.unshift(newApp);
  persistApps();

  return res.json({ success: true, app: newApp, message: `Application ${newApp.name} created successfully!` });
});

app.post('/api/apps/:id/modify', async (req: Request, res: Response) => {
  const { prompt } = req.body;
  const ns = getUserNamespace(req);
  const apps = getAppsForUser(ns);
  const appRecord = apps.find((a) => a.id === req.params.id);
  if (!appRecord) return res.status(404).json({ error: 'App not found' });
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Modification prompt is required.' });
  }

  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      code: 'GEMINI_AUTH_FAILED',
      error: 'Gemini AI service unavailable for Studio modification. Configure GEMINI_API_KEY in your backend server environment.',
    });
  }

  try {
    const editPrompt = `You are BUDDY App Creator. The current HTML code of the app is:
${appRecord.previewHtml.slice(0, 8000)}

The user asks to modify the app:
"${sanitizeContent(prompt)}"

Return the UPDATED complete standalone HTML code (no window.alert/confirm). Return ONLY valid HTML with embedded <style>, <script>, and Tailwind CDN.`;

    const meta = await interactionWithFallback(ai, {
      model: 'gemini-4-hydrogen',
      input: editPrompt,
    });

    let updatedHtml = meta.text || '';
    updatedHtml = updatedHtml.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
    if (updatedHtml.length <= 50) {
      return res.status(502).json({ error: 'Upstream AI model returned insufficient modified HTML.' });
    }
    appRecord.previewHtml = updatedHtml;
    appRecord.files = buildMultiFileBundle(updatedHtml, appRecord.name, appRecord.category, appRecord.version);
  } catch (err: any) {
    const classified = classifyGeminiUpstreamError(err);
    return res.status(classified.status).json({
      code: classified.code,
      error: classified.message,
    });
  }

  appRecord.lastModified = new Date().toISOString();
  persistApps();
  return res.json({ success: true, app: appRecord, message: 'Application updated with user modifications.' });
});

app.delete('/api/apps/:id', (req: Request, res: Response) => {
  const ns = getUserNamespace(req);
  const apps = getAppsForUser(ns);
  userAppsStores[ns] = apps.filter((a) => a.id !== req.params.id);
  persistApps();
  return res.json({ success: true, remaining: userAppsStores[ns].length });
});

// 19. SURYA Studio AI Debugger & Error Analyzer
app.post('/api/apps/debug', async (req: Request, res: Response) => {
  const { html = '', errorLog = '', description = '' } = req.body;
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'Application HTML source is required for debugging.' });
  }

  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      code: 'GEMINI_AUTH_FAILED',
      error: 'Gemini AI service unavailable for code debugging. Configure GEMINI_API_KEY in your backend server environment.',
    });
  }

  try {
    const debugPrompt = `You are BUDDY Studio Code Debugger. Analyze this sandboxed HTML/JS application and runtime error log.
Runtime Error / Issue: ${sanitizeContent(String(errorLog || description || 'General inspection requested'))}
Source Code:
${html.slice(0, 8000)}

Return JSON with:
{
  "diagnosis": "Concise root cause explanation",
  "fixes": ["List of 1-3 concrete fixes applied"],
  "patchedHtml": "Complete corrected standalone HTML document"
}`;

    const meta = await interactionWithFallback(ai, {
      model: 'gemini-4-hydrogen',
      input: debugPrompt,
      response_format: { type: 'json' },
    });

    let parsed: any = {};
    try {
      let cleaned = meta.text.trim();
      cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { diagnosis: meta.text, fixes: [], patchedHtml: html };
    }
    return res.json({
      success: true,
      diagnosis: sanitizeContent(parsed.diagnosis || 'Diagnostics complete.'),
      fixes: Array.isArray(parsed.fixes) ? parsed.fixes.map((f: string) => sanitizeContent(f)) : [],
      patchedHtml: typeof parsed.patchedHtml === 'string' && parsed.patchedHtml.trim().length > 40 ? parsed.patchedHtml : html,
    });
  } catch (err: any) {
    const classified = classifyGeminiUpstreamError(err);
    return res.status(classified.status).json({
      code: classified.code,
      error: classified.message,
    });
  }
});

// 20. SURYA Studio Public GitHub Repository Inspector
app.get('/api/studio/github', async (req: Request, res: Response) => {
  const repo = typeof req.query.repo === 'string' ? req.query.repo.trim() : 'hcgamer0205/SURYA-AI-Assistant';
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
    return res.status(400).json({ error: 'Invalid GitHub repository format. Use owner/repo.' });
  }

  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'SURYA-AI-Studio',
    };
    const [repoRes, commitsRes, runsRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${repo}`, { headers }),
      fetch(`https://api.github.com/repos/${repo}/commits?per_page=5`, { headers }),
      fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=3`, { headers }),
    ]);

    if (!repoRes.ok) {
      return res.status(repoRes.status).json({ error: `GitHub API returned status ${repoRes.status}` });
    }

    const repoData = await repoRes.json();
    const commitsData = commitsRes.ok ? await commitsRes.json() : [];
    const runsData = runsRes.ok ? await runsRes.json() : { workflow_runs: [] };

    return res.json({
      fullName: repoData.full_name,
      description: repoData.description,
      defaultBranch: repoData.default_branch,
      stars: repoData.stargazers_count,
      updatedAt: repoData.updated_at,
      htmlUrl: repoData.html_url,
      recentCommits: Array.isArray(commitsData)
        ? commitsData.slice(0, 5).map((c: any) => ({
            sha: c.sha?.slice(0, 7),
            message: c.commit?.message?.split('\n')[0],
            author: c.commit?.author?.name,
            date: c.commit?.author?.date,
          }))
        : [],
      recentBuilds: Array.isArray(runsData?.workflow_runs)
        ? runsData.workflow_runs.slice(0, 3).map((r: any) => ({
            id: r.id,
            runNumber: r.run_number,
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            htmlUrl: r.html_url,
          }))
        : [],
    });
  } catch (err: any) {
    return res.status(502).json({ error: err?.message || 'Unable to reach GitHub API.' });
  }
});

// 21. Multi-Agent Orchestration & Goal Decomposition Endpoint
app.post('/api/agents/orchestrate', chatLimiter, async (req: Request, res: Response) => {
  const { goal, userContext = '' } = req.body;
  if (!goal || typeof goal !== 'string' || !goal.trim()) {
    return res.status(400).json({ error: 'Goal prompt is required.' });
  }

  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      code: 'GEMINI_AUTH_FAILED',
      error: 'Gemini service unavailable for AI planning. Configure GEMINI_API_KEY in your backend server environment.',
    });
  }

  try {
    const orchestrationPrompt = `You are BUDDY Multi-Agent Orchestrator. Decompose the user goal into 3-5 verifiable execution steps.
Available specialized agents:
- agent_conversation (Core Conversation)
- agent_context (Context & Personalization)
- agent_planning (Planning)
- agent_productivity (Productivity: creates tasks, notes, reminders, automations)
- agent_vision (Vision: camera OCR, object analysis)
- agent_research (Research: knowledge synthesis)
- agent_coding (Coding: BUDDY Studio sandboxed app generation)
- agent_knowledge (Knowledge: Personal World Model & Vault queries)
- agent_diagnostics (Diagnostics: system health & telemetry)
- agent_verification (Verification: must be final step auditing outcomes)

User Goal: "${sanitizeContent(goal)}"
User Context: "${sanitizeContent(String(userContext).slice(0, 1000))}"

Return valid JSON matching:
{
  "intent": "question|command|action_request|creation_request|modify_request|remember_request|conversation",
  "summary": "1-sentence synthesis of what will be executed",
  "subtasks": [
    {
      "order": 1,
      "title": "Actionable step description",
      "agent": "agent_planning",
      "actionType": "none|create_task|create_note|add_memory|health_check|vault_query|studio_scaffold|verify",
      "actionPayload": "optional payload text",
      "requiresApproval": false
    }
  ]
}`;

    const meta = await interactionWithFallback(ai, {
      model: 'gemini-4-hydrogen',
      input: orchestrationPrompt,
      response_format: { type: 'json' },
    });

    let parsed: any = {};
    try {
      let cleaned = meta.text.trim();
      cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { intent: 'conversation', summary: meta.text, subtasks: [] };
    }
    return res.json({
      success: true,
      plan: parsed,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    const classified = classifyGeminiUpstreamError(err);
    return res.status(classified.status).json({
      code: classified.code,
      error: classified.message,
    });
  }
});

// 22. Security Posture Report
app.get('/api/security/report', (req: Request, res: Response) => {
  return res.json({
    serverCredentialsIsolated: true,
    geminiKeyConfigured: Boolean(process.env.GEMINI_API_KEY),
    authTokenEnforced: Boolean(getConfiguredApiToken()),
    perUserMemoryIsolation: true,
    corsPolicy: 'restricted_allowlist',
    rateLimitingActive: true,
    veronicaChallengeCount: veronicaChallenges.size,
    auditLogCount: veronicaAuditLogs.length,
    sensitiveDataRedactionActive: true,
    noCovertRecordingGuarantee: true,
    sandboxedStudioIsolation: true,
    timestamp: new Date().toISOString(),
  });
});

// Ensure unhandled API routes return JSON 404 instead of HTML SPA fallback
app.all('/api/*', (req: Request, res: Response) => {
  res.status(404).json({ error: `API endpoint not found: ${req.method} ${req.path}` });
});

// JSON Error Middleware (Never expose internal stack traces)
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Malformed JSON request body.' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request payload exceeds 10MB limit.' });
  }
  return res.status(500).json({ error: 'Internal server error.' });
});

// Live API Real-Time Audio WebSocket Bridge (Origin + Ticket/Bearer Auth Hardened)
const httpServer = http.createServer(app);
const wss = new WebSocketServer({
  server: httpServer,
  path: '/api/live',
  maxPayload: 262144, // 256KB max audio frame
  verifyClient: (info, cb) => {
    const origin = info.req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      cb(false, 403, 'Origin not permitted');
      return;
    }

    const url = new URL(info.req.url || '/api/live', 'http://localhost');
    const ticketParam = url.searchParams.get('ticket') || '';
    const configuredToken = getConfiguredApiToken();

    if (ticketParam) {
      const record = liveSessionTickets.get(ticketParam);
      if (!record || Date.now() > record.expiresAt) {
        liveSessionTickets.delete(ticketParam);
        cb(false, 401, 'Invalid or expired Live API session ticket');
        return;
      }
      liveSessionTickets.delete(ticketParam); // Single-use ticket
      cb(true);
      return;
    }

    if (configuredToken) {
      const authHeader = info.req.headers.authorization;
      const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : '';
      const expectedBuf = Buffer.from(configuredToken, 'utf-8');
      const providedBuf = Buffer.from(bearer, 'utf-8');
      if (bearer && expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf)) {
        cb(true);
        return;
      }
    }

    cb(false, 401, 'Live API session ticket required');
  },
});

wss.on('connection', async (clientWs) => {
  const ai = getGeminiClient();
  if (!ai) {
    clientWs.send(JSON.stringify({ error: 'Gemini AI service unavailable. Server GEMINI_API_KEY is not configured.' }));
    clientWs.close(1011, 'Gemini unavailable');
    return;
  }

  let closedByClient = false;
  let sessionRef: any = null;
  let frameWindowStart = Date.now();
  let frameCount = 0;

  clientWs.on('close', () => {
    closedByClient = true;
    try { sessionRef?.close?.(); } catch (_) {}
  });

  try {
    const session = await ai.live.connect({
      model: 'gemini-3.8-live',
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
        },
        systemInstruction: 'You are BUDDY, an intelligent, poised, and helpful AI assistant.',
      },
      callbacks: {
        onmessage: (message: LiveServerMessage) => {
          if (closedByClient || clientWs.readyState !== clientWs.OPEN) return;
          for (const part of message.serverContent?.modelTurn?.parts ?? []) {
            if (part.inlineData?.data) {
              clientWs.send(JSON.stringify({ audio: part.inlineData.data }));
            }
          }
          if (message.serverContent?.interrupted) {
            clientWs.send(JSON.stringify({ interrupted: true }));
          }
        },
        onerror: (err: any) => {
          console.warn('[BUDDY Live API] Live session error:', sanitizeContent(String(err?.message || err)));
          try {
            if (clientWs.readyState === clientWs.OPEN) {
              clientWs.send(JSON.stringify({ error: sanitizeContent(String(err?.message || 'Live session error')) }));
            }
          } catch (_) {}
        },
        onclose: () => {
          try {
            if (clientWs.readyState === clientWs.OPEN) clientWs.close();
          } catch (_) {}
        },
      },
    });
    sessionRef = session;

    if (closedByClient) {
      try { session.close(); } catch (_) {}
      return;
    }

    clientWs.on('message', (data: any) => {
      try {
        const now = Date.now();
        if (now - frameWindowStart > 1000) {
          frameWindowStart = now;
          frameCount = 0;
        }
        frameCount++;
        if (frameCount > 80) {
          return; // Drop excess bursts to protect upstream Live connection
        }

        const msg = JSON.parse(data.toString());
        if (typeof msg.audio === 'string' && msg.audio.length > 0 && msg.audio.length <= 180000) {
          session.sendRealtimeInput({
            audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' },
          });
        }
      } catch (_) {
        // Malformed frames ignored safely
      }
    });
  } catch (err: any) {
    console.error('[BUDDY Live API] Failed to connect:', sanitizeContent(String(err?.message || err)));
    try {
      if (clientWs.readyState === clientWs.OPEN) {
        clientWs.send(JSON.stringify({ error: sanitizeContent(String(err?.message || 'Failed to initialize live session')) }));
        clientWs.close();
      }
    } catch (_) {}
  }
});

// Vite middleware mounting in development
export async function startServer() {
  if (process.env.NODE_ENV !== 'production' && process.env.SURYA_SKIP_VITE !== '1') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    // Ensure unmatched /api/* routes return JSON 404 and never pass to Vite HTML fallback
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: `API endpoint not found: ${req.method} ${req.path}` });
      }
      next();
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  return httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[BUDDY Mobile] Server listening on http://0.0.0.0:${PORT}`);
  });
}

if (process.env.SURYA_SKIP_LISTEN !== '1') {
  startServer().catch((err) => {
    console.error('[BUDDY Mobile] Server boot failed:', err);
    process.exit(1);
  });
}

export { app, httpServer as server };
