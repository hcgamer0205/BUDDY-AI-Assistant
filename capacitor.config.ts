interface CapacitorConfig {
  appId: string;
  appName: string;
  webDir: string;
  server?: Record<string, unknown>;
  android?: Record<string, unknown>;
  plugins?: Record<string, Record<string, unknown>>;
}

const config: CapacitorConfig = {
  appId: 'com.surya.assistant',
  appName: 'BUDDY AI',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: false,
  },
  android: {
    buildOptions: {
      keystorePath: undefined,
      releaseType: 'APK',
    },
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    CapacitorCookies: {
      enabled: false,
    },
    // Keep standard Chromium WebView fetch active so ReadableStream SSE and CORS preflight diagnostics work properly.
    CapacitorHttp: {
      enabled: false,
    },
  },
};

export default config;
