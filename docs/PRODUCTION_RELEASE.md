# BUDDY — Production Release, Architecture & Android Verification Guide

## 1. Gemini Architecture Decision & Trade-Offs

**Selected Production Architecture:** Server-Side Gemini Interactions API (`ai.interactions.create`) + Authenticated WebSocket Live API (`ai.live.connect` on `WSS /api/live`) in `server.ts`, backed by `process.env.GEMINI_API_KEY`.

| Criterion | Server-Side Interactions + Live API (Chosen) | Client-Side BYOK (`DirectGeminiClient`) |
| --- | --- | --- |
| **API Key Secrecy** | Zero keys in web `dist/` or Android APK; keys stay in Cloud Run / server env. | User key lives on device (encrypted via Android Keystore AES-GCM / WebCrypto). |
| **Multi-Turn Context** | Native `previous_interaction_id` chaining + SSE `step.delta` streaming. | Client resends full transcript history on each request. |
| **Live Voice** | Authenticated single-use ticket (`POST /api/live/ticket`) over origin-checked `WSS /api/live`. | Requires shipping or proxying upstream credentials client-side. |
| **Resilience & Rate Limiting** | Centralized rate limits, automatic model fallback (`gemini-4-hydrogen` → `gemini-3.8-flash`), namespace isolation. | Subject to per-client network drops & manual model recovery. |
| **Offline Independence** | Completely isolated: `offline` mode disables all cloud calls and routes strictly to MediaPipe Tasks GenAI, ML Kit, and local intents. | Same local routing applies offline. |

> Legacy helper modules (`src/services/byokGeminiHelpers.js`, `src/services/directGeminiService.ts`, and `MainActivity.java` Keystore AES-GCM methods) are retained solely for backward test compatibility and are not invoked by active chat/live routes.

---

## 2. Security & Hardening Summary

- **Web & Server (`server.ts`)**
  - Strict CORS origin allowlist (`APP_URL`, `ALLOWED_ORIGINS`, Capacitor `https://localhost`, `capacitor://localhost`).
  - `POST /api/live/ticket` + `WSS /api/live` `verifyClient` origin validation, single-use ticket consumption, `256 KiB` max payload, and 80 frames/s rate cap.
  - Per-user namespace isolation across Memory (`PUT /api/memory/:id`), Studio apps (multi-file bundle export), and Veronica challenges/audit logs.
  - Fail-closed `VERONICA_OPERATOR_PIN` verification using `crypto.timingSafeEqual` (no client-side hardcoded PINs) + authentic `ANDROID_KEYSTORE_BIOMETRIC` / `WEBAUTHN_HARDWARE_BIOMETRIC` verification.
  - Magic-byte / MIME checks & 14 MB limit in `extractImagePayload()` for Vision endpoints; whitespace prompt rejection.
  - `GET /api/ready` readiness probe alongside `GET /api/health`; non-root `USER node` Docker execution.
- **Studio Preview (`AppCreatorWorkspace.tsx`)**
  - Restrictive `<meta http-equiv="Content-Security-Policy" ... connect-src 'none'; form-action 'none';>` injected into preview iframe.
  - `SURYA_SANDBOX_ERROR` listener validates `ev.source === iframeRef.current?.contentWindow` and per-session nonce.
- **Android APK (`capacitor.config.ts`, `AndroidManifest.xml`, `build.gradle`, `proguard-rules.pro`)**
  - `cleartext: false`, `allowMixedContent: false`, `webContentsDebuggingEnabled: false`, `android:allowBackup="false"`, `android:usesCleartextTraffic="false"`.
  - Release build enables R8 (`minifyEnabled true`, `shrinkResources true`) with explicit ProGuard keep rules for `com.surya.assistant.**`, MediaPipe GenAI, ML Kit OCR/Barcode, Capacitor, and Biometrics.
  - Version bumped to `versionCode 130` (`versionName "1.3.0"`), with environment-driven `signingConfigs.release` (`BUDDY_KEYSTORE_PATH`, `BUDDY_KEYSTORE_PASSWORD`, `BUDDY_KEY_ALIAS`, `BUDDY_KEY_PASSWORD`).

---

## 3. Cloud Run Deployment & Rollback

```bash
export GCP_PROJECT_ID="your-project-id"
export GEMINI_API_KEY="your-server-side-gemini-key"
export SURYA_API_TOKEN="optional-bearer-token"
export VERONICA_OPERATOR_PIN="your-operator-pin"
export VERONICA_SECRET="$(openssl rand -hex 32)"
./deploy-cloudrun.sh
```

**Rollback:**
```bash
gcloud run revisions list --service surya-ai-backend --region "${REGION:-asia-east1}"
gcloud run services update-traffic surya-ai-backend --region "${REGION:-asia-east1}" --to-revisions <PREVIOUS_REVISION>=100
```

---

## 4. Android & Offline Verification Checklist (Physical Device / CI)

Run these checks in CI (`.github/workflows/android-apk.yml`) or on a workstation with JDK 21 + Android SDK 36 installed:

1. **Build & Verify Debug + Release APKs**
   ```bash
   npm run build
   mkdir -p android/app/src/main/assets/public && cp -r dist/* android/app/src/main/assets/public/
   cd android
   ./gradlew lintDebug assembleDebug --no-daemon
   # With release keystore env vars set:
   ./gradlew assembleRelease --no-daemon
   sha256sum app/build/outputs/apk/debug/*.apk
   apksigner verify --verbose app/build/outputs/apk/release/app-release.apk
   ```
2. **Offline AI & MediaPipe Check (Airplane Mode on Android Device)**
   - Open **System → Settings → Offline AI**, download/load a `.task` MediaPipe Gemma/Qwen model, and turn on **Offline Mode** + **Airplane Mode**.
   - Send a prompt in **BUDDY Chat**, confirm streaming tokens arrive from the on-device runtime, and tap **Stop** mid-generation to verify immediate cancellation and clean UI recovery.
   - Open **BUDDY Vision HUD** and test **OCR**, **Document**, and **QR/Barcode** on sample images (including >5MP camera photos) to confirm ML Kit downsampling completes without `OutOfMemoryError`.
3. **Voice Profile Switching & TTS Check**
   - Switch between Female (`Kore` / English-India), Male (`Fenrir` / English-India), and Hindi (`Swara` / Hindi) profiles in **Voice Settings**. Verify `selectedVoiceURI` clears across gender/language switches and pitch/rate apply accurately.
4. **Veronica Biometric / PIN & Intent Guard**
   - Launch a **HIGH**-risk intent (`Android Settings` / `Wi-Fi Settings`) from **App Link Hub**: verify countdown, Emergency Abort, Android BiometricPrompt, and server-verified PIN behavior.
5. **Live API & Standard Optics Check (Online Mode)**
   - Start **Live Voice** in **BUDDY Chat** (`POST /api/live/ticket` → `WSS /api/live`) and verify bidirectional audio interruption and clean disconnect.
   - Switch to **Offline Mode** while network is on: verify Live Voice and cloud camera scan refuse any external network calls cleanly.
