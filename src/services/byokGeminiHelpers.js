/**
 * Pure BYOK Gemini API Key Vault & Direct Google Gemini REST Client Core
 * Shared across Android WebView (backed by Android Keystore), Web Browsers (backed by WebCrypto + IndexedDB),
 * and Node.js automated tests.
 *
 * SECURITY INVARIANT:
 * - Never stores API keys in plain-text localStorage or sessionStorage.
 * - Never embeds API keys in URL query strings (uses x-goog-api-key header).
 * - Never prints or echoes API keys in logs or thrown error messages.
 */

export const GEMINI_API_KEY_URL = 'https://aistudio.google.com/app/apikey';
export const GEMINI_REST_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const STORAGE_KEY_SELECTED_MODEL = 'buddy_selected_gemini_model_v1';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

export const SEED_GEMINI_MODELS = [
  {
    id: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    description: 'Recommended balanced fast model for everyday chat, tools, and multimodal tasks.',
    tier: 'Standard / Free & Paid',
  },
  {
    id: 'gemini-3.1-flash-lite',
    displayName: 'Gemini 3.1 Flash-Lite',
    description: 'Lightweight low-latency model suited for rapid mobile replies.',
    tier: 'Lightweight',
  },
  {
    id: 'gemini-3.8-pro',
    displayName: 'Gemini 3.8 Pro',
    description: 'Deep reasoning model for complex architecture, coding, and technical synthesis.',
    tier: 'Pro / Paid',
  },
];

export function isDeprecatedOrNonChatModel(modelId) {
  const id = String(modelId || '').replace(/^models\//, '').toLowerCase();
  if (!id) return true;
  if (
    id.startsWith('gemini-1.0') ||
    id.startsWith('gemini-1.5') ||
    id.startsWith('gemini-2.0') ||
    id === 'gemini-pro' ||
    id === 'gemini-pro-vision' ||
    id.includes('embedding') ||
    id.includes('aqa') ||
    id.includes('bisheng') ||
    id.includes('learnlm')
  ) {
    return true;
  }
  return false;
}

export function maskGeminiApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return '';
  const trimmed = apiKey.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '••••';
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

export function redactGeminiSecrets(input, knownApiKey = '') {
  let out = typeof input === 'string' ? input : input == null ? '' : String(input);
  if (!out) return '';
  if (knownApiKey && typeof knownApiKey === 'string') {
    const k = knownApiKey.trim();
    if (k.length >= 6) {
      out = out.split(k).join('[REDACTED_API_KEY]');
      const enc = encodeURIComponent(k);
      if (enc !== k) {
        out = out.split(enc).join('[REDACTED_API_KEY]');
      }
    }
  }
  out = out.replace(/AIza[0-9A-Za-z_-]{12,}/g, '[REDACTED_API_KEY]');
  return out;
}

export function validateGeminiApiKeyFormat(apiKey) {
  if (typeof apiKey !== 'string') {
    return { valid: false, reason: 'Enter your Gemini API key.' };
  }
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return { valid: false, reason: 'Gemini API key cannot be empty.' };
  }
  if (/\s/.test(trimmed)) {
    return { valid: false, reason: 'Gemini API key must not contain spaces or line breaks.' };
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return {
      valid: false,
      reason: 'That looks like a URL, not a Gemini API key. Paste the secret key from Google AI Studio.',
    };
  }
  if (trimmed.length < 20) {
    return { valid: false, reason: 'Gemini API key appears too short. Copy the full key from Google AI Studio.' };
  }
  return { valid: true, normalized: trimmed };
}

export class DirectGeminiError extends Error {
  constructor(message, opts = {}) {
    super(redactGeminiSecrets(message, opts.apiKey));
    this.name = 'DirectGeminiError';
    this.code = opts.code || 'GEMINI_ERROR';
    this.status = typeof opts.status === 'number' ? opts.status : null;
    this.retryable = Boolean(opts.retryable);
    this.model = opts.model || null;
  }
}

