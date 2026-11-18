/**
 * Pure URL resolution, validation, normalization, header building, and HTTP/SSE error classification helpers
 * shared between the BUDDY frontend (apiService.ts) and Node.js automated test suite (tests/surya.test.js).
 */

export const STORAGE_KEY_BACKEND_URL = 'surya_backend_url';
export const STORAGE_KEY_API_TOKEN = 'surya_api_token';
export const STORAGE_KEY_CLIENT_ID = 'surya_client_id';
export const GEMINI_API_KEY_URL = 'https://aistudio.google.com/app/apikey';

export class GatewayHttpError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'GatewayHttpError';
    this.code = opts.code || 'UNKNOWN';
    this.status = typeof opts.status === 'number' ? opts.status : null;
    this.connectionState = opts.connectionState || 'SERVER_ERROR';
    this.retryable = Boolean(opts.retryable);
    this.url = opts.url || '';
  }
}

export function isAiStudioPreviewUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const lower = rawUrl.trim().toLowerCase();
  return (
    /https?:\/\/ais-dev-[a-z0-9-]+\.[a-z0-9.-]*run\.app/i.test(lower) ||
    /https?:\/\/ais-pre-[a-z0-9-]+\.[a-z0-9.-]*run\.app/i.test(lower) ||
    lower.includes('__cookie_check')
  );
}

export function normalizeBackendUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let cleaned = raw.trim();
  if (!cleaned) return '';

  // Remove trailing slashes
  cleaned = cleaned.replace(/\/+$/, '');

  // Strip accidental pasted API paths so base URL always represents server root
  cleaned = cleaned.replace(/\/api\/health$/i, '');
  cleaned = cleaned.replace(/\/api\/chat(?:\/stream)?$/i, '');
  cleaned = cleaned.replace(/\/api$/i, '');
  cleaned = cleaned.replace(/\/+$/, '');

  return cleaned;
}

export function joinApiUrl(baseUrl, endpoint) {
  const normalizedBase = normalizeBackendUrl(baseUrl);
  let cleanEndpoint = typeof endpoint === 'string' ? endpoint.trim() : '';
  if (!cleanEndpoint.startsWith('/')) {
    cleanEndpoint = `/${cleanEndpoint}`;
  }

  // Extra safeguard if someone passed an unnormalized base ending with /api
  if (normalizedBase.toLowerCase().endsWith('/api') && cleanEndpoint.toLowerCase().startsWith('/api/')) {
    cleanEndpoint = cleanEndpoint.slice(4);
  }

  return normalizedBase ? `${normalizedBase}${cleanEndpoint}` : cleanEndpoint;
}

export function isLocalOrLanHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '10.0.2.2') {
    return true;
  }
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

export function isSafeExternalUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    // Never allow API keys or secret tokens in external URLs
    const full = parsed.toString();
    if (/AIza[0-9A-Za-z_-]{12,}/.test(full)) return false;
    for (const [k] of parsed.searchParams.entries()) {
      const lk = k.toLowerCase();
      if (lk === 'key' || lk === 'api_key' || lk === 'apikey' || lk === 'token' || lk === 'secret') {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function validateBackendUrl(raw, opts = {}) {
  const isNative = Boolean(opts.isNative);
  const requireNonEmpty = Boolean(opts.requireNonEmpty);
  const trimmed = typeof raw === 'string' ? raw.trim() : '';

  if (!trimmed) {
    if (isNative || requireNonEmpty) {
      return {
        valid: false,
        normalized: '',
        isPreviewUrl: false,
        error: isNative
          ? 'Android APK requires an explicit HTTPS backend URL (or local LAN dev URL).'
          : 'Backend URL cannot be empty. Enter your deployed HTTPS backend URL.',
      };
    }
    return {
      valid: true,
      normalized: '',
      isPreviewUrl: false,
    };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      normalized: '',
      isPreviewUrl: false,
      error: 'Invalid URL format. Enter a full HTTPS URL such as https://your-service.run.app.',
    };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      valid: false,
      normalized: '',
      isPreviewUrl: false,
      error: `Unsupported protocol "${parsed.protocol}". Use https:// (or http:// only on localhost/LAN).`,
    };
  }

  if (parsed.username || parsed.password) {
    return {
      valid: false,
      normalized: '',
      isPreviewUrl: false,
      error: 'Credentials must not be embedded in the backend URL.',
    };
  }

  if (parsed.protocol === 'http:' && !isLocalOrLanHost(parsed.hostname)) {
    return {
      valid: false,
      normalized: '',
      isPreviewUrl: false,
      error:
        'Public backend URLs must use HTTPS (https://...). Use http:// only for localhost or private LAN development.',
    };
  }

  const normalized = normalizeBackendUrl(parsed.toString());
  const isPreview = isAiStudioPreviewUrl(normalized);

  if (isPreview) {
    return {
      valid: true,
      normalized,
      isPreviewUrl: true,
      warning:
        'AI Studio preview URLs (ais-dev-* / ais-pre-*) require browser cookie authentication and redirect mobile APK requests to HTML cookie checks. Deploy server.ts to an independent public Cloud Run HTTPS URL instead.',
    };
  }

  return {
    valid: true,
    normalized,
    isPreviewUrl: false,
  };
}

