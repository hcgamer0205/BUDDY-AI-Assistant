package com.surya.assistant;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.BridgeActivity;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.Executor;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * SURYA Mobile Assistant Native Android Bridge Activity (SDK 36, Java 21)
 * High-performance multilingual voice bridge, Foreground Hands-Free service bridge,
 * device telemetry, BiometricPrompt authentication, notifications, and deep actions.
 */
public class MainActivity extends BridgeActivity {

    private static final String ALERTS_CHANNEL_ID = "surya_alerts_channel";
    private static final String GEMINI_KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String GEMINI_KEYSTORE_ALIAS = "buddy_gemini_api_key_aes";
    private static final String SECURE_PREFS_NAME = "buddy_secure_keystore_prefs";
    private static final String PREF_ENCRYPTED_GEMINI_KEY = "gemini_api_key_enc";
    private TextToSpeech tts;
    private boolean ttsInitialized = false;
    private SpeechRecognizer speechRecognizer;
    private Handler mainHandler;
    private BroadcastReceiver handsFreeStopReceiver;
    private SuryaOfflineModelService offlineModelService;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        mainHandler = new Handler(Looper.getMainLooper());
        offlineModelService = new SuryaOfflineModelService(this, this::sendJsEvent);
        createAlertsNotificationChannel();

        // Initialize Android TextToSpeech with completion callbacks
        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                ttsInitialized = true;
                tts.setLanguage(Locale.getDefault());
                tts.setPitch(1.0f);
                tts.setSpeechRate(1.06f);
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override
                    public void onStart(String utteranceId) {
                        sendJsEvent("onNativeTtsStart", "{\"utteranceId\":" + JSONObject.quote(utteranceId) + "}");
                    }

                    @Override
                    public void onDone(String utteranceId) {
                        sendJsEvent("onNativeTtsDone", "{\"utteranceId\":" + JSONObject.quote(utteranceId) + "}");
                    }

