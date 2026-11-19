/**
 * BUDDY Gemini BYOK Key Vault Singleton
 * Persists user-owned Gemini API keys securely via Android Keystore on Android
 * or WebCrypto AES-256-GCM + IndexedDB in web browsers — never plain-text localStorage.
 */

import {
  GeminiKeyVault,
  GeminiKeyVaultSnapshot,
  GeminiModelCatalogEntry,
  GeminiVerificationState,
  KeyVaultStorageBackend,
  GEMINI_API_KEY_URL,
  DEFAULT_GEMINI_MODEL,
  maskGeminiApiKey,
  redactGeminiSecrets,
  validateGeminiApiKeyFormat,
} from './byokGeminiHelpers.js';

export type {
  GeminiKeyVaultSnapshot,
  GeminiModelCatalogEntry,
  GeminiVerificationState,
  KeyVaultStorageBackend,
};
export {
  GEMINI_API_KEY_URL,
  DEFAULT_GEMINI_MODEL,
  maskGeminiApiKey,
  redactGeminiSecrets,
  validateGeminiApiKeyFormat,
};

export const geminiKeyVault = new GeminiKeyVault();

if (typeof window !== 'undefined') {
  geminiKeyVault.hydrate().catch(() => {
    // Hydration failures are non-fatal and surface via snapshot state
  });
}