export function detectNativePlatform(win) {
  if (!win) return false;
  try {
    if (win.Capacitor?.isNativePlatform?.()) return true;
    const proto = win.location?.protocol || '';
    if (proto === 'capacitor:' || proto === 'ionic:' || proto === 'file:') return true;
    const host = win.location?.hostname || '';
    const port = win.location?.port || '';
    // Capacitor Android serves WebView assets at https://localhost (no non-default dev port)
    if (host === 'localhost' && (!port || port === '80' || port === '443') && proto === 'https:') {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function resolveApiBaseUrl({ storedUrl = '', envUrl = '', isNativePlatform = false } = {}) {
  const custom = normalizeBackendUrl(storedUrl);
  if (custom) {
    return custom;
  }

  const builtEnv = normalizeBackendUrl(envUrl);
  if (builtEnv) {
    return builtEnv;
  }

  // Never fall back to hardcoded AI Studio preview proxy or Android WebView https://localhost
  if (isNativePlatform) {
    return '';
  }

  // In web browser dev/same-origin deployment, relative /api/* paths hit Express directly
  return '';
}

export function looksLikeHtmlPayload(text, contentType = '') {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) {
    return true;
  }
  if (typeof text !== 'string') return false;
  const trimmed = text.trim().toLowerCase();
  return (
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<html') ||
    trimmed.startsWith('<head') ||
    trimmed.startsWith('<body') ||
    trimmed.startsWith('<') ||
    trimmed.includes('__cookie_check') ||
    trimmed.includes('<title>cookie check</title>')
  );
}

export function classifyResponseFailure({ url, status, contentType = '', bodyText = '', redirected = false, responseUrl = '' }) {
  const isCookieRedirect =
    redirected && (String(responseUrl).includes('__cookie_check') || looksLikeHtmlPayload(bodyText, contentType));

  if (isCookieRedirect || String(bodyText).includes('__cookie_check') || String(bodyText).includes('Cookie check')) {
    return new GatewayHttpError(
      `BUDDY Backend Error: Gateway at ${url} redirected to a browser cookie challenge (HTTP ${status || 302}). AI Studio preview URLs block Android APK requests; configure an independent Cloud Run HTTPS URL in Backend Server Gateway settings.`,
      {
        code: 'COOKIE_GATEWAY_HTML',
        status: status || 302,
        connectionState: 'AUTHENTICATION_REQUIRED',
        retryable: false,
        url,
      }
    );
  }

  if (looksLikeHtmlPayload(bodyText, contentType)) {
    return new GatewayHttpError(
      `BUDDY Backend Error: Received HTML webpage instead of JSON API from ${url} (HTTP ${status}). Verify the configured backend URL points to the live BUDDY Express server.`,
      {
        code: 'HTML_RESPONSE',
        status,
        connectionState: 'SERVER_ERROR',
        retryable: false,
        url,
      }
    );
  }

  let parsed = null;
  if (bodyText && bodyText.trim()) {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return new GatewayHttpError(
        `Invalid JSON received from ${url} (HTTP ${status}): ${bodyText.slice(0, 120)}`,
        {
          code: 'INVALID_JSON',
          status,
          connectionState: 'SERVER_ERROR',
          retryable: false,
          url,
        }
      );
    }
  }

  const serverMsg = parsed?.error || parsed?.message;
  const serverCode = parsed?.code;

  if (serverCode === 'GEMINI_AUTH_FAILED') {
    return new GatewayHttpError(
      serverMsg || `Gemini API authentication failed on the backend (HTTP ${status}). Check server GEMINI_API_KEY configuration.`,
      {
        code: 'GEMINI_AUTH_FAILED',
        status,
        connectionState: 'AUTHENTICATION_REQUIRED',
        retryable: false,
        url,
      }
    );
  }

  if (serverCode === 'MODEL_UNAVAILABLE') {
    return new GatewayHttpError(
      serverMsg || `Selected Gemini model is unavailable or retired upstream (HTTP ${status}).`,
      {
        code: 'MODEL_UNAVAILABLE',
        status,
        connectionState: 'SERVER_ERROR',
        retryable: false,
        url,
      }
    );
  }

  if (status === 401 || status === 403) {
    return new GatewayHttpError(
      serverMsg
        ? `${serverMsg} (HTTP ${status})`
        : `Backend authentication failed (HTTP ${status}). Verify your BUDDY API access token or origin policy in Backend Server Gateway settings.`,
      {
        code: 'AUTH_REQUIRED',
        status,
        connectionState: 'AUTHENTICATION_REQUIRED',
        retryable: false,
        url,
      }
    );
  }

  if (status === 429) {
    return new GatewayHttpError(
      serverMsg
        ? `${serverMsg} (HTTP 429)`
        : 'Rate limit exceeded (HTTP 429). Please wait a few moments before sending another request.',
      {
        code: 'RATE_LIMITED',
        status: 429,
        connectionState: 'RATE_LIMITED',
        retryable: false,
        url,
      }
    );
  }

  if (status === 404) {
    return new GatewayHttpError(
      serverMsg || `Endpoint not found (HTTP 404) at ${url}. Confirm your backend URL targets the BUDDY Express service root.`,
      {
        code: 'NOT_FOUND',
        status: 404,
        connectionState: 'SERVER_ERROR',
        retryable: false,
        url,
      }
    );
  }

  const retryable = status === 502 || status === 503 || status === 504;
  return new GatewayHttpError(
    serverMsg || `BUDDY backend returned HTTP ${status} from ${url}.`,
    {
      code: 'SERVER_ERROR',
      status,
      connectionState: status === 502 || status === 503 ? 'UNAVAILABLE' : status === 504 ? 'TIMEOUT' : 'SERVER_ERROR',
      retryable,
      url,
    }
  );
}

export function classifyNetworkException(err, url, { timedOut = false, userAborted = false } = {}) {
  if (userAborted) {
    return new GatewayHttpError('Request cancelled by operator.', {
      code: 'ABORTED',
      status: null,
      connectionState: 'DISCONNECTED',
      retryable: false,
      url,
    });
  }

  if (timedOut || err?.name === 'TimeoutError') {
    return new GatewayHttpError(
      `Request timed out contacting ${url}. Check network strength or server responsiveness.`,
      {
        code: 'TIMEOUT',
        status: null,
        connectionState: 'TIMEOUT',
        retryable: true,
        url,
      }
    );
  }

  const detail = err?.message || 'Failed to fetch';
  return new GatewayHttpError(
    `Server unavailable at ${url}: ${detail}. Verify internet access, HTTPS endpoint, or update your Backend Server Gateway settings.`,
    {
      code: 'NETWORK_ERROR',
      status: null,
      connectionState: 'UNAVAILABLE',
      retryable: true,
      url,
    }
  );
}
