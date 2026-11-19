export const GEMINI_API_KEY_URL: string;
export const GEMINI_REST_BASE_URL: string;
export const STORAGE_KEY_SELECTED_MODEL: string;
export const DEFAULT_GEMINI_MODEL: string;

export type KeyVaultStorageBackend = 'android-keystore' | 'webcrypto-indexeddb' | 'memory';

export type GeminiVerificationState =
  | 'unconfigured'
  | 'unverified'
  | 'verifying'
  | 'verified'
  | 'invalid_key'
  | 'quota_exceeded'
  | 'model_unavailable'
  | 'network_error';

export interface GeminiModelCatalogEntry {
  id: string;
  displayName: string;
  description: string;
  tier: string;
  isVerified?: boolean;
  unavailableReason?: string | null;
}

export interface GeminiKeyVaultSnapshot {
  hydrated: boolean;
  hasKey: boolean;
  maskedKey: string;
  storageBackend: KeyVaultStorageBackend;
  selectedModel: string;
  verificationState: GeminiVerificationState;
  verifiedModel: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
  verifiedModels: string[];
  unavailableModels: Record<string, string>;
  discoveredModels: { id: string; displayName: string; description: string }[];
}

export const SEED_GEMINI_MODELS: GeminiModelCatalogEntry[];

export function isDeprecatedOrNonChatModel(modelId: string): boolean;
export function maskGeminiApiKey(apiKey: string): string;
export function redactGeminiSecrets(input: unknown, knownApiKey?: string): string;
export function validateGeminiApiKeyFormat(apiKey: string): { valid: boolean; normalized?: string; reason?: string };

export class DirectGeminiError extends Error {
  code: string;
  status: number | null;
  retryable: boolean;
  model: string | null;
  constructor(
    message: string,
    opts?: { code?: string; status?: number | null; retryable?: boolean; model?: string | null; apiKey?: string }
  );
}

export function classifyDirectGeminiError(opts?: {
  status?: number | null;
  bodyText?: string;
  model?: string | null;
  timedOut?: boolean;
  userAborted?: boolean;
  err?: unknown;
  apiKey?: string;
}): DirectGeminiError;

export function buildBuddySystemInstruction(opts?: {
  responseMode?: 'concise' | 'detailed';
  preferredLanguage?: string;
  userMemories?: { key: string; value: string; category?: string }[];
  deviceContext?: Record<string, unknown> | null;
}): string;

export function buildGeminiGenerateBody(opts?: {
  message?: string;
  history?: { role: string; content: string }[];
  systemInstruction?: string;
  responseMode?: 'concise' | 'detailed';
  preferredLanguage?: string;
  userMemories?: { key: string; value: string; category?: string }[];
  deviceContext?: Record<string, unknown> | null;
  imageBase64?: string | null;
  maxOutputTokens?: number;
  temperature?: number;
  responseMimeType?: string;
}): Record<string, unknown>;

export function extractGeminiResponseText(payload: unknown): string;

export function parseGeminiSseResponse(
  response: Response,
  opts?: { onChunk?: (accumulated: string) => void; apiKey?: string; model?: string }
): Promise<string>;

export function createIndexedDbWebCryptoAdapter(): {
  isSupported: () => boolean;
  saveKey: (apiKey: string) => Promise<boolean>;
  getKey: () => Promise<string>;
  hasKey: () => Promise<boolean>;
  removeKey: () => Promise<boolean>;
};

export class GeminiKeyVault {
  constructor(options?: {
    nativeBridgeProvider?: () => unknown;
    webCryptoAdapter?: unknown;
    modelStorage?: Storage | null;
  });
  subscribe(listener: (snapshot: GeminiKeyVaultSnapshot) => void): () => void;
  getSnapshot(): GeminiKeyVaultSnapshot;
  detectStorageBackend(): KeyVaultStorageBackend;
  hydrate(): Promise<GeminiKeyVaultSnapshot>;
  saveKey(rawKey: string): Promise<GeminiKeyVaultSnapshot>;
  getKey(): Promise<string>;
  hasKey(): Promise<boolean>;
  removeKey(): Promise<GeminiKeyVaultSnapshot>;
  setSelectedModel(modelId: string): string;
  updateVerificationStatus(patch?: Partial<GeminiKeyVaultSnapshot>): void;
  getAvailableModels(): GeminiModelCatalogEntry[];
}

export class DirectGeminiClient {
  constructor(options?: { vault?: GeminiKeyVault; fetcher?: typeof fetch; baseUrl?: string });
  listAvailableModels(explicitKey?: string): Promise<{ id: string; displayName: string; description: string }[]>;
  verifyApiKey(opts?: { apiKey?: string; model?: string }): Promise<{
    valid: boolean;
    model: string;
    latencyMs: number;
    response: string;
    discoveredModels: { id: string; displayName: string; description: string }[];
  }>;
  sendChatStream(
    message: string,
    history: { role: string; content: string }[],
    onChunk?: (accumulated: string) => void,
    options?: {
      apiKey?: string;
      model?: string;
      fastMode?: boolean;
      responseMode?: 'concise' | 'detailed';
      preferredLanguage?: string;
      userMemories?: { key: string; value: string; category?: string }[];
      deviceContext?: Record<string, unknown> | null;
      systemInstruction?: string;
      maxOutputTokens?: number;
      temperature?: number;
      responseMimeType?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    }
  ): Promise<{
    text: string;
    model: string;
    latencyMs: number;
    ttftMs?: number;
    timestamp: string;
  }>;
  sendChat(
    message: string,
    history?: { role: string; content: string }[],
    options?: {
      apiKey?: string;
      model?: string;
      fastMode?: boolean;
      responseMode?: 'concise' | 'detailed';
      preferredLanguage?: string;
      userMemories?: { key: string; value: string; category?: string }[];
      deviceContext?: Record<string, unknown> | null;
      imageBase64?: string | null;
      systemInstruction?: string;
      maxOutputTokens?: number;
      temperature?: number;
      responseMimeType?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    }
  ): Promise<{
    text: string;
    model: string;
    latencyMs: number;
    timestamp: string;
  }>;
}
