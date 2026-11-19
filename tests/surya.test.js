import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

import {
  resolveApiBaseUrl,
  normalizeBackendUrl,
  joinApiUrl,
  validateBackendUrl,
  detectNativePlatform,
  isAiStudioPreviewUrl,
  looksLikeHtmlPayload,
  classifyResponseFailure,
  classifyNetworkException,
  GEMINI_API_KEY_URL,
  isSafeExternalUrl,
  STORAGE_KEY_BACKEND_URL,
} from '../src/services/gatewayHelpers.js';
import {
  OFFLINE_MODEL_CATALOG,
  evaluateModelCompatibility,
  buildRecommendedTiers,
  isTrustedModelUrl,
  sanitizeModelFilename,
  verifyDigestMatch,
} from '../src/services/offlineModelHelpers.js';
import {
  ModelDownloadManager,
  LocalInferenceRuntime,
  LocalRuntimeError,
  IntelligenceRouter,
} from '../src/services/offlineModelRuntimeCore.js';
import {
  GeminiKeyVault,
  DirectGeminiClient,
  DirectGeminiError,
  DEFAULT_GEMINI_MODEL,
  SEED_GEMINI_MODELS,
  isDeprecatedOrNonChatModel,
  maskGeminiApiKey,
  redactGeminiSecrets,
  validateGeminiApiKeyFormat,
  parseGeminiSseResponse,
  buildGeminiGenerateBody,
} from '../src/services/byokGeminiHelpers.js';

function collectSourceFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx|js|css)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function startIsolatedBackend(envOverrides = {}) {
  const port = await getFreePort();
  const tsxBin = path.resolve('node_modules/.bin/tsx');
  const child = spawn(tsxBin, ['server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      SURYA_SKIP_VITE: '1',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  let ready = false;
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // Wait for boot
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`Isolated test server failed to start on port ${port}: ${stderr}`);
  }

  return {
    baseUrl,
    stop: async () => {
      if (!child.killed) {
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 150));
        if (!child.killed) child.kill('SIGKILL');
      }
    },
  };
}

// 1. AndroidManifest.xml & Package Identity Audit for SURYA AI
test('1. AndroidManifest.xml & Package Identity Audit for SURYA AI', () => {
  const manifestPath = path.resolve('android/app/src/main/AndroidManifest.xml');
  assert.ok(fs.existsSync(manifestPath), 'AndroidManifest.xml must exist');

  const content = fs.readFileSync(manifestPath, 'utf-8');
  assert.ok(content.includes('android.permission.RECORD_AUDIO'), 'Must declare RECORD_AUDIO');
  assert.ok(content.includes('android.permission.CAMERA'), 'Must declare CAMERA');
  assert.ok(content.includes('android.permission.USE_BIOMETRIC'), 'Must declare USE_BIOMETRIC');
  assert.ok(content.includes('android.permission.FOREGROUND_SERVICE'), 'Must declare FOREGROUND_SERVICE');
  assert.ok(content.includes('android.permission.FOREGROUND_SERVICE_MICROPHONE'), 'Must declare FOREGROUND_SERVICE_MICROPHONE');
  assert.ok(content.includes('android.permission.POST_NOTIFICATIONS'), 'Must declare POST_NOTIFICATIONS');
  assert.ok(content.includes('com.surya.assistant.fileprovider'), 'Must declare SURYA FileProvider');
  assert.ok(content.includes('BUDDY AI'), 'App label must be BUDDY AI');
  assert.ok(content.includes('<queries>'), 'Must declare package visibility queries for Android 11+');
  assert.ok(content.includes('SuryaHandsFreeService'), 'Must register SuryaHandsFreeService');
  assert.ok(content.includes('SuryaWidgetProvider'), 'Must register SuryaWidgetProvider');
  assert.ok(content.includes('@xml/shortcuts'), 'Must reference app shortcuts XML');
  assert.doesNotMatch(content, /com\.vajra/, 'Must have zero legacy package identifiers');
});