export function classifyDirectGeminiError({
  status = null,
  bodyText = '',
  model = null,
  timedOut = false,
  userAborted = false,
  err = null,
  apiKey = '',
} = {}) {
  if (userAborted) {
    return new DirectGeminiError('Request cancelled by operator.', {
      code: 'ABORTED',
      status: null,
      retryable: false,
      model,
      apiKey,
    });
  }

  if (timedOut || err?.name === 'TimeoutError') {
    return new DirectGeminiError(
      'Request to Google Gemini timed out. Check your internet connection and try again.',
      {
        code: 'TIMEOUT',
        status: null,
        retryable: true,
        model,
        apiKey,
      }
    );
  }

  if (err && status === null) {
    const rawDetail = redactGeminiSecrets(err?.message || 'Network request failed', apiKey);
    return new DirectGeminiError(
      `Unable to reach Google Gemini API (${rawDetail}). Verify internet connectivity.`,
      {
        code: 'NETWORK_ERROR',
        status: null,
        retryable: true,
        model,
        apiKey,
      }
    );
  }

  let parsed = null;
  if (bodyText && typeof bodyText === 'string') {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // ignore non-JSON body
    }
  }

  const upstreamError = parsed?.error || parsed || {};
  const upstreamMsg = redactGeminiSecrets(upstreamError?.message || bodyText || '', apiKey);
  const upstreamStatus = String(upstreamError?.status || '').toUpperCase();
  const detailText = JSON.stringify(upstreamError?.details || '');
  const combined = `${upstreamStatus} ${upstreamMsg} ${detailText}`.toUpperCase();

  if (
    status === 401 ||
    status === 403 ||
    combined.includes('API_KEY_INVALID') ||
    combined.includes('API KEY NOT VALID') ||
    combined.includes('PERMISSION_DENIED') ||
    combined.includes('UNAUTHENTICATED') ||
    combined.includes('INVALID_ARGUMENT') && combined.includes('API KEY')
  ) {
    return new DirectGeminiError(
      'Your Gemini API key was rejected by Google (invalid, revoked, or missing Gemini API access). Verify or replace your key in Gemini Settings.',
      {
        code: 'INVALID_API_KEY',
        status: status || 401,
        retryable: false,
        model,
        apiKey,
      }
    );
  }

  if (
    status === 404 ||
    upstreamStatus === 'NOT_FOUND' ||
    combined.includes('IS NOT FOUND') ||
    combined.includes('NOT SUPPORTED FOR GENERATECONTENT') ||
    combined.includes('NO LONGER AVAILABLE') ||
    combined.includes('DEPRECATED')
  ) {
    const cleanModel = model || 'selected model';
    return new DirectGeminiError(
      `Model "${cleanModel}" is unavailable or not enabled for your API key (${status || 404}). Select a verified model or refresh models in Gemini Settings.`,
      {
        code: 'MODEL_UNAVAILABLE',
        status: status || 404,
        retryable: false,
        model,
        apiKey,
      }
    );
  }

  if (status === 429 || upstreamStatus === 'RESOURCE_EXHAUSTED' || combined.includes('QUOTA')) {
    const isQuota = combined.includes('QUOTA') || combined.includes('BILLING') || combined.includes('EXHAUSTED');
    return new DirectGeminiError(
      isQuota
        ? 'Your Gemini API quota is exhausted for this key/project. Check your Google AI Studio quota or switch to a lighter verified model.'
        : 'Gemini API rate limit reached (HTTP 429). Wait a few seconds and try again.',
      {
        code: isQuota ? 'QUOTA_EXHAUSTED' : 'RATE_LIMITED',
        status: 429,
        retryable: !isQuota,
        model,
        apiKey,
      }
    );
  }

  if (status === 400) {
    return new DirectGeminiError(
      upstreamMsg ? `Gemini request error: ${upstreamMsg}` : 'Gemini rejected the request payload (HTTP 400).',
      {
        code: 'BAD_REQUEST',
        status: 400,
        retryable: false,
        model,
        apiKey,
      }
    );
  }

  if (status >= 500) {
    return new DirectGeminiError(
      `Google Gemini service is temporarily unavailable (HTTP ${status}). Try again shortly.`,
      {
        code: 'UPSTREAM_ERROR',
        status,
        retryable: true,
        model,
        apiKey,
      }
    );
  }

  return new DirectGeminiError(
    upstreamMsg || `Gemini API request failed (HTTP ${status || 'unknown'}).`,
    {
      code: 'GEMINI_ERROR',
      status,
      retryable: false,
      model,
      apiKey,
    }
  );
}

export function buildBuddySystemInstruction(opts = {}) {
  const responseMode = opts.responseMode === 'detailed' ? 'detailed' : 'concise';
  const languageHint =
    opts.preferredLanguage && opts.preferredLanguage !== 'auto'
      ? `Respond primarily in language "${opts.preferredLanguage}" unless the user explicitly writes in another language.`
      : 'Respond in the same language the user uses (English, Hindi, Hinglish, or regional language).';

  const parts = [
    'You are BUDDY, a helpful, accurate, respectful personal AI assistant.',
    responseMode === 'concise'
      ? 'Keep answers concise, clear, and direct.'
      : 'Provide thorough, well-structured explanations when helpful.',
    languageHint,
    'Never invent capabilities, file paths, or API results you did not observe.',
  ];

  if (Array.isArray(opts.userMemories) && opts.userMemories.length > 0) {
    const memLines = opts.userMemories
      .slice(0, 8)
      .map((m) => `- ${m.key}: ${m.value}`)
      .join('\n');
    parts.push(`User-approved personal context:\n${memLines}`);
  }

  if (opts.deviceContext && typeof opts.deviceContext === 'object') {
    const dc = opts.deviceContext;
    const hints = [];
    if (typeof dc.batteryLevel === 'number') hints.push(`Battery ${dc.batteryLevel}%`);
    if (dc.networkType) hints.push(`Network ${dc.networkType}`);
    if (dc.activeTab) hints.push(`Active workspace ${dc.activeTab}`);
    if (hints.length > 0) {
      parts.push(`Device context: ${hints.join(', ')}.`);
    }
  }

  return parts.join('\n');
}

