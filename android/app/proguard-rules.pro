# BUDDY Android Release ProGuard / R8 Keep Rules

# Preserve native app classes, JavascriptInterface bridges, services, and receivers
-keep class com.surya.assistant.** { *; }
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Preserve Capacitor Core plugins and bridge reflection
-keep class com.getcapacitor.** { *; }
-keep class * extends com.getcapacitor.Plugin { *; }

# Preserve MediaPipe Tasks GenAI LLM inference JNI & callbacks
-keep class com.google.mediapipe.** { *; }
-dontwarn com.google.mediapipe.**

# Preserve Google ML Kit Text Recognition & Barcode Scanning models
-keep class com.google.mlkit.** { *; }
-dontwarn com.google.mlkit.**

# Preserve AndroidX Biometric classes
-keep class androidx.biometric.** { *; }