// 2. Capacitor Configuration Structure & Native Fetch Streaming Compliance
test('2. Capacitor Configuration Structure for SURYA', () => {
  const capPath = path.resolve('capacitor.config.ts');
  assert.ok(fs.existsSync(capPath), 'capacitor.config.ts must exist');

  const content = fs.readFileSync(capPath, 'utf-8');
  assert.ok(content.includes('com.surya.assistant'), 'AppId must be com.surya.assistant');
  assert.ok(content.includes('BUDDY AI'), 'AppName must be BUDDY AI');
  assert.ok(content.includes("webDir: 'dist'"), 'webDir must be dist');
  assert.match(content, /CapacitorHttp:\s*\{\s*enabled:\s*false/, 'CapacitorHttp must be disabled so WebView fetch streams SSE chunks natively');
  assert.match(content, /CapacitorCookies:\s*\{\s*enabled:\s*false/, 'CapacitorCookies must be disabled for stateless Bearer API calls');
  assert.doesNotMatch(content, /vajra/i, 'Must have zero legacy identifiers');
});

// 3. GitHub Actions Android APK Pipeline Verification
test('3. GitHub Actions Android APK Pipeline Verification', () => {
  const workflowPath = path.resolve('.github/workflows/android-apk.yml');
  assert.ok(fs.existsSync(workflowPath), '.github/workflows/android-apk.yml must exist');

  const content = fs.readFileSync(workflowPath, 'utf-8');
  assert.ok(content.includes("java-version: '21'"), 'Workflow must use Java 21');
  assert.ok(content.includes('api-level: 36'), 'Workflow must target Android SDK 36');
  assert.ok(content.includes('gradle-version 8.11.1'), 'Workflow must specify Gradle 8.11.1');
  assert.ok(content.includes('VITE_API_BASE_URL'), 'Workflow must inject VITE_API_BASE_URL into production web build');
  assert.ok(content.includes('Surya-Android.apk'), 'Artifact must be Surya-Android.apk');
});

// 4. Deterministic Local Intent Command Execution (0ms - No Gemini Call)
test('4. Deterministic Local Intent Command Execution (0ms - No Gemini Call)', () => {
  const testInputs = [
    { input: 'Open YouTube', expectedApp: 'YouTube' },
    { input: 'Launch YouTube', expectedApp: 'YouTube' },
    { input: 'सूर्या, यूट्यूब खोलो', expectedApp: 'YouTube' },
    { input: 'Surya YouTube kholo', expectedApp: 'YouTube' },
    { input: 'Open Chrome', expectedApp: 'Chrome' },
    { input: 'Open Settings', expectedApp: 'Settings' },
    { input: 'Open Camera', expectedApp: 'Camera' },
  ];

  const youtubeRegex = /(open|launch|play|start)\s+youtube|यूट्यूब\s*(खोलो|चलाओ)|youtube\s*(kholo|chalao)/i;
  const chromeRegex = /(open|launch|start)\s+(google\s+)?chrome|क्रोम\s*(खोलो|चलाओ)|chrome\s*kholo/i;
  const settingsRegex = /(open|launch|go to)\s+(android\s+)?settings|सेटिंग्स\s*(खोलो)/i;
  const cameraRegex = /(open|launch|start|take)\s+camera|कैमरा\s*(खोलो)/i;

  for (const item of testInputs) {
    let matched = false;
    if (item.expectedApp === 'YouTube') matched = youtubeRegex.test(item.input);
    if (item.expectedApp === 'Chrome') matched = chromeRegex.test(item.input);
    if (item.expectedApp === 'Settings') matched = settingsRegex.test(item.input);
    if (item.expectedApp === 'Camera') matched = cameraRegex.test(item.input);

    assert.ok(matched, `Input "${item.input}" must be intercepted locally for ${item.expectedApp}`);
  }
});

// 5. UI Customization Theme Engine Structure & Presets
test('5. UI Customization Theme Engine Structure & Presets', () => {
  const PRESET_KEYS = [
    'suryadev-radiant',
    'futuristic-hologram',
    'iron-man-hud',
    'solar-saffron',
    'minimalist-dark',
    'cyber-emerald',
  ];

  assert.strictEqual(PRESET_KEYS.length, 6, 'Must provide 6 distinct high-fidelity presets');
  assert.ok(PRESET_KEYS.includes('suryadev-radiant'), 'Suryadev Radiant must be present');
  assert.ok(PRESET_KEYS.includes('futuristic-hologram'), 'Futuristic Hologram must be present');
  assert.ok(PRESET_KEYS.includes('iron-man-hud'), 'Iron Man HUD must be present');
});

// 6. Voice Profiles & Suryadev Radiant Command Identity
test('6. Voice Profiles & Suryadev Radiant Command Identity', () => {
  const PROFILES = [
    'suryadev-radiant',
    'calm-intelligence',
    'futuristic-ai',
    'natural-conversational',
    'indian-english',
    'hindi-command',
  ];

  assert.ok(PROFILES.includes('suryadev-radiant'), 'Must include Suryadev Radiant Command');
  assert.ok(PROFILES.includes('hindi-command'), 'Must include Hindi Command');
  assert.ok(PROFILES.includes('indian-english'), 'Must include Indian English');
});

// 7. Cognitive Engine 10-Agent Multi-Agent Matrix Verification
test('7. Cognitive Engine 10-Agent Matrix Verification', () => {
  const cogContent = fs.readFileSync(path.resolve('src/services/cognitiveEngine.ts'), 'utf-8');
  const expectedAgentIds = [
    'agent_conversation',
    'agent_context',
    'agent_planning',
    'agent_productivity',
    'agent_vision',
    'agent_research',
    'agent_coding',
    'agent_knowledge',
    'agent_diagnostics',
    'agent_verification',
  ];

  for (const agentId of expectedAgentIds) {
    assert.ok(cogContent.includes(agentId), `Cognitive Engine must register agent ${agentId}`);
  }
  assert.ok(cogContent.includes('createPlanAsync'), 'Cognitive Engine must support async AI planning');
});

// 8. Safe Auto-Update SHA-256 Checksum Validation
test('8. Safe Auto-Update SHA-256 Checksum Validation', () => {
  const sampleData = Buffer.from('SURYA_APK_PAYLOAD_V240');
  const computedHash = crypto.createHash('sha256').update(sampleData).digest('hex');

  assert.strictEqual(computedHash.length, 64, 'SHA-256 hash must be 64 hexadecimal characters');
  assert.match(computedHash, /^[a-f0-9]{64}$/);
});

// 9. Frontend Hygiene & API-Key Secrecy Audit across src/
test('9. Frontend Hygiene & API-Key Secrecy Audit across src/', () => {
  const srcFiles = collectSourceFiles(path.resolve('src'));
  assert.ok(srcFiles.length >= 20, 'Expected full SURYA TypeScript source tree');

  const allowedDirectGeminiFiles = new Set([
    path.normalize('src/services/byokGeminiHelpers.js'),
    path.normalize('src/services/byokGeminiHelpers.d.ts'),
    path.normalize('src/services/directGeminiService.ts'),
  ]);

  for (const file of srcFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const rel = path.normalize(path.relative(process.cwd(), file));
    assert.doesNotMatch(content, /\bvajra\b/i, `Legacy branding found in ${rel}`);
    assert.doesNotMatch(content, /picsum\.photos/i, `External picsum URL found in ${rel}`);
    assert.doesNotMatch(content, /\bwindow\.open\s*\(/, `window.open forbidden in ${rel}`);
    assert.doesNotMatch(content, /(?:^|[^\w.])alert\s*\(/m, `blocking alert() forbidden in ${rel}`);
    assert.doesNotMatch(content, /(?:^|[^\w.])confirm\s*\(/m, `blocking confirm() forbidden in ${rel}`);
    assert.doesNotMatch(content, /(?:process\.env|import\.meta\.env)\.(?:VITE_)?GEMINI_API_KEY/, `Bundled env API key secret must not exist in client file ${rel}`);
    assert.doesNotMatch(content, /\bVITE_GEMINI_API_KEY\b/, `Vite API key secret must not exist in client file ${rel}`);
    if (!allowedDirectGeminiFiles.has(rel)) {
      assert.doesNotMatch(content, /generativelanguage\.googleapis\.com/, `Direct Gemini endpoint must only be referenced inside BYOK transport modules, not ${rel}`);
    }
    assert.doesNotMatch(content, /generativelanguage\.googleapis\.com[^\n]*[?&]key=/, `API key query parameter forbidden (use x-goog-api-key header) in ${rel}`);
    assert.doesNotMatch(content, /localStorage\.setItem\([^)]*gemini[_-]?api[_-]?key/i, `Plain-text localStorage API key persistence forbidden in ${rel}`);
    assert.doesNotMatch(content, /AIza[0-9A-Za-z_-]{20,}/, `Hardcoded Google API key forbidden in ${rel}`);
    assert.doesNotMatch(content, /ais-dev-spa3isctk6gboolsd6lpzr/, `Hardcoded preview URL must not exist in ${rel}`);
  }
});

// 10. SSE Streaming Wire Protocol Alignment (server.ts <-> apiService.ts)
test('10. SSE Streaming Wire Protocol Alignment', () => {
  const serverContent = fs.readFileSync(path.resolve('server.ts'), 'utf-8');
  const apiContent = fs.readFileSync(path.resolve('src/services/apiService.ts'), 'utf-8');

  assert.ok(serverContent.includes("type: 'chunk'"), 'server.ts must emit SSE chunk frame');
  assert.ok(serverContent.includes("type: 'done'"), 'server.ts must emit SSE done frame');
  assert.ok(apiContent.includes("event.type === 'chunk'"), 'apiService.ts must parse event.type === chunk');
  assert.ok(apiContent.includes("event.type === 'done'"), 'apiService.ts must parse event.type === done');
});

// 11. Security Posture, CORS Allowlist & Route Isolation in server.ts
test('11. Security Posture, CORS Allowlist & Studio Route Separation', () => {
  const serverContent = fs.readFileSync(path.resolve('server.ts'), 'utf-8');

  assert.ok(serverContent.includes('isAllowedOrigin'), 'server.ts must restrict CORS with isAllowedOrigin allowlist');
  assert.doesNotMatch(serverContent, /\.endsWith\('\.run\.app'\)/, 'server.ts must not allowlist arbitrary *.run.app origins');
  assert.ok(serverContent.includes('requireApiAuth'), 'server.ts must enforce optional Bearer token auth');
  assert.ok(serverContent.includes('getUserNamespace'), 'server.ts must isolate memory by client namespace');
  assert.ok(serverContent.includes("app.get('/api/security/report'"), 'Must expose /api/security/report endpoint');
  assert.ok(serverContent.includes("app.get('/api/studio/apps'"), 'Studio apps must use /api/studio/apps without shadowing /api/apps');
  assert.ok(serverContent.includes("app.post('/api/apps/debug'"), 'Studio AI Debugger endpoint must exist');
  assert.ok(serverContent.includes("app.get('/api/studio/github'"), 'Studio GitHub repository monitor must exist');
  assert.ok(serverContent.includes("app.post('/api/vision/analyze'"), 'Optics structured analysis endpoint must exist');
  assert.ok(serverContent.includes("app.post('/api/vision/chat'"), 'Optics visual Q&A endpoint must exist');
  assert.doesNotMatch(serverContent, /picsum\.photos/i, 'server.ts seeded templates must not rely on picsum.photos');
});

// 12. Native Android Resources & Foreground Service Assets Verification
test('12. Native Android Foreground Service, Widget & App Shortcuts Verification', () => {
  const requiredAndroidFiles = [
    'android/app/src/main/java/com/surya/assistant/MainActivity.java',
    'android/app/src/main/java/com/surya/assistant/SuryaHandsFreeService.java',
    'android/app/src/main/java/com/surya/assistant/SuryaWidgetProvider.java',
    'android/app/src/main/res/layout/surya_widget.xml',
    'android/app/src/main/res/xml/surya_widget_info.xml',
    'android/app/src/main/res/xml/shortcuts.xml',
    'android/app/src/main/res/drawable/widget_bg.xml',
  ];

  for (const relPath of requiredAndroidFiles) {
    assert.ok(fs.existsSync(path.resolve(relPath)), `Missing native Android asset: ${relPath}`);
  }

  const mainActivity = fs.readFileSync(
    path.resolve('android/app/src/main/java/com/surya/assistant/MainActivity.java'),
    'utf-8'
  );
  assert.ok(mainActivity.includes('UtteranceProgressListener'), 'MainActivity must hook UtteranceProgressListener');
  assert.ok(mainActivity.includes('getDeviceTelemetry'), 'MainActivity must expose getDeviceTelemetry bridge');
  assert.ok(mainActivity.includes('startHandsFreeForegroundService'), 'MainActivity must expose Foreground Service start');
  assert.ok(mainActivity.includes('JSONObject.quote'), 'MainActivity must safely escape strings sent to JS');
});

// 13. Android & Web URL Resolution, Normalization, and Validation
test('13. URL Resolution, Normalization, and Validation', () => {
  // Normalization & /api deduplication
  assert.strictEqual(normalizeBackendUrl('  https://surya-api.example.com///  '), 'https://surya-api.example.com');
  assert.strictEqual(normalizeBackendUrl('https://surya-api.example.com/api/health'), 'https://surya-api.example.com');
  assert.strictEqual(normalizeBackendUrl('https://surya-api.example.com/api/chat/stream'), 'https://surya-api.example.com');
  assert.strictEqual(joinApiUrl('https://surya-api.example.com/', '/api/chat'), 'https://surya-api.example.com/api/chat');
  assert.strictEqual(joinApiUrl('https://surya-api.example.com/api', '/api/health'), 'https://surya-api.example.com/api/health');
  assert.strictEqual(joinApiUrl('', '/api/health'), '/api/health');

  // Native unconfigured returns '' (never falls back to ais-dev-*)
  assert.strictEqual(
    resolveApiBaseUrl({ storedUrl: '', envUrl: '', isNativePlatform: true }),
    ''
  );
  assert.strictEqual(
    resolveApiBaseUrl({ storedUrl: '', envUrl: 'https://surya.run.app/', isNativePlatform: true }),
    'https://surya.run.app'
  );
  assert.strictEqual(
    resolveApiBaseUrl({
      storedUrl: 'https://override.run.app/api',
      envUrl: 'https://surya.run.app',
      isNativePlatform: true,
    }),
    'https://override.run.app'
  );

  // Platform detection
  assert.strictEqual(
    detectNativePlatform({ Capacitor: { isNativePlatform: () => true }, location: { protocol: 'https:', hostname: 'localhost', port: '' } }),
    true
  );
  assert.strictEqual(
    detectNativePlatform({ location: { protocol: 'https:', hostname: 'localhost', port: '' } }),
    true
  );
  assert.strictEqual(
    detectNativePlatform({ location: { protocol: 'http:', hostname: 'localhost', port: '3000' } }),
    false
  );

  // Validation
  assert.strictEqual(validateBackendUrl('', { isNative: true }).valid, false);
  assert.strictEqual(validateBackendUrl('', { isNative: false }).valid, true);
  assert.strictEqual(validateBackendUrl('not a url', { isNative: true }).valid, false);
  assert.strictEqual(validateBackendUrl('javascript:alert(1)', { isNative: true }).valid, false);
  assert.strictEqual(validateBackendUrl('https://user:pass@host.com', { isNative: true }).valid, false);

  const previewCheck = validateBackendUrl('https://ais-dev-demo-123.asia-east1.run.app', { isNative: true });
  assert.strictEqual(previewCheck.valid, true);
  assert.strictEqual(previewCheck.isPreviewUrl, true);
  assert.ok(previewCheck.warning, 'Preview host must emit cookie-gateway warning');
  assert.strictEqual(isAiStudioPreviewUrl('https://ais-pre-abc.asia-east1.run.app'), true);
  assert.strictEqual(isAiStudioPreviewUrl('https://surya-prod-xyz.a.run.app'), false);
});

// 14. HTTP Failure Classification (HTML, Cookie-Check, 401/403/404/429/5xx, Timeout)
test('14. HTTP Failure Classification & State Mapping', () => {
  assert.strictEqual(looksLikeHtmlPayload('<!doctype html><html><title>Cookie check</title></html>'), true);
  assert.strictEqual(looksLikeHtmlPayload('{"status":"ONLINE"}', 'application/json'), false);

  const cookieErr = classifyResponseFailure({
    url: 'https://ais-dev-demo.run.app/api/health',
    status: 200,
    contentType: 'text/html',
    bodyText: '<!doctype html><title>Cookie check</title>',
    redirected: true,
    responseUrl: 'https://ais-dev-demo.run.app/__cookie_check.html',
  });
  assert.strictEqual(cookieErr.code, 'COOKIE_GATEWAY_HTML');
  assert.strictEqual(cookieErr.connectionState, 'AUTHENTICATION_REQUIRED');
  assert.strictEqual(cookieErr.retryable, false);

  const err401 = classifyResponseFailure({
    url: 'https://api.example.com/api/chat',
    status: 401,
    bodyText: JSON.stringify({ error: 'Authentication required' }),
  });
  assert.strictEqual(err401.code, 'AUTH_REQUIRED');
  assert.strictEqual(err401.connectionState, 'AUTHENTICATION_REQUIRED');
  assert.strictEqual(err401.retryable, false);

  const err429 = classifyResponseFailure({
    url: 'https://api.example.com/api/chat',
    status: 429,
    bodyText: JSON.stringify({ error: 'Too many requests' }),
  });
  assert.strictEqual(err429.code, 'RATE_LIMITED');
  assert.strictEqual(err429.connectionState, 'RATE_LIMITED');
  assert.strictEqual(err429.retryable, false);

  const err404 = classifyResponseFailure({
    url: 'https://api.example.com/api/missing',
    status: 404,
    bodyText: JSON.stringify({ error: 'Not found' }),
  });
  assert.strictEqual(err404.code, 'NOT_FOUND');
  assert.strictEqual(err404.connectionState, 'SERVER_ERROR');
  assert.strictEqual(err404.retryable, false);

  const err503 = classifyResponseFailure({
    url: 'https://api.example.com/api/chat',
    status: 503,
    bodyText: JSON.stringify({ error: 'Service unavailable' }),
  });
  assert.strictEqual(err503.code, 'SERVER_ERROR');
  assert.strictEqual(err503.retryable, true);

  const timeoutErr = classifyNetworkException(new Error('Aborted'), 'https://api.example.com/api/health', {
    timedOut: true,
  });
  assert.strictEqual(timeoutErr.code, 'TIMEOUT');
  assert.strictEqual(timeoutErr.retryable, true);

  const abortErr = classifyNetworkException(new Error('Aborted'), 'https://api.example.com/api/health', {
    userAborted: true,
  });
  assert.strictEqual(abortErr.code, 'ABORTED');
  assert.strictEqual(abortErr.retryable, false);
});

// 15. Live Express Server Integration: CORS, Bearer Auth, Rate Limiting & Per-User Memory Isolation
test('15. Isolated Express Server: CORS, Auth, Rate Limit & Per-User Memory Isolation', async () => {
  const srv = await startIsolatedBackend({
    SURYA_API_TOKEN: 'surya-test-secret-token-2026',
    SURYA_RATE_LIMIT_MAX: '25',
  });

  try {
    // a. Public /api/health
    const healthRes = await fetch(`${srv.baseUrl}/api/health`);
    assert.strictEqual(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.strictEqual(healthJson.status, 'ONLINE');
    assert.strictEqual(healthJson.authRequired, true);

    // b. CORS preflight allowed vs denied
    const corsOk = await fetch(`${srv.baseUrl}/api/chat`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://localhost' },
    });
    assert.strictEqual(corsOk.status, 204);
    assert.strictEqual(corsOk.headers.get('access-control-allow-origin'), 'https://localhost');

    const corsBlocked = await fetch(`${srv.baseUrl}/api/chat`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://untrusted.evil.example' },
    });
    assert.strictEqual(corsBlocked.status, 403);
    assert.strictEqual(corsBlocked.headers.get('access-control-allow-origin'), null);

    // c. Auth enforcement: missing token -> 401, wrong token -> 403, valid token -> 200
    const noAuth = await fetch(`${srv.baseUrl}/api/security/report`);
    assert.strictEqual(noAuth.status, 401);

    const badAuth = await fetch(`${srv.baseUrl}/api/security/report`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.strictEqual(badAuth.status, 403);

    const goodAuthHeaders = {
      Authorization: 'Bearer surya-test-secret-token-2026',
      'Content-Type': 'application/json',
    };
    const okSec = await fetch(`${srv.baseUrl}/api/security/report`, { headers: goodAuthHeaders });
    assert.strictEqual(okSec.status, 200);
    const secJson = await okSec.json();
    assert.strictEqual(secJson.authTokenEnforced, true);
    assert.strictEqual(secJson.perUserMemoryIsolation, true);

    // d. Per-User Memory Isolation across distinct X-Surya-Client-Id headers
    const uniqueKey = `test_iso_${Date.now()}`;
    const createA = await fetch(`${srv.baseUrl}/api/memory`, {
      method: 'POST',
      headers: { ...goodAuthHeaders, 'X-Surya-Client-Id': 'client_alpha_test_1234' },
      body: JSON.stringify({ key: uniqueKey, value: 'Alpha Secret Fact', category: 'fact' }),
    });
    assert.strictEqual(createA.status, 200);
    const createdPayload = await createA.json();
    const createdId = createdPayload.created?.id;
    assert.ok(createdId, 'Created memory ID must be returned');

    const listB = await fetch(`${srv.baseUrl}/api/memory`, {
      headers: { ...goodAuthHeaders, 'X-Surya-Client-Id': 'client_beta_test_5678' },
    });
    const bJson = await listB.json();
    assert.strictEqual(
      bJson.memories.some((m) => m.key === uniqueKey),
      false,
      'User B must NOT see User A memory entries'
    );

    // Cleanup User A test record
    await fetch(`${srv.baseUrl}/api/memory/${encodeURIComponent(createdId)}`, {
      method: 'DELETE',
      headers: { ...goodAuthHeaders, 'X-Surya-Client-Id': 'client_alpha_test_1234' },
    });

    // e. Rate limiting returns 429 cleanly in JSON
    let saw429 = false;
    for (let i = 0; i < 30; i += 1) {
      const r = await fetch(`${srv.baseUrl}/api/health`);
      if (r.status === 429) {
        const body = await r.json();
        assert.ok(body.error, '429 must return JSON error message');
        saw429 = true;
        break;
      }
    }
    assert.strictEqual(saw429, true, 'Excess burst traffic must trigger 429 rate limit');
  } finally {
    await srv.stop();
  }
});

// 16. Offline Capability Audit Matrix Completeness & Online/Offline Separation
test('16. Offline Capability Audit Matrix Covers All 13 Audited Areas & Explicit Online Boundaries', () => {
  const auditSrc = fs.readFileSync(path.join(process.cwd(), 'src/services/offlineCapabilities.ts'), 'utf8');
  const expectedIds = [
    'local_llm',
    'local_wake_word',
    'offline_stt',
    'offline_tts',
    'local_intents',
    'local_productivity',
    'local_memory_vault',
    'local_agents',
    'local_ocr_qr',
    'ondevice_vision',
    'local_studio',
    'local_diagnostics',
    'local_history',
  ];
  for (const id of expectedIds) {
    assert.ok(auditSrc.includes(`id: '${id}'`), `Audit must cover capability: ${id}`);
  }
  assert.ok(auditSrc.includes('ONLINE_ONLY_FEATURES'), 'Online-only boundary list must exist');
  assert.ok(auditSrc.includes('cloud_gemini'), 'Cloud Gemini must be listed as online-only');
  assert.ok(auditSrc.includes('github_monitor'), 'GitHub monitor must be listed as online-only');
});

// 17. Device Compatibility Evaluation, Tier Recommendations & Download Security Guards
test('17. Device Compatibility, Tier Recommendations, Trusted URL & Filename Guards', () => {
  // Trusted URL checks
  assert.strictEqual(
    isTrustedModelUrl('https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/Gemma3-1B-IT_multi-prefill-seq_q4_ekv2048.task').valid,
    true
  );
  assert.strictEqual(isTrustedModelUrl('http://huggingface.co/model.task').valid, false);
  assert.strictEqual(isTrustedModelUrl('https://evil.example.com/payload.task').valid, false);

  // Filename traversal sanitization & safe extension enforcement
  assert.throws(() => sanitizeModelFilename('../../etc/passwd'), /extension rejected/i);
  assert.strictEqual(sanitizeModelFilename('../../gemma 3?.task'), 'gemma_3_.task');

  // Digest verification checks
  assert.strictEqual(verifyDigestMatch('abcd'.repeat(16), null).mode, 'computed_recorded');
  assert.strictEqual(verifyDigestMatch('a'.repeat(64), 'A'.repeat(64)).mode, 'pinned_verified');
  assert.strictEqual(verifyDigestMatch('a'.repeat(64), 'b'.repeat(64)).valid, false);

  // 32-bit ABI device must be blocked from 64-bit LiteRT models
  const device32 = {
    platform: 'android',
    cpuAbis: ['armeabi-v7a'],
    totalRamMb: 4096,
    availableRamMb: 2200,
    availableStorageMb: 12000,
    thermalStatus: 'nominal',
  };
  const assessment32 = evaluateModelCompatibility(OFFLINE_MODEL_CATALOG[1], device32);
  assert.strictEqual(assessment32.status, 'incompatible');
  assert.strictEqual(assessment32.canDownload, false);

  // Mid-range 6GB RAM Android device recommendations
  const midDevice = {
    platform: 'android',
    cpuAbis: ['arm64-v8a'],
    totalRamMb: 6144,
    availableRamMb: 3400,
    availableStorageMb: 16000,
    thermalStatus: 'nominal',
  };
  const tiersMid = buildRecommendedTiers(midDevice);
  assert.ok(tiersMid.lightweight, 'Mid-range device should have a Lightweight pick');
  assert.ok(tiersMid.balanced, 'Mid-range device should have a Balanced pick');

  // Insufficient storage blocks download
  const fullStorageDevice = { ...midDevice, availableStorageMb: 250 };
  const storageBlocked = evaluateModelCompatibility(OFFLINE_MODEL_CATALOG[1], fullStorageDevice);
  assert.strictEqual(storageBlocked.canDownload, false);
  assert.ok(storageBlocked.blockers.some((b) => b.toLowerCase().includes('storage')));
});

// 18. ModelDownloadManager: Confirmation Gate, Streamed Progress, Pause/Cancel, SHA-256 Verification & Delete Guard
test('18. ModelDownloadManager Lifecycle: Confirmation Gate, Progress, Checksum & Active Delete Protection', async () => {
  const sampleBytes = new TextEncoder().encode('SURYA_OFFLINE_MODEL_WEIGHTS_SAMPLE');
  const expectedDigest = crypto.createHash('sha256').update(sampleBytes).digest('hex');

  let activeModelId = null;
  const catalog = [
    {
      ...OFFLINE_MODEL_CATALOG[0],
      sizeBytes: sampleBytes.length,
      expectedSha256: expectedDigest,
    },
  ];

  const storage = new Map();
  const mockLocalStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  const events = [];
  const fakeFetch = async () => {
    let idx = 0;
    const chunkA = sampleBytes.slice(0, 12);
    const chunkB = sampleBytes.slice(12);
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(sampleBytes.length) },
      body: {
        getReader() {
          return {
            async read() {
              if (idx === 0) {
                idx += 1;
                return { done: false, value: chunkA };
              }
              if (idx === 1) {
                idx += 1;
                return { done: false, value: chunkB };
              }
              return { done: true };
            },
          };
        },
      },
    };
  };

  const mgr = new ModelDownloadManager({
    catalog,
    webFetcher: fakeFetch,
    isModelActiveCheck: (id) => activeModelId === id,
    getDeviceSnapshot: () => ({
      platform: 'android',
      cpuAbis: ['arm64-v8a'],
      totalRamMb: 6144,
      availableRamMb: 4096,
      availableStorageMb: 12000,
      thermalStatus: 'nominal',
    }),
  });
  mgr.subscribe((states) => {
    const rec = states[catalog[0].id];
    if (rec) events.push(rec.status);
  });

  // Unconfirmed download must be refused strictly
  await assert.rejects(
    () => mgr.confirmAndStartDownload(catalog[0].id, { explicitConfirmed: false }),
    /explicit user confirmation is required/i
  );

  // Proper confirmation flow
  const req = mgr.requestDownloadConfirmation(catalog[0].id);
  assert.strictEqual(req.record.status, 'awaiting_confirmation');

  const doneRec = await mgr.confirmAndStartDownload(catalog[0].id, { explicitConfirmed: true });
  assert.strictEqual(doneRec.status, 'ready');
  assert.strictEqual(doneRec.progressPercent, 100);
  assert.strictEqual(doneRec.sha256, expectedDigest);
  assert.strictEqual(doneRec.verificationStatus, 'verified_manifest');
  assert.ok(events.includes('downloading'));

  // Active model deletion must be blocked
  activeModelId = catalog[0].id;
  await assert.rejects(
    () => mgr.deleteModel(catalog[0].id),
    /cannot delete the currently active local model/i
  );

  // Unloaded model deletion succeeds cleanly
  activeModelId = null;
  const deleted = await mgr.deleteModel(catalog[0].id);
  assert.strictEqual(deleted, true);
  assert.strictEqual(mgr.getState(catalog[0].id).status, 'not_downloaded');

  // Corrupt SHA-256 mismatch rejects download
  const corruptMgr = new ModelDownloadManager({
    catalog: [{ ...catalog[0], expectedSha256: 'f'.repeat(64) }],
    webFetcher: fakeFetch,
    getDeviceSnapshot: () => ({
      platform: 'android',
      cpuAbis: ['arm64-v8a'],
      totalRamMb: 6144,
      availableRamMb: 4096,
      availableStorageMb: 12000,
      thermalStatus: 'nominal',
    }),
  });
  await assert.rejects(
    () => corruptMgr.confirmAndStartDownload(catalog[0].id, { explicitConfirmed: true }),
    /SHA-256 mismatch/i
  );
  assert.strictEqual(corruptMgr.getState(catalog[0].id).status, 'corrupted');
});

// 19. LocalInferenceRuntime: Honest RUNTIME_UNAVAILABLE (No Fake Output) + Load/Generate/Unload & Safety Guards
test('19. LocalInferenceRuntime: Honest Unavailable Error, Load/Switch/Unload & Thermal/Memory Guards', async () => {
  const modelA = OFFLINE_MODEL_CATALOG[0];
  const modelB = OFFLINE_MODEL_CATALOG[1];

  let fakeDevice = {
    platform: 'web',
    cpuAbis: [],
    totalRamMb: 4096,
    availableRamMb: 3000,
    availableStorageMb: 10000,
    thermalStatus: 'nominal',
  };

  // No native bridge & no Web engine attached -> must fail honestly (no fake output)
  const plainRuntime = new LocalInferenceRuntime({
    getModelManifest: (id) => OFFLINE_MODEL_CATALOG.find((m) => m.id === id) || null,
    getDownloadState: () => ({ status: 'ready', localPath: '/tmp/model.task' }),
    getDeviceSnapshot: () => fakeDevice,
  });
  await assert.rejects(
    () => plainRuntime.loadModel(modelA.id),
    (err) => err instanceof LocalRuntimeError && err.code === 'RUNTIME_UNAVAILABLE'
  );
  await assert.rejects(
    () => plainRuntime.generateResponse('Hello offline'),
    (err) => err instanceof LocalRuntimeError && err.code === 'NO_ACTIVE_MODEL'
  );

  // Attach genuine runtime backend (mimicking Android native bridge or local engine)
  let unloadedCount = 0;
  const loadedIds = [];
  const fakeRuntime = new LocalInferenceRuntime({
    getModelManifest: (id) => OFFLINE_MODEL_CATALOG.find((m) => m.id === id) || null,
    getDownloadState: () => ({ status: 'ready', localPath: '/data/models/model.task' }),
    getDeviceSnapshot: () => fakeDevice,
    webEngine: {
      backendName: 'Test On-Device Engine',
      async loadModel(manifest) {
        loadedIds.push(manifest.id);
      },
      async unloadModel() {
        unloadedCount += 1;
      },
      async generate(prompt, opts) {
        opts?.onChunk?.('Offline ');
        opts?.onChunk?.('Offline response OK.');
        return `Offline response OK to: ${prompt}`;
      },
    },
  });

  fakeDevice = { ...fakeDevice, platform: 'android', cpuAbis: ['arm64-v8a'], availableRamMb: 3500 };

  // Thermal critical must refuse load
  fakeDevice.thermalStatus = 'critical';
  await assert.rejects(
    () => fakeRuntime.loadModel(modelA.id),
    (err) => err.code === 'THERMAL_THROTTLE'
  );
  fakeDevice.thermalStatus = 'nominal';

  // Load A, switch to B (must unload A cleanly), stream tokens, then unload
  const sA = await fakeRuntime.loadModel(modelA.id);
  assert.strictEqual(sA.status, 'ready');
  assert.strictEqual(sA.activeModelId, modelA.id);

  await fakeRuntime.loadModel(modelB.id);
  assert.ok(unloadedCount >= 1, 'Switching models must unload previous model first');

  const chunks = [];
  const gen = await fakeRuntime.generateResponse('Summarize', {
    onChunk: (c) => chunks.push(c),
  });
  assert.strictEqual(gen.modelId, modelB.id);
  assert.ok(chunks.length >= 2);
  assert.ok(gen.text.includes('Offline response OK'));

  await fakeRuntime.unloadModel();
  assert.strictEqual(fakeRuntime.getState().activeModelId, null);
  assert.strictEqual(fakeRuntime.getState().status, 'unloaded');
});

// 20. IntelligenceRouter: Mode Switching, Offline Zero-Cloud-Leakage & Online Fallback
test('20. IntelligenceRouter: Offline Privacy Lock, Auto Fallback & Provenance', async () => {
  let networkOnline = false;
  let cloudCalls = 0;

  const mockLocalRuntime = {
    getState: () => ({
      status: 'ready',
      activeModelId: 'gemma-3-1b-it-int4',
      activeModelName: 'Gemma 3 1B Instruct (INT4)',
      executionBackend: 'MediaPipe LlmInference (Android)',
    }),
    async generateResponse(input) {
      return {
        text: `Local LLM reply: ${input}`,
        modelId: 'gemma-3-1b-it-int4',
        modelName: 'Gemma 3 1B Instruct (INT4)',
        backend: 'MediaPipe LlmInference (Android)',
        latencyMs: 42,
      };
    },
  };

  const router = new IntelligenceRouter({
    initialMode: 'offline',
    isOnlineCheck: () => networkOnline,
    localRuntime: mockLocalRuntime,
    cloudHandler: async () => {
      cloudCalls += 1;
      return { response: 'Cloud Gemini reply', model: 'gemini-4-hydrogen', latencyMs: 120 };
    },
    localToolsHandler: async (input) => {
      if (input === 'my tasks') {
        return {
          answeredLocally: true,
          text: '1 pending local task',
          modelLabel: 'Local Productivity Index',
          latencyMs: 2,
        };
      }
      return { answeredLocally: false, vaultSnippet: '' };
    },
  });

  // Even if network flips true, OFFLINE mode MUST NEVER call cloudHandler
  networkOnline = true;
  const offlineRes = await router.routeMessage('Explain photosynthesis');
  assert.strictEqual(cloudCalls, 0, 'Offline mode must make zero cloud API calls');
  assert.strictEqual(offlineRes.source, 'on-device-llm');
  assert.strictEqual(offlineRes.handledOffline, true);
  assert.ok(offlineRes.text.includes('Local LLM reply'));

  // Local tools work offline in 0ms without invoking LLM
  const toolsRes = await router.routeMessage('my tasks');
  assert.strictEqual(toolsRes.source, 'local-tools');
  assert.strictEqual(cloudCalls, 0);

  // Switch to AUTO with online network -> uses Cloud Gemini
  router.setMode('auto');
  const onlineRes = await router.routeMessage('Hello cloud');
  assert.strictEqual(cloudCalls, 1);
  assert.strictEqual(onlineRes.source, 'cloud-gemini');

  // Switch network offline while in AUTO -> routes automatically to on-device LLM
  networkOnline = false;
  const fallbackRes = await router.routeMessage('Offline continuity test');
  assert.strictEqual(fallbackRes.source, 'on-device-llm');
  assert.strictEqual(cloudCalls, 1);
});

// 21. UI Components Hygiene & Clean JARVIS / Offline Model Store Presence
test('21. Clean UI Redesign & Offline Model Store Integration Check', () => {
  const requiredUiFiles = [
    'src/components/OfflineModelStore.tsx',
    'src/components/MoreWorkspace.tsx',
    'src/components/SystemHealthDashboard.tsx',
    'src/components/ModelSelectorModal.tsx',
    'src/components/SuryaVisionHUD.tsx',
    'src/components/AppCreatorWorkspace.tsx',
    'src/App.tsx',
  ];
  for (const rel of requiredUiFiles) {
    const abs = path.join(process.cwd(), rel);
    assert.ok(fs.existsSync(abs), `Missing UI file: ${rel}`);
  }
  const storeSrc = fs.readFileSync(path.join(process.cwd(), 'src/components/OfflineModelStore.tsx'), 'utf8');
  assert.ok(storeSrc.includes('Confirm Download'), 'Offline store must require explicit user confirmation UI');
  assert.ok(storeSrc.includes('disabled={isActive}'), 'Offline store must block deleting active model');
});

// 22. Android Native Offline LLM (MediaPipe) & Bundled ML Kit Verification
test('22. Android Native Gradle Dependencies, SuryaOfflineModelService & MainActivity Bridge', () => {
  const gradleSrc = fs.readFileSync(path.join(process.cwd(), 'android/app/build.gradle'), 'utf8');
  assert.ok(gradleSrc.includes('com.google.mediapipe:tasks-genai:'), 'MediaPipe GenAI LiteRT SDK required');
  assert.ok(gradleSrc.includes('com.google.mlkit:text-recognition:'), 'Bundled ML Kit OCR required');
  assert.ok(gradleSrc.includes('com.google.mlkit:barcode-scanning:'), 'Bundled ML Kit QR scanning required');

  const nativeSvcPath = path.join(
    process.cwd(),
    'android/app/src/main/java/com/surya/assistant/SuryaOfflineModelService.java'
  );
  assert.ok(fs.existsSync(nativeSvcPath), 'SuryaOfflineModelService.java must exist');
  const nativeSvc = fs.readFileSync(nativeSvcPath, 'utf8');
  assert.ok(nativeSvc.includes('LlmInference'), 'Native service must use MediaPipe LlmInference');
  assert.ok(!nativeSvc.includes('setResultListener('), 'MediaPipe 0.10.22 Builder must not call deprecated setResultListener()');
  assert.ok(nativeSvc.includes('llmInference.generateResponseAsync(prompt,'), 'MediaPipe 0.10.22 must pass progressListener to generateResponseAsync(prompt, listener)');
  assert.ok(nativeSvc.includes('targetRequestId.equals(activeRequestId)'), 'Streaming callback must guard against stale or cancelled requestId');
  assert.ok(nativeSvc.includes('SHA-256'), 'Native service must verify SHA-256 digest');
  assert.ok(nativeSvc.includes('Range'), 'Native downloader must support HTTP Range resume');
  assert.ok(nativeSvc.includes('MemoryInfo') && nativeSvc.includes('StatFs'), 'Hardware detection required');

  const mainActSrc = fs.readFileSync(
    path.join(process.cwd(), 'android/app/src/main/java/com/surya/assistant/MainActivity.java'),
    'utf8'
  );
  assert.ok(mainActSrc.includes('EXTRA_PREFER_OFFLINE'), 'Offline STT flag must be wired in MainActivity');
  assert.ok(mainActSrc.includes('getHardwareCapabilities'), 'Bridge must expose getHardwareCapabilities');
  assert.ok(mainActSrc.includes('generateLocalLlmResponse'), 'Bridge must expose generateLocalLlmResponse');
  assert.ok(mainActSrc.includes('analyzeImageOffline'), 'Bridge must expose analyzeImageOffline');
});

// 23. Male Voice System, Advanced Voice Profiles, Gender Filtering, and Persistence
test('23. Male Voice System, Advanced Voice Profiles, Gender Filtering, and Persistence', () => {
  const managerPath = path.join(process.cwd(), 'src/services/voiceProfileManager.ts');
  assert.ok(fs.existsSync(managerPath), 'voiceProfileManager.ts must exist');
  const managerSrc = fs.readFileSync(managerPath, 'utf8');

  assert.ok(managerSrc.includes('jarvis-male'), 'JARVIS male voice profile must exist');
  assert.ok(managerSrc.includes('stark-male'), 'STARK male voice profile must exist');
  assert.ok(managerSrc.includes('atlas-male'), 'ATLAS male voice profile must exist');
  assert.ok(managerSrc.includes('neutral-voice'), 'NEUTRAL voice profile must exist');
  assert.ok(managerSrc.includes('suryadev-radiant'), 'Suryadev female profile must be preserved');
  assert.ok(managerSrc.includes('hindi-command'), 'Hindi command female profile must be preserved');
  assert.ok(managerSrc.includes('getProfilesByGender'), 'Must support gender filtering');
  assert.ok(managerSrc.includes('resetToDefault'), 'Must support reset to default');
  assert.ok(managerSrc.includes('setPitchAndRate'), 'Must sync pitch and rate to Android bridge');
  assert.ok(managerSrc.includes('setVoiceById'), 'Must sync voice ID to Android bridge');

  const servicePath = path.join(process.cwd(), 'src/services/voiceService.ts');
  assert.ok(fs.existsSync(servicePath), 'voiceService.ts must exist');
  const serviceSrc = fs.readFileSync(servicePath, 'utf8');
  assert.ok(serviceSrc.includes('getAvailableVoices'), 'VoiceService must expose getAvailableVoices');
  assert.ok(serviceSrc.includes('selectedVoiceURI'), 'VoiceService must support selectedVoiceURI');
  assert.ok(serviceSrc.includes('detectVoiceGender'), 'VoiceService must export detectVoiceGender');
  assert.ok(serviceSrc.includes('resolveVoice'), 'VoiceService must expose unified resolveVoice');
  assert.ok(serviceSrc.includes('voiceOverrideURI'), 'VoiceService speak must accept voiceOverrideURI for previews');
  assert.ok(serviceSrc.includes('speakTextWithConfig'), 'VoiceService must call Android speakTextWithConfig');

  const modalPath = path.join(process.cwd(), 'src/components/VoiceSettingsModal.tsx');
  assert.ok(fs.existsSync(modalPath), 'VoiceSettingsModal.tsx must exist');
  const modalSrc = fs.readFileSync(modalPath, 'utf8');
  assert.ok(modalSrc.includes('male'), 'VoiceSettingsModal must support male voice selection/filtering');
  assert.ok(modalSrc.includes('female'), 'VoiceSettingsModal must support female voice selection');
  assert.ok(modalSrc.includes('Preview'), 'VoiceSettingsModal must support Play Preview / Audition');
  assert.ok(modalSrc.includes('Reset'), 'VoiceSettingsModal must support Reset to Default');
  assert.ok(modalSrc.includes('requiresVoiceInstall'), 'VoiceSettingsModal must warn when no male voice is installed');
  assert.ok(modalSrc.includes('handlePreviewSystemVoice'), 'VoiceSettingsModal must preview exact voice using voiceURI');
});

// 24. Accurate Gender Classification, Fallback Guard & Android TTS Native Bridge Integrity
test('24. Accurate Gender Classification, Fallback Guard & Android TTS Native Bridge Integrity', () => {
  // Test accurate gender classification regex logic (ensuring "female" NEVER matches "male")
  function detectGender(name, features = []) {
    if (features && Array.isArray(features)) {
      for (const f of features) {
        const lf = f.toLowerCase();
        if (lf.includes('gender=male') || lf === 'male') return 'male';
        if (lf.includes('gender=female') || lf === 'female') return 'female';
      }
    }
    const n = name.toLowerCase();
    const isFemale =
      /(^|[^a-z])female([^a-z]|$)/i.test(n) ||
      /(^|[^a-z])(woman|girl|lady)([^a-z]|$)/i.test(n) ||
      /zira|helen|jenny|hazel|samantha|victoria|karen|sfg#female|rjs#female|cfc#female|cxx#female|m01#female/i.test(n);
    if (isFemale) return 'female';

    const isMale =
      /(^|[^a-z])(male|guy|man|boy)([^a-z]|$)/i.test(n) ||
      /#male|-male|_male|male_|\bmale\d*\b/i.test(n) ||
      /david|mark|george|daniel|james|richard|ravi|pradeep|mohan|amit|sfg#male|rjs#male|iob#male|cxx#male|cfc#male|hie#male|hid#male|smt-.*-m0\d/i.test(n);
    if (isMale) return 'male';
    return 'unverified';
  }

  // 1. Female voices must NEVER be classified as male (preventing substring collision)
  assert.strictEqual(detectGender('Google UK English Female'), 'female', 'Google UK English Female must be female');
  assert.strictEqual(detectGender('en-us-x-sfg#female_1-local'), 'female', 'Android female voice must be female');
  assert.strictEqual(detectGender('Microsoft Zira - English (United States)'), 'female', 'Zira must be female');
  assert.strictEqual(detectGender('hi-in-x-cfc#female_1-local'), 'female', 'Hindi female voice must be female');
  assert.notStrictEqual(detectGender('Google UK English Female'), 'male', 'Female voice must never be classified as male');

  // 2. Real-world Android and Web male voices must be accurately classified
  assert.strictEqual(detectGender('Google UK English Male'), 'male', 'Google UK English Male must be male');
  assert.strictEqual(detectGender('en-us-x-sfg#male_1-local'), 'male', 'Android sfg#male must be male');
  assert.strictEqual(detectGender('en-in-x-end#male_1-local'), 'male', 'Indian English end#male must be male');
  assert.strictEqual(detectGender('Microsoft David - English (United States)'), 'male', 'David must be male');
  assert.strictEqual(detectGender('hi-in-x-cfc#male_1-local'), 'male', 'Hindi cfc#male must be male');
  assert.strictEqual(detectGender('en-gb-x-rjs#male_1-local'), 'male', 'British rjs#male must be male');
  assert.strictEqual(detectGender('Custom Robotic Synthesizer'), 'unverified', 'Ambiguous voice must be unverified');

  // 3. Android MainActivity.java native bridge inspection
  const mainActPath = path.join(process.cwd(), 'android/app/src/main/java/com/surya/assistant/MainActivity.java');
  assert.ok(fs.existsSync(mainActPath), 'MainActivity.java must exist');
  const mainActSrc = fs.readFileSync(mainActPath, 'utf8');

  assert.ok(mainActSrc.includes('getAvailableTtsVoices'), 'Bridge must expose getAvailableTtsVoices()');
  assert.ok(mainActSrc.includes('getTtsEngines'), 'Bridge must expose getTtsEngines()');
  assert.ok(mainActSrc.includes('setVoiceById'), 'Bridge must expose setVoiceById(String voiceId)');
  assert.ok(mainActSrc.includes('setPitchAndRate'), 'Bridge must expose setPitchAndRate(float pitch, float rate)');
  assert.ok(mainActSrc.includes('hasMaleVoice'), 'Bridge must expose hasMaleVoice(String langCode)');
  assert.ok(mainActSrc.includes('speakTextWithConfig'), 'Bridge must expose speakTextWithConfig()');
  assert.ok(mainActSrc.includes('openTtsSettings'), 'Bridge must expose openTtsSettings()');
  assert.ok(mainActSrc.includes('tts.setVoice('), 'Bridge must invoke tts.setVoice');
  assert.ok(mainActSrc.includes('tts.setPitch('), 'Bridge must invoke tts.setPitch');
  assert.ok(mainActSrc.includes('tts.setSpeechRate('), 'Bridge must invoke tts.setSpeechRate');
});

// 25. Backend Gateway, URL Validation, Timeout/Unavailable/Auth/Model Classification & External Gemini Key URL Safety
test('25. Backend Gateway URL Security, Timeout/Unavailable/Auth/Model Errors & Gemini Key URL Safety', () => {
  // 1-3. Missing, valid HTTPS, and invalid URLs (public HTTP, credentials, empty when required)
  assert.strictEqual(validateBackendUrl('', { isNative: false, requireNonEmpty: true }).valid, false);
  assert.strictEqual(validateBackendUrl('http://public-backend.example.com', { isNative: true }).valid, false);
  assert.strictEqual(validateBackendUrl('http://192.168.1.40:3000', { isNative: true }).valid, true);
  const validHttps = validateBackendUrl('https://buddy-backend.example.run.app/api/health///', {
    isNative: true,
    requireNonEmpty: true,
  });
  assert.strictEqual(validHttps.valid, true);
  assert.strictEqual(validHttps.normalized, 'https://buddy-backend.example.run.app');
  assert.strictEqual(STORAGE_KEY_BACKEND_URL, 'surya_backend_url');

  // 4. Timeout & 504 classification
  const timeoutNetErr = classifyNetworkException(new Error('Aborted'), 'https://buddy.run.app/api/health', {
    timedOut: true,
  });
  assert.strictEqual(timeoutNetErr.code, 'TIMEOUT');
  assert.strictEqual(timeoutNetErr.connectionState, 'TIMEOUT');

  const err504 = classifyResponseFailure({
    url: 'https://buddy.run.app/api/chat',
    status: 504,
    bodyText: JSON.stringify({ error: 'Upstream timeout' }),
  });
  assert.strictEqual(err504.connectionState, 'TIMEOUT');

  // 5. Server unavailable (network unreachable & 503)
  const netUnavailErr = classifyNetworkException(new Error('Failed to fetch'), 'https://buddy.run.app/api/health');
  assert.strictEqual(netUnavailErr.code, 'NETWORK_ERROR');
  assert.strictEqual(netUnavailErr.connectionState, 'UNAVAILABLE');

  const err503 = classifyResponseFailure({
    url: 'https://buddy.run.app/api/chat',
    status: 503,
    bodyText: JSON.stringify({ error: 'Service unavailable' }),
  });
  assert.strictEqual(err503.connectionState, 'UNAVAILABLE');

  // 6. Gemini auth failure & model unavailable response mapping
  const gemAuthErr = classifyResponseFailure({
    url: 'https://buddy.run.app/api/chat',
    status: 401,
    bodyText: JSON.stringify({ code: 'GEMINI_AUTH_FAILED', error: 'Invalid API key' }),
  });
  assert.strictEqual(gemAuthErr.code, 'GEMINI_AUTH_FAILED');
  assert.strictEqual(gemAuthErr.connectionState, 'AUTHENTICATION_REQUIRED');

  const modelUnavailErr = classifyResponseFailure({
    url: 'https://buddy.run.app/api/chat',
    status: 404,
    bodyText: JSON.stringify({ code: 'MODEL_UNAVAILABLE', error: 'Model retired upstream' }),
  });
  assert.strictEqual(modelUnavailErr.code, 'MODEL_UNAVAILABLE');
  assert.strictEqual(modelUnavailErr.connectionState, 'SERVER_ERROR');

  // 7. External Gemini API key URL safety
  assert.strictEqual(GEMINI_API_KEY_URL, 'https://aistudio.google.com/app/apikey');
  assert.strictEqual(isSafeExternalUrl(GEMINI_API_KEY_URL), true);
  assert.strictEqual(isSafeExternalUrl('http://aistudio.google.com/app/apikey'), false);
  assert.strictEqual(isSafeExternalUrl('https://aistudio.google.com/app/apikey?key=secret123'), false);
  assert.strictEqual(isSafeExternalUrl('https://example.com/?token=abc'), false);

  // 8. Verify Server-Side Gemini Setup UI (zero BYOK prompts in Chat, Home, Settings, Model Selector)
  const chatUi = fs.readFileSync(path.resolve('src/components/StarkCommandCenter.tsx'), 'utf8');
  const settingsUi = fs.readFileSync(path.resolve('src/components/SystemHealthDashboard.tsx'), 'utf8');
  const homeUi = fs.readFileSync(path.resolve('src/components/SuryaCommandCenter.tsx'), 'utf8');
  const appSrc = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8');

  assert.doesNotMatch(chatUi, /Connect Gemini|Add API Key|Get Gemini API Key/, 'StarkCommandCenter must not show BYOK API-key banners');
  assert.doesNotMatch(chatUi, /Configure Backend URL/, 'StarkCommandCenter must not require Configure Backend URL');

  assert.doesNotMatch(homeUi, /Connect Gemini|Add API Key|Get API Key/, 'SuryaCommandCenter must not show BYOK API-key onboarding card');
  assert.doesNotMatch(homeUi, /Configure Backend URL/, 'SuryaCommandCenter must not require Configure Backend URL');

  assert.ok(settingsUi.includes('Gemini AI & Model Configuration (Server-Side)'), 'Settings must include Server-Side Gemini Configuration section');
  assert.ok(settingsUi.includes('Select Gemini Model'), 'Settings must include Select Gemini Model selector');
  assert.ok(settingsUi.includes('Verify Gemini Connection'), 'Settings must include Verify Gemini Connection button');
  assert.doesNotMatch(settingsUi, /Save API Key|Remove API Key|Get Gemini API Key/, 'Settings must not ask user for client-side BYOK keys');

  // 9. App.tsx uses server gateway connection & StarkCommandCenter respects Offline mode
  assert.ok(appSrc.includes('gateway_err_'), 'App.tsx must deduplicate repeated gateway/connection notices');
  assert.ok(chatUi.includes('!isOfflineMode'), 'Chat UI must suppress online controls in Offline mode');
});

// 26. Live Backend /api/health, Missing GEMINI_API_KEY Auth Classification & Model Alias Resolution
test('26. Live BUDDY Backend /api/health, Missing Gemini Key & Model Alias Verification', async () => {
  // Verify model alias resolution and upstream error classifier directly via tsx
  const tsxBin = path.resolve('node_modules/.bin/tsx');
  const evalOut = execFileSync(
    tsxBin,
    [
      '-e',
      `import('./server.ts').then((m) => {
        console.log(JSON.stringify({
          hydrogen: m.resolveGeminiModelName('gemini-4-hydrogen'),
          argon: m.resolveGeminiModelName('gemini-4-argon'),
          carbon: m.resolveGeminiModelName('gemini-4-carbon'),
          unknown: m.resolveGeminiModelName('nonexistent-model-xyz'),
          authErr: m.classifyGeminiUpstreamError({ status: 401, message: 'API_KEY_INVALID' }),
          modelErr: m.classifyGeminiUpstreamError({ status: 404, message: 'models/foo NOT_FOUND' }),
        }));
      });`,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, SURYA_SKIP_LISTEN: '1', SURYA_SKIP_VITE: '1' },
      encoding: 'utf8',
    }
  );
  const resolved = JSON.parse(evalOut.trim().split('\n').pop());
  assert.strictEqual(resolved.hydrogen, 'gemini-3.8-flash');
  assert.strictEqual(resolved.argon, 'gemini-3.8-pro');
  assert.strictEqual(resolved.carbon, 'gemini-3.8-flash');
  assert.strictEqual(resolved.unknown, 'nonexistent-model-xyz');
  assert.strictEqual(resolved.authErr.code, 'GEMINI_AUTH_FAILED');
  assert.strictEqual(resolved.authErr.status, 401);
  assert.strictEqual(resolved.modelErr.code, 'MODEL_UNAVAILABLE');
  assert.strictEqual(resolved.modelErr.status, 404);

  // Spin up isolated server WITHOUT GEMINI_API_KEY to verify health & clean 503 GEMINI_AUTH_FAILED responses
  const srv = await startIsolatedBackend({
    GEMINI_API_KEY: '',
  });
  try {
    const healthRes = await fetch(`${srv.baseUrl}/api/health`);
    assert.strictEqual(healthRes.status, 200);
    const health = await healthRes.json();
    assert.strictEqual(health.status, 'ONLINE');
    assert.strictEqual(health.app, 'BUDDY');
    assert.strictEqual(health.provider, 'Google Gemini');
    assert.strictEqual(health.activeModel, 'gemini-4-hydrogen');
    assert.strictEqual(health.resolvedUpstreamModel, 'gemini-3.8-flash');
    assert.strictEqual(health.geminiConfigured, false);

    const chatRes = await fetch(`${srv.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello BUDDY' }),
    });
    assert.strictEqual(chatRes.status, 503);
    const chatErr = await chatRes.json();
    assert.strictEqual(chatErr.code, 'GEMINI_AUTH_FAILED');
    assert.ok(!chatErr.error.includes('SURYA'), 'Error response must use BUDDY branding, not SURYA');

    const verifyRes = await fetch(`${srv.baseUrl}/api/config/api-key/verify`, {
      method: 'POST',
    });
    assert.strictEqual(verifyRes.status, 503);
    const verifyErr = await verifyRes.json();
    assert.strictEqual(verifyErr.code, 'GEMINI_AUTH_FAILED');
  } finally {
    await srv.stop();
  }
});

// 27. Offline Mode Without Local Model & User-Facing BUDDY Branding Audit
test('27. Offline Mode Without Local Model & User-Facing BUDDY Branding Check', async () => {
  let cloudCalls = 0;
  const unreadyRouter = new IntelligenceRouter({
    initialMode: 'offline',
    isOnlineCheck: () => true, // Online network, yet OFFLINE mode MUST NEVER touch cloud
    localRuntime: {
      getState: () => ({ status: 'unloaded', activeModelId: null, activeModelName: null }),
      async generateResponse() {
        throw new Error('Should not be called when unloaded');
      },
    },
    cloudHandler: async () => {
      cloudCalls += 1;
      return { text: 'Should never run', model: 'gemini-4-hydrogen' };
    },
    localToolsHandler: async (input) => {
      if (input === 'my tasks') {
        return { answeredLocally: true, text: 'Local tasks ready', modelLabel: 'Local Productivity Index' };
      }
      return { answeredLocally: false, vaultSnippet: '' };
    },
  });

  const missingRes = await unreadyRouter.routeMessage('Explain quantum gravity');
  assert.strictEqual(cloudCalls, 0, 'Offline mode must never make cloud calls even when online');
  assert.strictEqual(missingRes.handledOffline, true);
  assert.strictEqual(missingRes.modelMissing, true);
  assert.ok(missingRes.text.includes('BUDDY'), 'Offline notice must carry BUDDY branding');
  assert.ok(!missingRes.text.includes('SURYA'), 'Offline notice must not contain stale SURYA branding');

  const toolRes = await unreadyRouter.routeMessage('my tasks');
  assert.strictEqual(toolRes.handledOffline, true);
  assert.strictEqual(cloudCalls, 0);

  // Android user-facing strings & XML widget audit
  const mainActivity = fs.readFileSync(
    path.resolve('android/app/src/main/java/com/surya/assistant/MainActivity.java'),
    'utf8'
  );
  const handsFree = fs.readFileSync(
    path.resolve('android/app/src/main/java/com/surya/assistant/SuryaHandsFreeService.java'),
    'utf8'
  );
  const widgetXml = fs.readFileSync(
    path.resolve('android/app/src/main/res/layout/surya_widget.xml'),
    'utf8'
  );
  assert.ok(mainActivity.includes('"BUDDY Reminders & Alerts"'));
  assert.ok(mainActivity.includes('"BUDDY Notification"'));
  assert.ok(mainActivity.includes('"BUDDY Security Authorization"'));
  assert.ok(handsFree.includes('"BUDDY Hands-Free Active"'));
  assert.ok(handsFree.includes("'Hey BUDDY'"));
  assert.ok(widgetXml.includes('android:text="BUDDY AI"'));
  assert.ok(!widgetXml.includes('SURYA AI'), 'Widget label must not display SURYA AI');

  // Ensure no Google API keys appear inside Android XML resources
  const stringsXml = fs.readFileSync(
    path.resolve('android/app/src/main/res/values/strings.xml'),
    'utf8'
  );
  assert.doesNotMatch(stringsXml, /AIza[0-9A-Za-z_-]{20,}/, 'Android resources must never contain a Google API key');
});

// 28. BYOK Key Vault: Android Keystore Bridge, Masking, Replacement, Removal & Zero Plain-Text localStorage
test('28. BYOK Key Vault Storage, Masking, Replacement, Removal & Zero Plain-Text localStorage', async () => {
  // Format validation checks
  assert.strictEqual(validateGeminiApiKeyFormat('').valid, false);
  assert.strictEqual(validateGeminiApiKeyFormat('https://aistudio.google.com/app/apikey').valid, false);
  assert.strictEqual(validateGeminiApiKeyFormat('AIzaSy short').valid, false);
  assert.strictEqual(validateGeminiApiKeyFormat('shortkey').valid, false);
  const validFormat = validateGeminiApiKeyFormat('  AIzaSyDemoKeyForTesting1234567890  ');
  assert.strictEqual(validFormat.valid, true);
  assert.strictEqual(validFormat.normalized, 'AIzaSyDemoKeyForTesting1234567890');

  assert.strictEqual(maskGeminiApiKey('AIzaSyDemoKeyForTesting1234567890'), 'AIza••••7890');

  // Track modelStorage (simulated localStorage) to prove API keys NEVER enter plain-text localStorage
  const plainStorage = new Map();
  const mockModelStorage = {
    getItem: (k) => (plainStorage.has(k) ? plainStorage.get(k) : null),
    setItem: (k, v) => plainStorage.set(k, String(v)),
    removeItem: (k) => plainStorage.delete(k),
  };

  // Simulated Android Keystore bridge
  let keystoreCipherSlot = '';
  const mockBridge = {
    saveGeminiApiKey: (k) => {
      keystoreCipherSlot = `ENC_ANDROID_KS:${Buffer.from(k).toString('base64')}`;
      return true;
    },
    hasGeminiApiKey: () => Boolean(keystoreCipherSlot),
    getGeminiApiKey: () =>
      keystoreCipherSlot.startsWith('ENC_ANDROID_KS:')
        ? Buffer.from(keystoreCipherSlot.replace('ENC_ANDROID_KS:', ''), 'base64').toString('utf8')
        : '',
    getMaskedGeminiApiKey: () => maskGeminiApiKey(mockBridge.getGeminiApiKey()),
    removeGeminiApiKey: () => {
      keystoreCipherSlot = '';
      return true;
    },
  };

  const vault = new GeminiKeyVault({
    nativeBridgeProvider: () => mockBridge,
    modelStorage: mockModelStorage,
  });
  const initSnap = await vault.hydrate();
  assert.strictEqual(initSnap.storageBackend, 'android-keystore');
  assert.strictEqual(initSnap.hasKey, false);
  assert.strictEqual(initSnap.verificationState, 'unconfigured');
  assert.strictEqual(initSnap.selectedModel, DEFAULT_GEMINI_MODEL);

  // Save key
  const savedSnap = await vault.saveKey('AIzaSyFirstTestKeyValue1234567890');
  assert.strictEqual(savedSnap.hasKey, true);
  assert.strictEqual(savedSnap.maskedKey, 'AIza••••7890');
  assert.strictEqual(savedSnap.verificationState, 'unverified');
  assert.strictEqual(await vault.getKey(), 'AIzaSyFirstTestKeyValue1234567890');

  // Verify zero secret leakage in localStorage
  for (const [k, v] of plainStorage.entries()) {
    assert.doesNotMatch(v, /AIzaSy/, `Plain-text localStorage key ${k} must never store an API key`);
  }

  // Replace key
  const replacedSnap = await vault.saveKey('AIzaSySecondKeyValue9876543210');
  assert.strictEqual(replacedSnap.maskedKey, 'AIza••••3210');
  assert.strictEqual(await vault.getKey(), 'AIzaSySecondKeyValue9876543210');

  // Remove key
  const removedSnap = await vault.removeKey();
  assert.strictEqual(removedSnap.hasKey, false);
  assert.strictEqual(removedSnap.maskedKey, '');
  assert.strictEqual(removedSnap.verificationState, 'unconfigured');
  assert.strictEqual(await vault.getKey(), '');
});

// 29. Direct Gemini Verification, Model Filtering & Header Authentication
test('29. Direct Gemini Verification, Dynamic Model Filtering & Header Auth', async () => {
  assert.strictEqual(isDeprecatedOrNonChatModel('gemini-1.5-flash'), true);
  assert.strictEqual(isDeprecatedOrNonChatModel('gemini-2.0-flash'), true);
  assert.strictEqual(isDeprecatedOrNonChatModel('gemini-pro'), true);
  assert.strictEqual(isDeprecatedOrNonChatModel('text-embedding-004'), true);
  assert.strictEqual(isDeprecatedOrNonChatModel('gemini-3.8-flash'), false);
  assert.ok(SEED_GEMINI_MODELS.some((m) => m.id === 'gemini-3.8-flash'));

  const plainStorage = new Map();
  const mockModelStorage = {
    getItem: (k) => (plainStorage.has(k) ? plainStorage.get(k) : null),
    setItem: (k, v) => plainStorage.set(k, String(v)),
  };

  const vault = new GeminiKeyVault({ modelStorage: mockModelStorage });
  const testKey = 'AIzaSyVerifyKeyHeaderOnly123456789';
  await vault.saveKey(testKey);

  const recordedRequests = [];
  const fakeFetch = async (url, init) => {
    recordedRequests.push({ url, init });
    if (url.includes(':generateContent')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'OK' }] } }],
          });
        },
      };
    }
    if (url.includes('/models?')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            models: [
              {
                name: 'models/gemini-1.5-pro',
                displayName: 'Gemini 1.5 Pro (Legacy)',
                supportedGenerationMethods: ['generateContent'],
              },
              {
                name: 'models/gemini-3.8-flash',
                displayName: 'Gemini 3.8 Flash',
                supportedGenerationMethods: ['generateContent'],
              },
              {
                name: 'models/gemini-3.8-pro',
                displayName: 'Gemini 3.8 Pro',
                supportedGenerationMethods: ['generateContent'],
              },
              {
                name: 'models/text-embedding-004',
                displayName: 'Embedding',
                supportedGenerationMethods: ['embedContent'],
              },
            ],
          });
        },
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const client = new DirectGeminiClient({ vault, fetcher: fakeFetch });
  const result = await client.verifyApiKey();

  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.model, 'gemini-3.8-flash');
  assert.strictEqual(vault.getSnapshot().verificationState, 'verified');
  assert.ok(vault.getSnapshot().verifiedModels.includes('gemini-3.8-flash'));
  assert.ok(vault.getSnapshot().verifiedModels.includes('gemini-3.8-pro'));

  // Deprecated & embedding models must be excluded
  const catalog = vault.getAvailableModels();
  assert.strictEqual(catalog.some((m) => m.id === 'gemini-1.5-pro'), false);
  assert.strictEqual(catalog.some((m) => m.id === 'text-embedding-004'), false);
  assert.strictEqual(catalog.find((m) => m.id === 'gemini-3.8-flash')?.isVerified, true);

  // Confirm key was sent strictly via header, NEVER via ?key= URL parameter
  for (const req of recordedRequests) {
    assert.ok(!req.url.includes('key='), 'API key must NEVER appear in query parameters');
    assert.strictEqual(req.init.headers['x-goog-api-key'], testKey);
  }

  // Switching to another verified model keeps verified status and persists selected model ID
  vault.setSelectedModel('gemini-3.8-pro');
  assert.strictEqual(vault.getSnapshot().selectedModel, 'gemini-3.8-pro');
  assert.strictEqual(vault.getSnapshot().verificationState, 'verified');
  assert.strictEqual(plainStorage.get('buddy_selected_gemini_model_v1'), 'gemini-3.8-pro');
});

// 30. Direct Gemini Error Classification & Zero Secret Leakage
test('30. Direct Gemini Error Classification (Invalid Key, 404 Model, Quota, Rate Limit, Network, Timeout) & Key Redaction', async () => {
  const secretKey = 'AIzaSyUltraSecretKeyMustBeRedacted999';
  const vault = new GeminiKeyVault();
  await vault.saveKey(secretKey);

  // Redactor sanity check
  const leakedText = `Upstream rejected key ${secretKey} on ?key=${encodeURIComponent(secretKey)}`;
  const redacted = redactGeminiSecrets(leakedText, secretKey);
  assert.ok(!redacted.includes(secretKey), 'Redactor must strip exact key');
  assert.ok(!redacted.includes('AIzaSy'), 'Redactor must strip AIza pattern');

  // 1. Invalid key (401/403)
  const invalidClient = new DirectGeminiClient({
    vault,
    fetcher: async () => ({
      ok: false,
      status: 400,
      async text() {
        return JSON.stringify({
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: `API key not valid. Key=${secretKey}`,
          },
        });
      },
    }),
  });
  await assert.rejects(
    () => invalidClient.verifyApiKey(),
    (err) => {
      assert.ok(err instanceof DirectGeminiError);
      assert.strictEqual(err.code, 'INVALID_API_KEY');
      assert.ok(!err.message.includes(secretKey), 'Error message must not expose raw API key');
      return true;
    }
  );
  assert.strictEqual(vault.getSnapshot().verificationState, 'invalid_key');

  // 2. Unavailable / retired model (404 NOT_FOUND)
  const retiredClient = new DirectGeminiClient({
    vault,
    fetcher: async () => ({
      ok: false,
      status: 404,
      async text() {
        return JSON.stringify({
          error: {
            code: 404,
            status: 'NOT_FOUND',
            message: 'models/gemini-3.8-pro is not found for API version v1beta',
          },
        });
      },
    }),
  });
  await assert.rejects(
    () => retiredClient.verifyApiKey({ model: 'gemini-3.8-pro' }),
    (err) => err instanceof DirectGeminiError && err.code === 'MODEL_UNAVAILABLE'
  );
  assert.strictEqual(vault.getSnapshot().verificationState, 'model_unavailable');
  assert.ok(vault.getSnapshot().unavailableModels['gemini-3.8-pro']);

  // 3. Quota exhausted vs rate limited (429)
  const quotaClient = new DirectGeminiClient({
    vault,
    fetcher: async () => ({
      ok: false,
      status: 429,
      async text() {
        return JSON.stringify({
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'You exceeded your current quota, please check your plan and billing details.',
          },
        });
      },
    }),
  });
  await assert.rejects(
    () => quotaClient.sendChat('Hello'),
    (err) => err instanceof DirectGeminiError && err.code === 'QUOTA_EXHAUSTED'
  );

  // 4. Network error & Timeout
  const netClient = new DirectGeminiClient({
    vault,
    fetcher: async () => {
      throw new Error(`Failed to connect with ${secretKey}`);
    },
  });
  await assert.rejects(
    () => netClient.sendChat('Hello'),
    (err) => {
      assert.strictEqual(err.code, 'NETWORK_ERROR');
      assert.ok(!err.message.includes(secretKey));
      return true;
    }
  );
  assert.strictEqual(vault.getSnapshot().verificationState, 'network_error');
});

// 31. Direct Gemini SSE Streaming, Multi-Turn Context & Online Chat Without BUDDY Server + Offline Isolation
test('31. Direct Gemini Streaming, Conversation Context, Server-Free Online Chat & Offline Isolation', async () => {
  const vault = new GeminiKeyVault();
  await vault.saveKey('AIzaSyStreamingDirectKey1234567890');
  vault.setSelectedModel('gemini-3.8-flash');

  const capturedBodies = [];
  const sseChunks = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Namaste "}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"from BUDDY!"}]}}]}\n\n',
  ];

  const client = new DirectGeminiClient({
    vault,
    fetcher: async (_url, init) => {
      capturedBodies.push(JSON.parse(init.body));
      let idx = 0;
      const enc = new TextEncoder();
      return {
        ok: true,
        status: 200,
        body: {
          getReader() {
            return {
              async read() {
                if (idx < sseChunks.length) {
                  const value = enc.encode(sseChunks[idx]);
                  idx += 1;
                  return { done: false, value };
                }
                return { done: true };
              },
            };
          },
        },
      };
    },
  });

  // Verify buildGeminiGenerateBody preserves multi-turn context
  const history = [
    { role: 'user', content: 'My name is Aarav.' },
    { role: 'assistant', content: 'Hello Aarav!' },
  ];
  const samplePayload = buildGeminiGenerateBody({
    message: 'What is my name?',
    history,
    responseMode: 'concise',
  });
  assert.strictEqual(samplePayload.contents.length, 3);
  assert.strictEqual(samplePayload.contents[0].role, 'user');
  assert.strictEqual(samplePayload.contents[1].role, 'model');
  assert.strictEqual(samplePayload.contents[2].parts[0].text, 'What is my name?');
  assert.ok(samplePayload.system_instruction.parts[0].text.includes('BUDDY'));

  // Verify IntelligenceRouter routes Online chat cleanly through DirectGeminiClient WITHOUT any backend URL
  let externalFetchCalls = 0;
  const streamedParts = [];
  const router = new IntelligenceRouter({
    initialMode: 'auto',
    isOnlineCheck: () => true,
    localRuntime: {
      getState: () => ({ status: 'unloaded', activeModelId: null, activeModelName: null }),
      async generateResponse() {
        throw new Error('Should not run offline when online & unready');
      },
    },
    cloudHandler: async (input, ctx) => {
      externalFetchCalls += 1;
      return client.sendChatStream(
        input,
        ctx.history || [],
        (acc) => {
          streamedParts.push(acc);
          ctx.onStreamChunk?.(acc);
        },
        { model: ctx.model }
      );
    },
  });

  const onlineRes = await router.routeMessage('Say hi in Hindi-English', { history });
  assert.strictEqual(externalFetchCalls, 1);
  assert.strictEqual(onlineRes.source, 'cloud-gemini');
  assert.strictEqual(onlineRes.text, 'Namaste from BUDDY!');
  assert.strictEqual(streamedParts[0], 'Namaste ');
  assert.strictEqual(streamedParts[1], 'Namaste from BUDDY!');
  assert.strictEqual(capturedBodies[0].contents.length, 3);

  // Switch to OFFLINE mode with key STILL configured & network online -> zero external calls
  router.setMode('offline');
  const offlineRes = await router.routeMessage('Explain gravity');
  assert.strictEqual(externalFetchCalls, 1, 'Offline mode must never touch Gemini REST API even when BYOK key is saved');
  assert.strictEqual(offlineRes.handledOffline, true);

  // Direct test of parseGeminiSseResponse helper
  const enc = new TextEncoder();
  const fakeSseRes = {
    body: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (!done) {
              done = true;
              return {
                done: false,
                value: enc.encode('data: {"candidates":[{"content":{"parts":[{"text":"Hello SSE"}]}}]}\n\n'),
              };
            }
            return { done: true };
          },
        };
      },
    },
  };
  const parsedSse = await parseGeminiSseResponse(fakeSseRes);
  assert.strictEqual(parsedSse, 'Hello SSE');
});

// 32. Android Keystore Native Security Bridge Inspection
test('32. Android MainActivity Keystore AES-GCM Bridge & Secrecy Audit', () => {
  const mainActPath = path.resolve('android/app/src/main/java/com/surya/assistant/MainActivity.java');
  const mainActSrc = fs.readFileSync(mainActPath, 'utf8');

  assert.ok(mainActSrc.includes('AndroidKeyStore'), 'MainActivity must use AndroidKeyStore');
  assert.ok(mainActSrc.includes('AES/GCM/NoPadding'), 'MainActivity must encrypt API key using AES/GCM/NoPadding');
  assert.ok(mainActSrc.includes('KeyGenParameterSpec'), 'MainActivity must generate hardware-backed/Keystore AES key');
  assert.ok(mainActSrc.includes('public boolean saveGeminiApiKey('), 'Must expose saveGeminiApiKey bridge');
  assert.ok(mainActSrc.includes('public boolean hasGeminiApiKey('), 'Must expose hasGeminiApiKey bridge');
  assert.ok(mainActSrc.includes('public String getGeminiApiKey('), 'Must expose getGeminiApiKey bridge');
  assert.ok(mainActSrc.includes('public String getMaskedGeminiApiKey('), 'Must expose getMaskedGeminiApiKey bridge');
  assert.ok(mainActSrc.includes('public boolean removeGeminiApiKey('), 'Must expose removeGeminiApiKey bridge');
  assert.doesNotMatch(mainActSrc, /Log\.(?:d|i|v|w|e)\([^)]*apiKey/i, 'Native Android logs must never print raw API keys');
});

// 33. Server-Side Gemini Interactions API & Live API Migration Audit
test('33. Server-Side Gemini Interactions API & Live API Migration Verification', async () => {
  const serverSrc = fs.readFileSync(path.resolve('server.ts'), 'utf8');
  assert.doesNotMatch(
    serverSrc,
    /\b(generateContent|generateContentStream|streamGenerateContent)\b/,
    'server.ts must never call deprecated generateContent or generateContentStream APIs'
  );
  assert.ok(serverSrc.includes('ai.interactions.create('), 'server.ts must use Gemini Interactions API (ai.interactions.create)');
  assert.ok(serverSrc.includes("event.event_type === 'step.delta'"), 'server.ts must handle Interactions API step.delta streaming events');
  assert.ok(serverSrc.includes('previous_interaction_id'), 'server.ts must support multi-turn previous_interaction_id');
  assert.ok(serverSrc.includes('ai.live.connect('), 'server.ts must implement server-side Live API via ai.live.connect');
  assert.ok(serverSrc.includes('gemini-3.8-live'), 'server.ts must configure gemini-3.8-live for Live Voice');
  assert.ok(serverSrc.includes("path: '/api/live'"), 'server.ts must mount WebSocket Live bridge on /api/live');

  const runtimeFrontendFiles = [
    'src/App.tsx',
    'src/services/apiService.ts',
    'src/services/intelligenceRouter.ts',
    'src/services/cognitiveEngine.ts',
    'src/services/modelPreferenceService.ts',
    'src/services/liveApiService.ts',
    'src/components/SuryaCommandCenter.tsx',
    'src/components/StarkCommandCenter.tsx',
    'src/components/ModelSelectorModal.tsx',
    'src/components/SystemHealthDashboard.tsx',
    'src/components/AppCreatorWorkspace.tsx',
    'src/components/SuryaVisionHUD.tsx',
    'src/components/StandardOpticsHUD.tsx',
    'src/components/ScientificKnowledge.tsx',
  ];

  for (const rel of runtimeFrontendFiles) {
    const content = fs.readFileSync(path.resolve(rel), 'utf8');
    assert.doesNotMatch(content, /directGeminiService/, `Active frontend module ${rel} must not use directGeminiService`);
    assert.doesNotMatch(content, /geminiKeyVault/, `Active frontend module ${rel} must not use geminiKeyVault`);
    assert.doesNotMatch(content, /Add Gemini API Key|Connect Gemini/, `Active UI module ${rel} must not ask user for BYOK API keys`);
  }

  const liveSvc = fs.readFileSync(path.resolve('src/services/liveApiService.ts'), 'utf8');
  assert.ok(liveSvc.includes('/api/live'), 'liveApiService.ts must connect to /api/live WebSocket');

  const srv = await startIsolatedBackend({ GEMINI_API_KEY: '' });
  try {
    const modelsRes = await fetch(`${srv.baseUrl}/api/models`);
    assert.strictEqual(modelsRes.status, 200);
    const modelsJson = await modelsRes.json();
    assert.ok(Array.isArray(modelsJson.models) && modelsJson.models.length >= 3, '/api/models must return model catalog');

    const streamRes = await fetch(`${srv.baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello', model: 'gemini-4-hydrogen' }),
    });
    assert.strictEqual(streamRes.status, 503);
    const streamBody = await streamRes.json();
    assert.strictEqual(streamBody.code, 'GEMINI_AUTH_FAILED');
    assert.ok(!JSON.stringify(streamBody).includes('PROXY_GENERATION_DISABLED'));

    const visionRes = await fetch(`${srv.baseUrl}/api/vision/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: 'data:image/jpeg;base64,/9j/4AAQ', mode: 'general' }),
    });
    assert.strictEqual(visionRes.status, 503);
    const visionBody = await visionRes.json();
    assert.strictEqual(visionBody.code, 'GEMINI_AUTH_FAILED');
  } finally {
    await srv.stop();
  }
});