export function buildGeminiGenerateBody({
  message,
  history = [],
  systemInstruction,
  responseMode = 'concise',
  preferredLanguage = 'auto',
  userMemories = [],
  deviceContext = null,
  imageBase64 = null,
  maxOutputTokens,
  temperature,
  responseMimeType,
} = {}) {
  const contents = [];

  if (Array.isArray(history)) {
    const filtered = history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-16);

    for (const msg of filtered) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      // Collapse consecutive same-role entries so Gemini contents stay strictly alternating
      if (contents.length > 0 && contents[contents.length - 1].role === role) {
        contents[contents.length - 1].parts[0].text += `\n${msg.content.trim()}`;
      } else {
        contents.push({
          role,
          parts: [{ text: msg.content.trim() }],
        });
      }
    }
  }

  const userParts = [];
  if (imageBase64 && typeof imageBase64 === 'string') {
    const dataUrlMatch = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
    const mimeType = dataUrlMatch ? dataUrlMatch[1] : 'image/jpeg';
    const rawData = dataUrlMatch ? dataUrlMatch[2] : imageBase64.replace(/^data:[^,]+,/, '');
    if (rawData) {
      userParts.push({
        inline_data: {
          mime_type: mimeType,
          data: rawData,
        },
      });
    }
  }
  userParts.push({ text: String(message || '').trim() });

  if (contents.length > 0 && contents[contents.length - 1].role === 'user') {
    contents[contents.length - 1].parts.push(...userParts);
  } else {
    contents.push({
      role: 'user',
      parts: userParts,
    });
  }

  const resolvedSys =
    systemInstruction ||
    buildBuddySystemInstruction({
      responseMode,
      preferredLanguage,
      userMemories,
      deviceContext,
    });

  const generationConfig = {};
  if (typeof maxOutputTokens === 'number') generationConfig.maxOutputTokens = maxOutputTokens;
  if (typeof temperature === 'number') generationConfig.temperature = temperature;
  if (responseMimeType) generationConfig.responseMimeType = responseMimeType;

  const body = {
    system_instruction: {
      parts: [{ text: resolvedSys }],
    },
    contents,
  };

  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }

  return body;
}

export function extractGeminiResponseText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = payload.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('');
}

export async function parseGeminiSseResponse(response, { onChunk, apiKey = '', model = '' } = {}) {
  const ct = (response.headers?.get?.('content-type') || '').toLowerCase();

  if (!response.body || typeof response.body.getReader !== 'function' || ct.includes('application/json')) {
    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      throw new DirectGeminiError('Received unexpected non-JSON response from Gemini API.', {
        code: 'INVALID_RESPONSE',
        status: response.status,
        model,
        apiKey,
      });
    }
    if (Array.isArray(parsed)) {
      let acc = '';
      for (const frame of parsed) {
        if (frame?.error) {
          throw classifyDirectGeminiError({
            status: frame.error.code || 400,
            bodyText: JSON.stringify(frame),
            model,
            apiKey,
          });
        }
        const chunk = extractGeminiResponseText(frame);
        if (chunk) {
          acc += chunk;
          onChunk?.(acc);
        }
      }
      return acc;
    }
    if (parsed?.error) {
      throw classifyDirectGeminiError({
        status: parsed.error.code || 400,
        bodyText: JSON.stringify(parsed),
        model,
        apiKey,
      });
    }
    const text = extractGeminiResponseText(parsed);
    if (text) onChunk?.(text);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let accumulated = '';

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) return;
    const dataPayload = trimmed.slice(5).trim();
    if (!dataPayload || dataPayload === '[DONE]') return;

    let frame;
    try {
      frame = JSON.parse(dataPayload);
    } catch {
      return;
    }

    if (frame?.error) {
      throw classifyDirectGeminiError({
        status: frame.error.code || 400,
        bodyText: JSON.stringify(frame),
        model,
        apiKey,
      });
    }

    const delta = extractGeminiResponseText(frame);
    if (delta) {
      accumulated += delta;
      onChunk?.(accumulated);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      processLine(line);
    }
  }

  if (buffer.trim()) {
    processLine(buffer);
  }

  return accumulated;
}