                    @Override
                    public void onError(String utteranceId) {
                        sendJsEvent("onNativeTtsDone", "{\"utteranceId\":" + JSONObject.quote(utteranceId) + ",\"error\":true}");
                    }
                });
            }
        });

        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.addJavascriptInterface(new AndroidSuryaNativeBridge(), "AndroidSuryaBridge");
        }

        handsFreeStopReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (speechRecognizer != null) {
                    try {
                        speechRecognizer.cancel();
                    } catch (Exception ignored) {}
                }
                sendJsEvent("onHandsFreeServiceState", "{\"running\":false,\"stoppedByUserNotification\":true}");
            }
        };

        IntentFilter filter = new IntentFilter(SuryaHandsFreeService.BROADCAST_HANDSFREE_STOPPED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(handsFreeStopReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(handsFreeStopReceiver, filter);
        }

        handleDeepLinkIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleDeepLinkIntent(intent);
    }

    private void handleDeepLinkIntent(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        Uri data = intent.getData();
        String action = data.getQueryParameter("action");
        if (action != null && !action.isEmpty()) {
            final String safeAction = JSONObject.quote(action);
            mainHandler.postDelayed(() -> sendJsEvent("onSuryaDeepAction", "{\"action\":" + safeAction + "}"), 600);
        }
    }

    @Override
    public void onDestroy() {
        if (handsFreeStopReceiver != null) {
            try {
                unregisterReceiver(handsFreeStopReceiver);
            } catch (Exception ignored) {}
        }
        if (offlineModelService != null) {
            offlineModelService.destroy();
        }
        if (tts != null) {
            tts.stop();
            tts.shutdown();
        }
        if (speechRecognizer != null) {
            speechRecognizer.destroy();
        }
        super.onDestroy();
    }

    private void createAlertsNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                ALERTS_CHANNEL_ID,
                "BUDDY Reminders & Alerts",
                NotificationManager.IMPORTANCE_DEFAULT
            );
            channel.setDescription("Proactive reminders, automation updates, and device status notifications.");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    /**
     * Native JavascriptInterface exposed to SURYA frontend as window.AndroidSuryaBridge
     */
    public class AndroidSuryaNativeBridge {

        @JavascriptInterface
        public boolean isNativeAndroid() {
            return true;
        }

        @JavascriptInterface
        public int getAndroidSdkVersion() {
            return Build.VERSION.SDK_INT;
        }

        @JavascriptInterface
        public boolean isHandsFreeServiceRunning() {
            return SuryaHandsFreeService.isRunning;
        }

        @JavascriptInterface
        public boolean startHandsFreeForegroundService() {
            if (ContextCompat.checkSelfPermission(MainActivity.this, android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                requestRuntimePermissions();
                return false;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(MainActivity.this, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                    MainActivity.this,
                    new String[]{android.Manifest.permission.POST_NOTIFICATIONS},
                    103
                );
            }
            Intent serviceIntent = new Intent(MainActivity.this, SuryaHandsFreeService.class);
            ContextCompat.startForegroundService(MainActivity.this, serviceIntent);
            sendJsEvent("onHandsFreeServiceState", "{\"running\":true}");
            return true;
        }

        @JavascriptInterface
        public boolean stopHandsFreeForegroundService() {
            Intent serviceIntent = new Intent(MainActivity.this, SuryaHandsFreeService.class);
            stopService(serviceIntent);
            SuryaHandsFreeService.isRunning = false;
            sendJsEvent("onHandsFreeServiceState", "{\"running\":false}");
            return true;
        }

        @JavascriptInterface
        public void requestRuntimePermissions() {
            mainHandler.post(() -> {
                List<String> needed = new ArrayList<>();
                if (ContextCompat.checkSelfPermission(MainActivity.this, android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    needed.add(android.Manifest.permission.RECORD_AUDIO);
                }
                if (ContextCompat.checkSelfPermission(MainActivity.this, android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                    needed.add(android.Manifest.permission.CAMERA);
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                    ContextCompat.checkSelfPermission(MainActivity.this, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    needed.add(android.Manifest.permission.POST_NOTIFICATIONS);
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                    ContextCompat.checkSelfPermission(MainActivity.this, android.Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                    needed.add(android.Manifest.permission.BLUETOOTH_CONNECT);
                }
                if (!needed.isEmpty()) {
                    ActivityCompat.requestPermissions(MainActivity.this, needed.toArray(new String[0]), 102);
                }
            });
        }

        @JavascriptInterface
        public String getDeviceTelemetry() {
            try {
                JSONObject json = new JSONObject();

                // Battery
                BatteryManager bm = (BatteryManager) getSystemService(Context.BATTERY_SERVICE);
                int batteryPct = bm != null ? bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) : -1;
                boolean charging = bm != null && bm.isCharging();
                json.put("batteryLevel", batteryPct);
                json.put("isCharging", charging);

                // Connectivity
                String networkType = "offline";
                boolean isOnline = false;
                ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) {
                    Network active = cm.getActiveNetwork();
                    NetworkCapabilities caps = active != null ? cm.getNetworkCapabilities(active) : null;
                    if (caps != null) {
                        isOnline = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
                        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                            networkType = "wifi";
                        } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
                            networkType = "cellular";
                        } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
                            networkType = "ethernet";
                        } else {
                            networkType = "connected";
                        }
                    }
                }
                json.put("online", isOnline);
                json.put("networkType", networkType);

                // Bluetooth audio route check
                boolean bluetoothAudio = false;
                AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                if (am != null) {
                    AudioDeviceInfo[] outputs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
                    for (AudioDeviceInfo dev : outputs) {
                        int type = dev.getType();
                        if (type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
                            type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                            type == AudioDeviceInfo.TYPE_BLE_HEADSET) {
                            bluetoothAudio = true;
                            break;
                        }
                    }
                }
                json.put("bluetoothAudioConnected", bluetoothAudio);
                json.put("handsFreeServiceRunning", SuryaHandsFreeService.isRunning);
                json.put("sdkVersion", Build.VERSION.SDK_INT);
                json.put("deviceModel", Build.MANUFACTURER + " " + Build.MODEL);
                return json.toString();
            } catch (Exception e) {
                return "{\"error\":\"telemetry_unavailable\"}";
            }
        }

        @JavascriptInterface
        public boolean sendLocalNotification(String title, String body) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                    ContextCompat.checkSelfPermission(MainActivity.this, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    return false;
                }
                Intent intent = new Intent(MainActivity.this, MainActivity.class);
                intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                PendingIntent pending = PendingIntent.getActivity(
                    MainActivity.this,
                    20,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                );
                NotificationCompat.Builder builder = new NotificationCompat.Builder(MainActivity.this, ALERTS_CHANNEL_ID)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle(title != null ? title : "BUDDY Notification")
                    .setContentText(body != null ? body : "")
                    .setAutoCancel(true)
                    .setContentIntent(pending)
                    .setPriority(NotificationCompat.PRIORITY_DEFAULT);

                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) {
                    nm.notify((int) (System.currentTimeMillis() % 100000), builder.build());
                    return true;
                }
                return false;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean setVoiceLanguage(String langCode) {
            if (tts == null || langCode == null) return false;
            try {
                Locale loc = Locale.forLanguageTag(langCode);
                int result = tts.setLanguage(loc);
                return result != TextToSpeech.LANG_MISSING_DATA && result != TextToSpeech.LANG_NOT_SUPPORTED;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public String getAvailableTtsVoices() {
            if (tts == null) return "[]";
            try {
                Set<Voice> voices = tts.getVoices();
                if (voices == null || voices.isEmpty()) return "[]";
                JSONArray arr = new JSONArray();
                for (Voice v : voices) {
                    JSONObject obj = new JSONObject();
                    obj.put("id", v.getName());
                    obj.put("name", v.getName());
                    Locale loc = v.getLocale();
                    if (loc != null) {
                        obj.put("locale", loc.toLanguageTag());
                        obj.put("language", loc.getLanguage());
                        obj.put("country", loc.getCountry());
                        obj.put("displayName", loc.getDisplayName());
                    } else {
                        obj.put("locale", "unknown");
                    }
                    obj.put("quality", v.getQuality());
                    obj.put("latency", v.getLatency());
                    obj.put("isNetwork", v.isNetworkConnectionRequired());

                    obj.put("gender", detectAndroidVoiceGender(v));
                    arr.put(obj);
                }
                return arr.toString();
            } catch (Exception e) {
                return "[]";
            }
        }

        @JavascriptInterface
        public String getTtsEngines() {
            if (tts == null) return "{\"engines\":[],\"defaultEngine\":\"\"}";
            try {
                JSONObject res = new JSONObject();
                JSONArray arr = new JSONArray();
                List<TextToSpeech.EngineInfo> engines = tts.getEngines();
                if (engines != null) {
                    for (TextToSpeech.EngineInfo ei : engines) {
                        JSONObject eo = new JSONObject();
                        eo.put("name", ei.name);
                        eo.put("label", ei.label);
                        arr.put(eo);
                    }
                }
                res.put("engines", arr);
                res.put("defaultEngine", tts.getDefaultEngine() != null ? tts.getDefaultEngine() : "");
                return res.toString();
            } catch (Exception e) {
                return "{\"engines\":[],\"defaultEngine\":\"\"}";
            }
        }

        @JavascriptInterface
        public boolean setVoiceById(String voiceId) {
            if (tts == null || !ttsInitialized || voiceId == null || voiceId.trim().isEmpty()) return false;
            try {
                Set<Voice> voices = tts.getVoices();
                if (voices != null) {
                    for (Voice v : voices) {
                        if (v.getName().equalsIgnoreCase(voiceId.trim())) {
                            tts.setVoice(v);
                            return true;
                        }
                    }
                }
                return false;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean setPitchAndRate(float pitch, float rate) {
            if (tts == null || !ttsInitialized) return false;
            try {
                tts.setPitch(Math.max(0.5f, Math.min(2.0f, pitch)));
                tts.setSpeechRate(Math.max(0.5f, Math.min(2.0f, rate)));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean hasMaleVoice(String langCode) {
            if (tts == null || !ttsInitialized) return false;
            try {
                Set<Voice> voices = tts.getVoices();
                if (voices == null) return false;
                String targetPrefix = (langCode != null && langCode.length() >= 2) ? langCode.substring(0, 2).toLowerCase(Locale.ROOT) : "";
                for (Voice v : voices) {
                    Locale loc = v.getLocale();
                    if (loc != null && !targetPrefix.isEmpty() && !loc.getLanguage().toLowerCase(Locale.ROOT).startsWith(targetPrefix)) {
                        continue;
                    }
                    if ("male".equals(detectAndroidVoiceGender(v))) {
                        return true;
                    }
                }
                return false;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void speakTextWithConfig(String text, String voiceId, float pitch, float rate, String langCode) {
            mainHandler.post(() -> {
                String utteranceId = "surya_tts_" + System.currentTimeMillis();
                if (tts == null || !ttsInitialized || text == null || text.trim().isEmpty()) {
                    sendJsEvent("onNativeTtsDone", "{\"utteranceId\":" + JSONObject.quote(utteranceId) + ",\"error\":true,\"reason\":\"tts_not_ready\"}");
                    return;
                }
                try {
                    if (langCode != null && !langCode.trim().isEmpty()) {
                        tts.setLanguage(Locale.forLanguageTag(langCode.trim()));
                    }
                    if (pitch > 0) {
                        tts.setPitch(Math.max(0.5f, Math.min(2.0f, pitch)));
                    }
                    if (rate > 0) {
                        tts.setSpeechRate(Math.max(0.5f, Math.min(2.0f, rate)));
                    }
                    if (voiceId != null && !voiceId.trim().isEmpty()) {
                        Set<Voice> voices = tts.getVoices();
                        if (voices != null) {
                            String trimmedId = voiceId.trim();
                            for (Voice v : voices) {
                                if (v.getName().equalsIgnoreCase(trimmedId)) {
                                    tts.setVoice(v);
                                    break;
                                }
                            }
                        }
                    }
                    int speakStatus = tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
                    if (speakStatus == TextToSpeech.ERROR) {
                        sendJsEvent("onNativeTtsDone", "{\"utteranceId\":" + JSONObject.quote(utteranceId) + ",\"error\":true,\"reason\":\"tts_speak_error\"}");
                    }
                } catch (Exception e) {
                    sendJsEvent("onNativeTtsDone", "{\"utteranceId\":" + JSONObject.quote(utteranceId) + ",\"error\":true,\"reason\":" + JSONObject.quote(e.getMessage() != null ? e.getMessage() : "tts_exception") + "}");
                }
            });
        }

        private String detectAndroidVoiceGender(Voice v) {
            Set<String> features = v.getFeatures();
            if (features != null) {
                for (String f : features) {
                    String lf = f.toLowerCase(Locale.ROOT);
                    if (lf.contains("gender=male") || lf.equals("male")) {
                        return "male";
                    } else if (lf.contains("gender=female") || lf.equals("female")) {
                        return "female";
                    }
                }
            }
            String lowerName = v.getName().toLowerCase(Locale.ROOT);
            // Check female FIRST so substring "male" inside "female" never misclassifies a female voice as male
            if (lowerName.contains("female") || lowerName.contains("#female") || lowerName.contains("-female")
                    || lowerName.contains("_female") || lowerName.contains("_f_") || lowerName.contains("female_")
                    || lowerName.matches(".*(?:^|[^a-z])f0[1-9](?:[^a-z0-9]|$).*")) {
                return "female";
            }
            if (lowerName.contains("#male") || lowerName.contains("-male") || lowerName.contains("_male")
                    || lowerName.contains("male_") || lowerName.contains("male1") || lowerName.contains("male2") || lowerName.contains("male3")
                    || lowerName.matches(".*(?:^|[^a-z])male(?:[^a-z]|$).*")
                    || lowerName.contains("sfg#male") || lowerName.contains("rjs#male") || lowerName.contains("iob#male")
                    || lowerName.contains("cxx#male") || lowerName.contains("cfc#male") || lowerName.contains("hie#male") || lowerName.contains("hid#male")
                    || lowerName.contains("m01") || lowerName.contains("m02") || lowerName.contains("m03")
                    || lowerName.contains("david") || lowerName.contains("george") || lowerName.contains("mark") || lowerName.contains("daniel")
                    || lowerName.contains("ravi") || lowerName.contains("pradeep") || lowerName.contains("mohan") || lowerName.contains("amit")) {
                return "male";
            }
            return "unverified";
        }

        @JavascriptInterface
        public boolean openTtsSettings() {
            try {
                Intent intent = new Intent();
                intent.setAction("com.android.settings.TTS_SETTINGS");
                intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
                return true;
            } catch (Exception e) {
                try {
                    Intent installIntent = new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA);
                    installIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(installIntent);
                    return true;
                } catch (Exception e2) {
                    return false;
                }
            }
        }

        @JavascriptInterface
        public void requestBiometricAuth(final String challengeId, final String actionId, final String title, final String subtitle) {
            mainHandler.post(() -> {
                Executor executor = ContextCompat.getMainExecutor(MainActivity.this);
                BiometricPrompt biometricPrompt = new BiometricPrompt(MainActivity.this, executor, new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                        super.onAuthenticationError(errorCode, errString);
                        notifyWebAuthResult(challengeId, false, "ERROR_" + errorCode + ": " + errString);
                    }

                    @Override
                    public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                        super.onAuthenticationSucceeded(result);
                        notifyWebAuthResult(challengeId, true, "AUTHENTICATED_BIOMETRIC_OR_DEVICE_CREDENTIAL");
                    }

                    @Override
                    public void onAuthenticationFailed() {
                        super.onAuthenticationFailed();
                        notifyWebAuthResult(challengeId, false, "BIOMETRIC_FAILED_RETRY");
                    }
                });

                BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
                        .setTitle(title != null ? title : "BUDDY Security Authorization")
                        .setSubtitle(subtitle != null ? subtitle : "Verify your identity with Biometrics or Device Screen Lock")
                        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                        .build();

                biometricPrompt.authenticate(promptInfo);
            });
        }

        @JavascriptInterface
        public String checkBiometricCapability() {
            BiometricManager biometricManager = BiometricManager.from(MainActivity.this);
            int canAuthenticate = biometricManager.canAuthenticate(
                BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL
            );

            switch (canAuthenticate) {
                case BiometricManager.BIOMETRIC_SUCCESS:
                    return "AVAILABLE";
                case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                    return "NO_HARDWARE";
                case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                    return "HARDWARE_UNAVAILABLE";
                case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                    return "NONE_ENROLLED";
                default:
                    return "UNKNOWN_STATUS";
            }
        }

        @JavascriptInterface
        public void startListening(String languageCode) {
            startListening(languageCode, false);
        }

        @JavascriptInterface
        public void startListening(String languageCode, boolean preferOffline) {
            mainHandler.post(() -> {
                if (ContextCompat.checkSelfPermission(MainActivity.this, android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    ActivityCompat.requestPermissions(MainActivity.this, new String[]{android.Manifest.permission.RECORD_AUDIO}, 101);
                    return;
                }

                if (speechRecognizer != null) {
                    speechRecognizer.destroy();
                }

                speechRecognizer = SpeechRecognizer.createSpeechRecognizer(MainActivity.this);
                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                if (languageCode != null && !languageCode.isEmpty()) {
                    intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, languageCode);
                } else {
                    intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag());
                }
                intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, preferOffline);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1600L);
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L);

                speechRecognizer.setRecognitionListener(new RecognitionListener() {
                    @Override
                    public void onReadyForSpeech(Bundle params) {
                        sendJsEvent("onNativeSpeechReady", "{}");
                    }
                    @Override
                    public void onBeginningOfSpeech() {
                        sendJsEvent("onNativeSpeechStart", "{}");
                    }
                    @Override
                    public void onRmsChanged(float rmsdB) {}
                    @Override
                    public void onBufferReceived(byte[] buffer) {}
                    @Override
                    public void onEndOfSpeech() {
                        sendJsEvent("onNativeSpeechEnd", "{}");
                    }
                    @Override
                    public void onError(int error) {
                        sendJsEvent("onNativeSpeechError", "{\"code\":" + error + "}");
                    }
                    @Override
                    public void onResults(Bundle results) {
                        ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        if (matches != null && !matches.isEmpty()) {
                            String quoted = JSONObject.quote(matches.get(0));
                            sendJsEvent("onNativeSpeechResult", "{\"text\":" + quoted + ",\"isFinal\":true}");
                        }
                    }
                    @Override
                    public void onPartialResults(Bundle partialResults) {
                        ArrayList<String> matches = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        if (matches != null && !matches.isEmpty()) {
                            String quoted = JSONObject.quote(matches.get(0));
                            sendJsEvent("onNativeSpeechResult", "{\"text\":" + quoted + ",\"isFinal\":false}");
                        }
                    }
                    @Override
                    public void onEvent(int eventType, Bundle params) {}
                });

                speechRecognizer.startListening(intent);
            });
        }

        @JavascriptInterface
        public void stopListening() {
            mainHandler.post(() -> {
                if (speechRecognizer != null) {
                    speechRecognizer.stopListening();
                }
            });
        }

        @JavascriptInterface
        public void speakText(String text) {
            mainHandler.post(() -> {
                if (tts != null && text != null) {
                    tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "surya_tts_" + System.currentTimeMillis());
                }
            });
        }

        @JavascriptInterface
        public void stopSpeaking() {
            mainHandler.post(() -> {
                if (tts != null) {
                    tts.stop();
                    sendJsEvent("onNativeTtsDone", "{\"stopped\":true}");
                }
            });
        }

        @JavascriptInterface
        public boolean launchIntent(String action, String dataUri, String packageName) {
            try {
                Intent intent = new Intent(action);
                if (dataUri != null && !dataUri.isEmpty()) {
                    intent.setData(Uri.parse(dataUri));
                }
                if (packageName != null && !packageName.isEmpty()) {
                    intent.setPackage(packageName);
                }
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
                return true;
            } catch (Exception e) {
                e.printStackTrace();
                return false;
            }
        }

        @JavascriptInterface
        public boolean installApk(String filePath) {
            try {
                File file = new File(filePath);
                if (!file.exists()) return false;

                Uri apkUri = FileProvider.getUriForFile(
                    MainActivity.this,
                    "com.surya.assistant.fileprovider",
                    file
                );

                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
                return true;
            } catch (Exception e) {
                e.printStackTrace();
                return false;
            }
        }

        // ---------------- OFFLINE AI MODEL STORE, HARDWARE INTELLIGENCE & VISION ----------------

        @JavascriptInterface
        public String getHardwareCapabilities() {
            return offlineModelService != null
                ? offlineModelService.getHardwareCapabilitiesJson(ttsInitialized)
                : "{\"error\":\"service_unavailable\"}";
        }

        @JavascriptInterface
        public String listDownloadedModels() {
            return offlineModelService != null ? offlineModelService.listDownloadedModelsJson() : "[]";
        }

        @JavascriptInterface
        public String startModelDownload(String modelId, String url, String fileName, String expectedSha256, long expectedBytes) {
            return offlineModelService != null
                ? offlineModelService.startModelDownload(modelId, url, fileName, expectedSha256, expectedBytes)
                : "{\"started\":false,\"error\":\"service_unavailable\"}";
        }

        @JavascriptInterface
        public void pauseModelDownload(String modelId) {
            if (offlineModelService != null) offlineModelService.pauseModelDownload(modelId);
        }

        @JavascriptInterface
        public void cancelModelDownload(String modelId) {
            if (offlineModelService != null) offlineModelService.cancelModelDownload(modelId);
        }

        @JavascriptInterface
        public String verifyModelFile(String modelId, String expectedSha256) {
            return offlineModelService != null
                ? offlineModelService.verifyModelFileJson(modelId, expectedSha256)
                : "{\"valid\":false,\"reason\":\"service_unavailable\"}";
        }

        @JavascriptInterface
        public String deleteDownloadedModel(String modelId) {
            return offlineModelService != null
                ? offlineModelService.deleteModelJson(modelId)
                : "{\"deleted\":false,\"error\":\"service_unavailable\"}";
        }

        @JavascriptInterface
        public String loadLocalModel(String modelId, int minDeviceRamMb, int maxTokens, boolean preferGpu) {
            return offlineModelService != null
                ? offlineModelService.loadModelJson(modelId, minDeviceRamMb, maxTokens, preferGpu)
                : "{\"loaded\":false,\"error\":\"service_unavailable\"}";
        }

        @JavascriptInterface
        public void unloadLocalModel() {
            if (offlineModelService != null) offlineModelService.unloadModel();
        }

        @JavascriptInterface
        public String getLocalModelRuntimeState() {
            return offlineModelService != null ? offlineModelService.getRuntimeStateJson() : "{\"loaded\":false}";
        }

        @JavascriptInterface
        public boolean generateLocalLlmResponse(String requestId, String prompt) {
            return offlineModelService != null && offlineModelService.generateResponseAsync(requestId, prompt);
        }

        @JavascriptInterface
        public void cancelLocalLlmGeneration() {
            if (offlineModelService != null) offlineModelService.cancelGeneration();
        }

        @JavascriptInterface
        public String analyzeImageOffline(String base64DataUrl, String mode) {
            return offlineModelService != null
                ? offlineModelService.analyzeImageOfflineJson(base64DataUrl, mode)
                : "{\"error\":\"service_unavailable\"}";
        }

        @JavascriptInterface
        public String checkOfflineVoiceReadiness(String langCode) {
            return offlineModelService != null
                ? offlineModelService.checkOfflineVoiceReadinessJson(langCode, tts)
                : "{\"onDeviceSttSupported\":false,\"ttsReady\":false}";
        }

        @JavascriptInterface
        public boolean openOfflineVoiceDataSettings() {
            return offlineModelService != null && offlineModelService.openOfflineVoiceDataSettings();
        }

        // ---------------- ANDROID KEYSTORE ENCRYPTED GEMINI BYOK STORAGE ----------------

        @JavascriptInterface
        public boolean saveGeminiApiKey(String apiKey) {
            try {
                SharedPreferences prefs = getSharedPreferences(SECURE_PREFS_NAME, Context.MODE_PRIVATE);
                if (apiKey == null || apiKey.trim().isEmpty()) {
                    prefs.edit().remove(PREF_ENCRYPTED_GEMINI_KEY).apply();
                    return true;
                }
                String trimmed = apiKey.trim();
                SecretKey secretKey = getOrCreateGeminiKeystoreSecretKey();
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, secretKey);
                byte[] iv = cipher.getIV();
                byte[] ciphertext = cipher.doFinal(trimmed.getBytes(StandardCharsets.UTF_8));
                String encoded = Base64.encodeToString(iv, Base64.NO_WRAP) + ":" +
                    Base64.encodeToString(ciphertext, Base64.NO_WRAP);
                prefs.edit().putString(PREF_ENCRYPTED_GEMINI_KEY, encoded).apply();
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean hasGeminiApiKey() {
            try {
                SharedPreferences prefs = getSharedPreferences(SECURE_PREFS_NAME, Context.MODE_PRIVATE);
                String encoded = prefs.getString(PREF_ENCRYPTED_GEMINI_KEY, null);
                return encoded != null && encoded.contains(":");
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public String getGeminiApiKey() {
            try {
                return decryptGeminiApiKey();
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public String getMaskedGeminiApiKey() {
            try {
                String plain = decryptGeminiApiKey();
                if (plain.isEmpty()) return "";
                if (plain.length() <= 8) return "••••";
                return plain.substring(0, 4) + "••••" + plain.substring(plain.length() - 4);
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public boolean removeGeminiApiKey() {
            try {
                SharedPreferences prefs = getSharedPreferences(SECURE_PREFS_NAME, Context.MODE_PRIVATE);
                prefs.edit().remove(PREF_ENCRYPTED_GEMINI_KEY).apply();
                return true;
            } catch (Exception e) {
                return false;
            }
        }
    }

    private SecretKey getOrCreateGeminiKeystoreSecretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(GEMINI_KEYSTORE_PROVIDER);
        keyStore.load(null);
        KeyStore.Entry entry = keyStore.getEntry(GEMINI_KEYSTORE_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator keyGenerator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            GEMINI_KEYSTORE_PROVIDER
        );
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
            GEMINI_KEYSTORE_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build();
        keyGenerator.init(spec);
        return keyGenerator.generateKey();
    }

    private String decryptGeminiApiKey() throws Exception {
        SharedPreferences prefs = getSharedPreferences(SECURE_PREFS_NAME, Context.MODE_PRIVATE);
        String encoded = prefs.getString(PREF_ENCRYPTED_GEMINI_KEY, null);
        if (encoded == null || !encoded.contains(":")) {
            return "";
        }
        String[] parts = encoded.split(":", 2);
        if (parts.length != 2) {
            return "";
        }
        byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
        byte[] ciphertext = Base64.decode(parts[1], Base64.NO_WRAP);
        SecretKey secretKey = getOrCreateGeminiKeystoreSecretKey();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, secretKey, new GCMParameterSpec(128, iv));
        byte[] decrypted = cipher.doFinal(ciphertext);
        return new String(decrypted, StandardCharsets.UTF_8);
    }

    private void notifyWebAuthResult(final String challengeId, final boolean success, final String message) {
        String script = String.format(
            "window.dispatchEvent(new CustomEvent('androidBiometricResult', { detail: { challengeId: %s, success: %b, message: %s } }));",
            JSONObject.quote(challengeId != null ? challengeId : ""),
            success,
            JSONObject.quote(message != null ? message : "")
        );
        mainHandler.post(() -> {
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                webView.evaluateJavascript(script, null);
            }
        });
    }

    private void sendJsEvent(String eventName, String jsonPayload) {
        String script = String.format(
            "window.dispatchEvent(new CustomEvent('%s', { detail: %s }));",
            eventName, jsonPayload
        );
        mainHandler.post(() -> {
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                webView.evaluateJavascript(script, null);
            }
        });
    }
}