/**
 * Browser WebCrypto AES-256-GCM + IndexedDB encrypted key adapter.
 * Stores non-extractable CryptoKey in IndexedDB and encrypts the user's Gemini API key before persistence.
 * Never writes any key material to localStorage or sessionStorage.
 */
export function createIndexedDbWebCryptoAdapter() {
  const DB_NAME = 'buddy_secure_vault_db';
  const DB_VERSION = 1;
  const STORE_NAME = 'keystore';
  const CRYPTO_KEY_RECORD = 'aes_master_key';
  const CIPHER_RECORD = 'encrypted_gemini_key';

  const isSupported = () =>
    typeof window !== 'undefined' &&
    typeof window.indexedDB !== 'undefined' &&
    typeof window.crypto !== 'undefined' &&
    typeof window.crypto.subtle !== 'undefined';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'));
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        db.close();
        resolve(req.result ?? null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  }

  async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(value, key);
      req.onsuccess = () => {
        db.close();
        resolve(true);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  }

  async function idbDelete(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(key);
      req.onsuccess = () => {
        db.close();
        resolve(true);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  }

  async function getOrCreateAesKey() {
    const existing = await idbGet(CRYPTO_KEY_RECORD);
    if (existing) return existing;
    const generated = await window.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable
      ['encrypt', 'decrypt']
    );
    await idbSet(CRYPTO_KEY_RECORD, generated);
    return generated;
  }

  return {
    isSupported,
    async saveKey(apiKey) {
      if (!isSupported()) return false;
      const aesKey = await getOrCreateAesKey();
      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const encoded = new TextEncoder().encode(apiKey);
      const cipherBuf = await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        encoded
      );
      await idbSet(CIPHER_RECORD, {
        iv: Array.from(iv),
        ciphertext: Array.from(new Uint8Array(cipherBuf)),
        updatedAt: new Date().toISOString(),
      });
      return true;
    },
    async getKey() {
      if (!isSupported()) return '';
      const rec = await idbGet(CIPHER_RECORD);
      if (!rec || !Array.isArray(rec.iv) || !Array.isArray(rec.ciphertext)) {
        return '';
      }
      const aesKey = await idbGet(CRYPTO_KEY_RECORD);
      if (!aesKey) return '';
      try {
        const plainBuf = await window.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: new Uint8Array(rec.iv) },
          aesKey,
          new Uint8Array(rec.ciphertext)
        );
        return new TextDecoder().decode(plainBuf);
      } catch {
        return '';
      }
    },
    async hasKey() {
      if (!isSupported()) return false;
      const rec = await idbGet(CIPHER_RECORD);
      return Boolean(rec && Array.isArray(rec.ciphertext) && rec.ciphertext.length > 0);
    },
    async removeKey() {
      if (!isSupported()) return false;
      await idbDelete(CIPHER_RECORD);
      return true;
    },
  };
}

/**
 * Unified Secure Gemini Key Vault
 * Manages encrypted key persistence (Android Keystore -> WebCrypto IndexedDB -> Memory)
 * and honest model/verification metadata without touching localStorage for key secrets.
 */
export class GeminiKeyVault {
  constructor(options = {}) {
    this.nativeBridgeProvider =
      options.nativeBridgeProvider ||
      (() => (typeof window !== 'undefined' ? window.AndroidSuryaBridge || null : null));
    this.webCryptoAdapter = options.webCryptoAdapter || createIndexedDbWebCryptoAdapter();
    this.modelStorage =
      options.modelStorage ||
      (typeof window !== 'undefined' && window.localStorage ? window.localStorage : null);

    // Ephemeral in-memory fallback (used ONLY if neither Android Keystore nor WebCrypto IndexedDB exists, or in unit tests)
    this.memoryKey = '';
    this.listeners = new Set();

    let initialModel = DEFAULT_GEMINI_MODEL;
    if (this.modelStorage) {
      try {
        const saved = this.modelStorage.getItem(STORAGE_KEY_SELECTED_MODEL);
        if (saved && saved.trim() && !isDeprecatedOrNonChatModel(saved)) {
          initialModel = saved.trim();
        }
      } catch {}
    }

    this.state = {
      hydrated: false,
      hasKey: false,
      maskedKey: '',
      storageBackend: 'memory',
      selectedModel: initialModel,
      verificationState: 'unconfigured', // 'unconfigured' | 'unverified' | 'verifying' | 'verified' | 'invalid_key' | 'quota_exceeded' | 'model_unavailable' | 'network_error'
      verifiedModel: null,
      lastVerifiedAt: null,
      lastError: null,
      verifiedModels: [],
      unavailableModels: {},
      discoveredModels: [],
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot() {
    return {
      ...this.state,
      verifiedModels: [...this.state.verifiedModels],
      unavailableModels: { ...this.state.unavailableModels },
      discoveredModels: [...this.state.discoveredModels],
    };
  }

  notify() {
    const snap = this.getSnapshot();
    for (const cb of this.listeners) {
      try {
        cb(snap);
      } catch {}
    }
  }

  detectStorageBackend() {
    const bridge = this.nativeBridgeProvider();
    if (
      bridge &&
      typeof bridge.saveGeminiApiKey === 'function' &&
      typeof bridge.hasGeminiApiKey === 'function' &&
      typeof bridge.getGeminiApiKey === 'function'
    ) {
      return 'android-keystore';
    }
    if (this.webCryptoAdapter && this.webCryptoAdapter.isSupported()) {
      return 'webcrypto-indexeddb';
    }
    return 'memory';
  }

  async hydrate() {
    const backend = this.detectStorageBackend();
    let hasKey = false;
    let maskedKey = '';

    if (backend === 'android-keystore') {
      const bridge = this.nativeBridgeProvider();
      hasKey = Boolean(bridge.hasGeminiApiKey());
      if (hasKey) {
        maskedKey =
          typeof bridge.getMaskedGeminiApiKey === 'function'
            ? String(bridge.getMaskedGeminiApiKey() || '')
            : maskGeminiApiKey(String(bridge.getGeminiApiKey() || ''));
      }
    } else if (backend === 'webcrypto-indexeddb') {
      hasKey = await this.webCryptoAdapter.hasKey();
      if (hasKey) {
        const key = await this.webCryptoAdapter.getKey();
        hasKey = Boolean(key);
        maskedKey = maskGeminiApiKey(key);
      }
    } else {
      hasKey = Boolean(this.memoryKey);
      maskedKey = maskGeminiApiKey(this.memoryKey);
    }

    this.state = {
      ...this.state,
      hydrated: true,
      storageBackend: backend,
      hasKey,
      maskedKey,
      verificationState: !hasKey
        ? 'unconfigured'
        : this.state.verificationState === 'unconfigured'
        ? 'unverified'
        : this.state.verificationState,
    };
    this.notify();
    return this.getSnapshot();
  }

  async saveKey(rawKey) {
    const check = validateGeminiApiKeyFormat(rawKey);
    if (!check.valid) {
      throw new DirectGeminiError(check.reason, { code: 'INVALID_KEY_FORMAT', apiKey: rawKey });
    }
    const cleanKey = check.normalized;
    const backend = this.detectStorageBackend();

    if (backend === 'android-keystore') {
      const bridge = this.nativeBridgeProvider();
      const ok = Boolean(bridge.saveGeminiApiKey(cleanKey));
      if (!ok) {
        throw new DirectGeminiError('Android Keystore encryption failed while saving API key.', {
          code: 'KEYSTORE_ERROR',
          apiKey: cleanKey,
        });
      }
    } else if (backend === 'webcrypto-indexeddb') {
      await this.webCryptoAdapter.saveKey(cleanKey);
    } else {
      this.memoryKey = cleanKey;
    }

    this.state = {
      ...this.state,
      hydrated: true,
      storageBackend: backend,
      hasKey: true,
      maskedKey: maskGeminiApiKey(cleanKey),
      verificationState: 'unverified',
      verifiedModel: null,
      lastError: null,
      verifiedModels: [],
      unavailableModels: {},
    };
    this.notify();
    return this.getSnapshot();
  }

  async getKey() {
    const backend = this.detectStorageBackend();
    if (backend === 'android-keystore') {
      const bridge = this.nativeBridgeProvider();
      return String(bridge.getGeminiApiKey() || '').trim();
    }
    if (backend === 'webcrypto-indexeddb') {
      const k = await this.webCryptoAdapter.getKey();
      return String(k || '').trim();
    }
    return String(this.memoryKey || '').trim();
  }

  async hasKey() {
    const backend = this.detectStorageBackend();
    if (backend === 'android-keystore') {
      const bridge = this.nativeBridgeProvider();
      return Boolean(bridge.hasGeminiApiKey());
    }
    if (backend === 'webcrypto-indexeddb') {
      return Boolean(await this.webCryptoAdapter.hasKey());
    }
    return Boolean(this.memoryKey);
  }

  async removeKey() {
    const backend = this.detectStorageBackend();
    if (backend === 'android-keystore') {
      const bridge = this.nativeBridgeProvider();
      if (typeof bridge.removeGeminiApiKey === 'function') {
        bridge.removeGeminiApiKey();
      } else {
        bridge.saveGeminiApiKey('');
      }
    } else if (backend === 'webcrypto-indexeddb') {
      await this.webCryptoAdapter.removeKey();
    }
    this.memoryKey = '';

    this.state = {
      ...this.state,
      hydrated: true,
      storageBackend: backend,
      hasKey: false,
      maskedKey: '',
      verificationState: 'unconfigured',
      verifiedModel: null,
      lastVerifiedAt: null,
      lastError: null,
      verifiedModels: [],
      unavailableModels: {},
      discoveredModels: [],
    };
    this.notify();
    return this.getSnapshot();
  }

  setSelectedModel(modelId) {
    const cleaned = String(modelId || '').trim().replace(/^models\//, '');
    if (!cleaned || isDeprecatedOrNonChatModel(cleaned)) {
      throw new DirectGeminiError('Selected Gemini model ID is invalid or deprecated.', {
        code: 'MODEL_UNAVAILABLE',
        model: cleaned,
      });
    }
    if (this.modelStorage) {
      try {
        this.modelStorage.setItem(STORAGE_KEY_SELECTED_MODEL, cleaned);
      } catch {}
    }

    const isModelAlreadyVerified = this.state.verifiedModels.includes(cleaned);
    this.state = {
      ...this.state,
      selectedModel: cleaned,
      verificationState: !this.state.hasKey
        ? 'unconfigured'
        : isModelAlreadyVerified
        ? 'verified'
        : 'unverified',
      lastError: null,
    };
    this.notify();
    return cleaned;
  }

  updateVerificationStatus(patch = {}) {
    this.state = {
      ...this.state,
      ...patch,
      lastError: patch.lastError ? redactGeminiSecrets(patch.lastError) : patch.lastError === null ? null : this.state.lastError,
    };
    this.notify();
  }

  getAvailableModels() {
    const byId = new Map();
    for (const seed of SEED_GEMINI_MODELS) {
      byId.set(seed.id, { ...seed });
    }
    for (const disc of this.state.discoveredModels) {
      if (!disc?.id || isDeprecatedOrNonChatModel(disc.id)) continue;
      if (!byId.has(disc.id)) {
        byId.set(disc.id, {
          id: disc.id,
          displayName: disc.displayName || disc.id,
          description: disc.description || 'Verified from your Google Gemini API account.',
          tier: 'Account Model',
        });
      }
    }

    return Array.from(byId.values()).map((m) => ({
      ...m,
      isVerified: this.state.verifiedModels.includes(m.id),
      unavailableReason: this.state.unavailableModels[m.id] || null,
    }));
  }
}

/**
 * Direct Client-to-Gemini REST API Transport
 * Calls https://generativelanguage.googleapis.com/v1beta directly with the user's own BYOK API key.
 */
export class DirectGeminiClient {
  constructor(options = {}) {
    this.vault = options.vault || new GeminiKeyVault();
    this.fetcher = options.fetcher || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    this.baseUrl = options.baseUrl || GEMINI_REST_BASE_URL;
  }

  async fetchWithAbort(url, init, timeoutMs, externalSignal) {
    if (!this.fetcher) {
      throw new DirectGeminiError('Fetch API unavailable in this environment.', {
        code: 'NETWORK_ERROR',
      });
    }
    const controller = new AbortController();
    let timedOut = false;
    let userAborted = false;

    const onExtAbort = () => {
      userAborted = true;
      controller.abort();
    };
    if (externalSignal) {
      if (externalSignal.aborted) {
        userAborted = true;
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', onExtAbort, { once: true });
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      return await this.fetcher(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (err) {
      throw classifyDirectGeminiError({
        err,
        timedOut,
        userAborted,
      });
    } finally {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExtAbort);
      }
    }
  }

  async resolveApiKey(explicitKey) {
    if (explicitKey && typeof explicitKey === 'string' && explicitKey.trim()) {
      const check = validateGeminiApiKeyFormat(explicitKey);
      if (!check.valid) {
        throw new DirectGeminiError(check.reason, { code: 'INVALID_KEY_FORMAT', apiKey: explicitKey });
      }
      return check.normalized;
    }
    const stored = await this.vault.getKey();
    if (!stored) {
      throw new DirectGeminiError(
        'Gemini API key is not configured. Add your Gemini API key in Settings to enable online AI.',
        { code: 'GEMINI_KEY_MISSING' }
      );
    }
    return stored;
  }

  async listAvailableModels(explicitKey) {
    const apiKey = await this.resolveApiKey(explicitKey);
    const url = `${this.baseUrl}/models?pageSize=50`;
    const res = await this.fetchWithAbort(
      url,
      {
        method: 'GET',
        headers: {
          'x-goog-api-key': apiKey,
        },
      },
      15000
    );

    const bodyText = await res.text();
    if (!res.ok) {
      throw classifyDirectGeminiError({
        status: res.status,
        bodyText,
        apiKey,
      });
    }

    let parsed = {};
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return [];
    }

    const rawModels = Array.isArray(parsed.models) ? parsed.models : [];
    const usable = rawModels
      .filter((m) => {
        const id = String(m?.name || '').replace(/^models\//, '');
        const methods = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
        return id.startsWith('gemini-') && !isDeprecatedOrNonChatModel(id) && methods.includes('generateContent');
      })
      .map((m) => {
        const id = String(m.name).replace(/^models\//, '');
        return {
          id,
          displayName: m.displayName || id,
          description: m.description || '',
        };
      });

    if (!explicitKey || explicitKey.trim() === (await this.vault.getKey())) {
      const existingVerified = new Set(this.vault.getSnapshot().verifiedModels);
      usable.forEach((m) => existingVerified.add(m.id));
      this.vault.updateVerificationStatus({
        discoveredModels: usable,
        verifiedModels: Array.from(existingVerified),
      });
    }

    return usable;
  }

  async verifyApiKey({ apiKey: explicitKey, model } = {}) {
    const targetModel = (model || this.vault.getSnapshot().selectedModel || DEFAULT_GEMINI_MODEL)
      .trim()
      .replace(/^models\//, '');
    const startedAt = Date.now();
    const apiKey = await this.resolveApiKey(explicitKey);
    const usingStoredKey = !explicitKey || explicitKey.trim() === (await this.vault.getKey());

    if (usingStoredKey) {
      this.vault.updateVerificationStatus({ verificationState: 'verifying', lastError: null });
    }

    const url = `${this.baseUrl}/models/${encodeURIComponent(targetModel)}:generateContent`;
    try {
      const res = await this.fetchWithAbort(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Reply with OK' }] }],
            generationConfig: { maxOutputTokens: 12, temperature: 0 },
          }),
        },
        20000
      );

      const textBody = await res.text();
      if (!res.ok) {
        const gemErr = classifyDirectGeminiError({
          status: res.status,
          bodyText: textBody,
          model: targetModel,
          apiKey,
        });
        if (usingStoredKey) {
          this.handleVaultErrorUpdate(gemErr, targetModel);
        }
        throw gemErr;
      }

      let parsed = {};
      try {
        parsed = JSON.parse(textBody);
      } catch {}

      const replyText = extractGeminiResponseText(parsed) || 'OK';

      // Opportunistically refresh supported models list using same verified key
      let discovered = [];
      try {
        discovered = await this.listAvailableModels(apiKey);
      } catch {
        // Non-fatal if list endpoint is restricted; direct generateContent already succeeded
      }

      if (usingStoredKey) {
        const cur = this.vault.getSnapshot();
        const verifiedSet = new Set([...cur.verifiedModels, targetModel]);
        const nextUnavailable = { ...cur.unavailableModels };
        delete nextUnavailable[targetModel];
        this.vault.updateVerificationStatus({
          verificationState: 'verified',
          verifiedModel: targetModel,
          lastVerifiedAt: new Date().toISOString(),
          lastError: null,
          verifiedModels: Array.from(verifiedSet),
          unavailableModels: nextUnavailable,
          discoveredModels: discovered.length > 0 ? discovered : cur.discoveredModels,
        });
      }

      return {
        valid: true,
        model: targetModel,
        latencyMs: Date.now() - startedAt,
        response: replyText,
        discoveredModels: discovered,
      };
    } catch (err) {
      const gemErr =
        err instanceof DirectGeminiError
          ? err
          : classifyDirectGeminiError({ err, model: targetModel, apiKey });
      if (usingStoredKey) {
        this.handleVaultErrorUpdate(gemErr, targetModel);
      }
      throw gemErr;
    }
  }

  handleVaultErrorUpdate(gemErr, model) {
    const cur = this.vault.getSnapshot();
    const nextUnavailable = { ...cur.unavailableModels };
    let nextVerifiedModels = [...cur.verifiedModels];
    let verificationState = cur.verificationState;

    if (gemErr.code === 'INVALID_API_KEY') {
      verificationState = 'invalid_key';
    } else if (gemErr.code === 'QUOTA_EXHAUSTED' || gemErr.code === 'RATE_LIMITED') {
      verificationState = 'quota_exceeded';
    } else if (gemErr.code === 'MODEL_UNAVAILABLE') {
      verificationState = 'model_unavailable';
      if (model) {
        nextUnavailable[model] = gemErr.message;
        nextVerifiedModels = nextVerifiedModels.filter((m) => m !== model);
      }
    } else if (gemErr.code === 'TIMEOUT' || gemErr.code === 'NETWORK_ERROR') {
      verificationState = 'network_error';
    }

    this.vault.updateVerificationStatus({
      verificationState,
      lastError: gemErr.message,
      verifiedModels: nextVerifiedModels,
      unavailableModels: nextUnavailable,
    });
  }

  async sendChatStream(message, history = [], onChunk, options = {}) {
    const apiKey = await this.resolveApiKey(options.apiKey);
    const model = (options.model || this.vault.getSnapshot().selectedModel || DEFAULT_GEMINI_MODEL)
      .trim()
      .replace(/^models\//, '');
    const startMs = Date.now();
    let ttftMs;

    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const body = buildGeminiGenerateBody({
      message,
      history,
      systemInstruction: options.systemInstruction,
      responseMode: options.responseMode || (options.fastMode ? 'concise' : 'detailed'),
      preferredLanguage: options.preferredLanguage || 'auto',
      userMemories: options.userMemories || [],
      deviceContext: options.deviceContext || null,
      maxOutputTokens: options.maxOutputTokens,
      temperature: options.temperature,
      responseMimeType: options.responseMimeType,
    });

    try {
      const res = await this.fetchWithAbort(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(body),
        },
        options.timeoutMs || 60000,
        options.signal
      );

      if (!res.ok) {
        const errText = await res.text();
        const gemErr = classifyDirectGeminiError({
          status: res.status,
          bodyText: errText,
          model,
          apiKey,
        });
        this.handleVaultErrorUpdate(gemErr, model);
        throw gemErr;
      }

      const fullText = await parseGeminiSseResponse(res, {
        model,
        apiKey,
        onChunk: (acc) => {
          if (ttftMs === undefined) {
            ttftMs = Date.now() - startMs;
          }
          onChunk?.(acc);
        },
      });

      const cur = this.vault.getSnapshot();
      const verifiedSet = new Set([...cur.verifiedModels, model]);
      this.vault.updateVerificationStatus({
        verificationState: 'verified',
        verifiedModel: model,
        lastVerifiedAt: new Date().toISOString(),
        lastError: null,
        verifiedModels: Array.from(verifiedSet),
      });

      return {
        text: fullText || '',
        model,
        latencyMs: Date.now() - startMs,
        ttftMs,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      const gemErr =
        err instanceof DirectGeminiError
          ? err
          : classifyDirectGeminiError({ err, model, apiKey });
      this.handleVaultErrorUpdate(gemErr, model);
      throw gemErr;
    }
  }

  async sendChat(message, history = [], options = {}) {
    const apiKey = await this.resolveApiKey(options.apiKey);
    const model = (options.model || this.vault.getSnapshot().selectedModel || DEFAULT_GEMINI_MODEL)
      .trim()
      .replace(/^models\//, '');
    const startMs = Date.now();
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    const body = buildGeminiGenerateBody({
      message,
      history,
      systemInstruction: options.systemInstruction,
      responseMode: options.responseMode || (options.fastMode ? 'concise' : 'detailed'),
      preferredLanguage: options.preferredLanguage || 'auto',
      userMemories: options.userMemories || [],
      deviceContext: options.deviceContext || null,
      imageBase64: options.imageBase64 || null,
      maxOutputTokens: options.maxOutputTokens,
      temperature: options.temperature,
      responseMimeType: options.responseMimeType,
    });

    try {
      const res = await this.fetchWithAbort(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(body),
        },
        options.timeoutMs || 45000,
        options.signal
      );

      const textBody = await res.text();
      if (!res.ok) {
        const gemErr = classifyDirectGeminiError({
          status: res.status,
          bodyText: textBody,
          model,
          apiKey,
        });
        this.handleVaultErrorUpdate(gemErr, model);
        throw gemErr;
      }

      let parsed = {};
      try {
        parsed = JSON.parse(textBody);
      } catch {
        throw new DirectGeminiError('Received invalid JSON from Google Gemini API.', {
          code: 'INVALID_RESPONSE',
          status: res.status,
          model,
          apiKey,
        });
      }

      const replyText = extractGeminiResponseText(parsed);
      const cur = this.vault.getSnapshot();
      const verifiedSet = new Set([...cur.verifiedModels, model]);
      this.vault.updateVerificationStatus({
        verificationState: 'verified',
        verifiedModel: model,
        lastVerifiedAt: new Date().toISOString(),
        lastError: null,
        verifiedModels: Array.from(verifiedSet),
      });

      return {
        text: replyText,
        model,
        latencyMs: Date.now() - startMs,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      const gemErr =
        err instanceof DirectGeminiError
          ? err
          : classifyDirectGeminiError({ err, model, apiKey });
      this.handleVaultErrorUpdate(gemErr, model);
      throw gemErr;
    }
  }
}
