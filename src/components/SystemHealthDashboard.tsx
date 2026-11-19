import React, { useState, useEffect } from 'react';
import {
  Server,
  Mic,
  Sliders,
  ShieldCheck,
  Lock,
  Smartphone,
  Database,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Save,
  Wifi,
  RotateCcw,
  KeyRound,
  AlertTriangle,
  CheckCircle,
  AlertCircle,
  Download,
  FileCheck,
  Radio,
  Info,
  Cpu,
  Sparkles,
} from 'lucide-react';
import { SystemHealthData, UpdateInfo, DeviceTelemetry } from '../types/surya';
import { apiService, ConnectionStatusSnapshot, ConnectionState } from '../services/apiService';
import {
  modelPreferenceService,
  ServerGeminiModel,
} from '../services/modelPreferenceService';
import { deviceBridgeService } from '../services/deviceBridgeService';
import { wakeWordService, WakeWordState } from '../services/wakeWordService';
import { voiceProfileManager } from '../services/voiceProfileManager';
import { uiThemeEngine } from '../services/uiThemeEngine';
import { personalMemoryService } from '../services/personalMemoryService';
import { intelligenceRouter } from '../services/intelligenceRouter';
import { modelDownloadManager } from '../services/modelDownloadManager';
import { OfflineModelStore } from './OfflineModelStore';
import { soundFx } from '../services/soundFx';

interface SecurityReportData {
  serverCredentialsIsolated: boolean;
  geminiKeyConfigured: boolean;
  authTokenEnforced?: boolean;
  perUserMemoryIsolation?: boolean;
  corsPolicy: string;
  rateLimitingActive: boolean;
  veronicaChallengeCount: number;
  auditLogCount: number;
  sensitiveDataRedactionActive: boolean;
  noCovertRecordingGuarantee: boolean;
  sandboxedStudioIsolation: boolean;
  timestamp: string;
}

export type SettingsSectionId =
  | 'gemini'
  | 'offline'
  | 'backend'
  | 'voice'
  | 'appearance'
  | 'permissions'
  | 'security'
  | 'device'
  | 'memory';

interface SystemHealthDashboardProps {
  initialOpenSection?: SettingsSectionId | null;
  onSelectModel?: (modelId: string) => void;
  onOpenVoiceModal?: () => void;
  onOpenThemeModal?: () => void;
  onOpenMemory?: () => void;
  onOpenAudit?: () => void;
}

const STATE_LABELS: Record<ConnectionState, { label: string; dot: string; text: string }> = {
  CONNECTED: { label: 'Connected', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  CONNECTING: { label: 'Connecting', dot: 'bg-amber-400', text: 'text-amber-300' },
  DISCONNECTED: { label: 'Standby', dot: 'bg-slate-400', text: 'text-slate-300' },
  TIMEOUT: { label: 'Timeout', dot: 'bg-amber-400', text: 'text-amber-300' },
  UNAVAILABLE: { label: 'Server Unavailable', dot: 'bg-rose-400', text: 'text-rose-300' },
  AUTHENTICATION_REQUIRED: { label: 'Auth Failure', dot: 'bg-amber-400', text: 'text-amber-200' },
  SERVER_ERROR: { label: 'Server Error', dot: 'bg-rose-400', text: 'text-rose-200' },
  RATE_LIMITED: { label: 'Rate Limited', dot: 'bg-orange-400', text: 'text-orange-200' },
};

export const SystemHealthDashboard: React.FC<SystemHealthDashboardProps> = ({
  initialOpenSection = null,
  onSelectModel,
  onOpenVoiceModal,
  onOpenThemeModal,
  onOpenMemory,
  onOpenAudit,
}) => {
  const [health, setHealth] = useState<SystemHealthData | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [securityReport, setSecurityReport] = useState<SecurityReportData | null>(null);
  const [telemetry, setTelemetry] = useState<DeviceTelemetry>(deviceBridgeService.getTelemetry());
  const [connStatus, setConnStatus] = useState<ConnectionStatusSnapshot>(
    apiService.getConnectionStatus()
  );
  const [selectedModel, setSelectedModel] = useState<string>(() =>
    modelPreferenceService.getSelectedModel()
  );
  const [availableModels, setAvailableModels] = useState<ServerGeminiModel[]>(() =>
    modelPreferenceService.getModels()
  );

  const [wakeState, setWakeState] = useState<WakeWordState>(wakeWordService.getState());
  const [theme, setTheme] = useState(uiThemeEngine.getCurrentTheme());
  const [memoryEnabled, setMemoryEnabled] = useState<boolean>(personalMemoryService.isEnabled());
  const [routerStatus, setRouterStatus] = useState(() => intelligenceRouter.getEffectiveStatus());
  const [downloadedCount, setDownloadedCount] = useState(
    () => modelDownloadManager.getDownloadedModels().length
  );

  const [openSection, setOpenSection] = useState<SettingsSectionId | null>(
    () => initialOpenSection || null
  );

  useEffect(() => {
    if (initialOpenSection) {
      setOpenSection(initialOpenSection);
    }
  }, [initialOpenSection]);

  // Server-Side Gemini Setup State
  const [isVerifyingServer, setIsVerifyingServer] = useState(false);
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [geminiNotice, setGeminiNotice] = useState<{
    text: string;
    tone: 'ok' | 'warn' | 'err' | 'info';
  } | null>(null);

  const [installStatus, setInstallStatus] = useState<{
    text: string;
    type: 'info' | 'ok' | 'err';
  } | null>(null);
  const [permissionNote, setPermissionNote] = useState<string | null>(null);

  // Optional Server Gateway State
  const [backendUrl, setBackendUrl] = useState<string>(() => apiService.getApiBaseUrl());
  const [apiTokenInput, setApiTokenInput] = useState<string>(() => apiService.getApiToken());
  const [showToken, setShowToken] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [gatewayNotice, setGatewayNotice] = useState<{
    text: string;
    tone: 'ok' | 'warn' | 'err' | 'info';
  } | null>(null);

  useEffect(() => {
    const unsubModel = modelPreferenceService.subscribe((snap) => {
      setSelectedModel(snap.selectedModel);
      setAvailableModels(snap.models);
    });
    const unsubConn = apiService.subscribeConnectionState(setConnStatus);
    const unsubTel = deviceBridgeService.subscribe(setTelemetry);
    const unsubWake = wakeWordService.subscribe(setWakeState);
    const unsubTheme = uiThemeEngine.subscribe((t) => setTheme(t));
    const unsubRouter = intelligenceRouter.subscribe(setRouterStatus);
    const unsubDl = modelDownloadManager.subscribe(() => {
      setDownloadedCount(modelDownloadManager.getDownloadedModels().length);
    });

    deviceBridgeService.refreshTelemetry();
    if (apiService.isBackendConfigured()) {
      loadAllDiagnostics();
      modelPreferenceService.refreshFromServer().catch(() => {});
    }

    return () => {
      unsubModel();
      unsubConn();
      unsubTel();
      unsubWake();
      unsubTheme();
      unsubRouter();
      unsubDl();
    };
  }, []);

  const loadAllDiagnostics = () => {
    deviceBridgeService.refreshTelemetry();
    if (apiService.isBackendConfigured()) {
      loadHealth();
      checkUpdates();
      loadSecurityReport();
    }
  };

  const toggleSection = (id: SettingsSectionId) => {
    soundFx.playClick();
    setOpenSection((prev) => (prev === id ? null : id));
  };

  // ---------------- SERVER-SIDE GEMINI HANDLERS ----------------

  const handleVerifyServerGemini = async () => {
    soundFx.playClick();
    setIsVerifyingServer(true);
    setGeminiNotice({
      text: `Verifying ${selectedModel} via server-side Gemini Interactions API...`,
      tone: 'info',
    });

    try {
      const result = await apiService.verifyGeminiConnection();
      soundFx.playAuthorize();
      setGeminiNotice({
        text: `Verified · ${result.model} (${result.resolvedUpstreamModel || 'Interactions API'}) responded in ${result.latencyMs} ms.`,
        tone: 'ok',
      });
    } catch (err: any) {
      soundFx.playAbort();
      setGeminiNotice({
        text: err?.message || 'Server Gemini connection verification failed.',
        tone: 'err',
      });
    } finally {
      setIsVerifyingServer(false);
    }
  };

  const handleModelChange = (modelId: string) => {
    soundFx.playClick();
    const updated = modelPreferenceService.setSelectedModel(modelId);
    onSelectModel?.(updated);
    setGeminiNotice(null);
  };

  const handleRefreshModels = async () => {
    soundFx.playClick();
    setIsRefreshingModels(true);
    setGeminiNotice(null);
    try {
      const list = await modelPreferenceService.refreshFromServer();
      soundFx.playAuthorize();
      setGeminiNotice({
        text: `Synced ${list.length} supported Gemini model(s) from server.`,
        tone: 'ok',
      });
    } catch (err: any) {
      soundFx.playAbort();
      setGeminiNotice({
        text: err?.message || 'Failed to refresh models from backend server.',
        tone: 'err',
      });
    } finally {
      setIsRefreshingModels(false);
    }
  };

  // ---------------- OPTIONAL SERVER GATEWAY HANDLERS ----------------

  const handleSaveUrlOnly = () => {
    soundFx.playClick();
    const validation = apiService.setApiBaseUrl(backendUrl, { requireNonEmpty: true });
    if (!validation.valid) {
      soundFx.playAbort();
      setGatewayNotice({ text: validation.error || 'Invalid server URL.', tone: 'err' });
      return false;
    }

    apiService.setApiToken(apiTokenInput);
    setBackendUrl(apiService.getApiBaseUrl());

    if (validation.warning) {
      setGatewayNotice({ text: `Saved with notice: ${validation.warning}`, tone: 'warn' });
    } else {
      setGatewayNotice({
        text: 'Optional server URL saved. Run Test Connection to verify reachability.',
        tone: 'info',
      });
    }
    return true;
  };

  const handleTestConnection = async () => {
    soundFx.playClick();
    setIsTestingConnection(true);
    setGatewayNotice({ text: 'Testing optional /api/health endpoint...', tone: 'info' });
    try {
      const data = await apiService.checkBackendConnection();
      setHealth(data);
      await Promise.all([loadSecurityReport(), checkUpdates()]);
      soundFx.playAuthorize();
      setGatewayNotice({
        text: `Optional server connected · Active model: ${data.activeModel}`,
        tone: 'ok',
      });
    } catch (err: any) {
      soundFx.playAbort();
      setGatewayNotice({
        text: err?.message || 'Optional server connection failed.',
        tone: 'err',
      });
    } finally {
      setIsTestingConnection(false);
    }
  };

  const handleSaveAndTest = async () => {
    const ok = handleSaveUrlOnly();
    if (!ok) return;
    await handleTestConnection();
  };

  const handleResetGateway = () => {
    soundFx.playClick();
    apiService.setApiBaseUrl('');
    apiService.setApiToken('');
    setBackendUrl(apiService.getApiBaseUrl());
    setApiTokenInput(apiService.getApiToken());
    setHealth(null);
    setSecurityReport(null);
    setGatewayNotice({
      text: 'Custom server gateway cleared. Web runtime uses built-in /api endpoints automatically.',
      tone: 'info',
    });
  };

  const loadHealth = async () => {
    try {
      const data = await apiService.checkBackendConnection();
      setHealth(data);
    } catch {}
  };

  const checkUpdates = async () => {
    try {
      const info = await apiService.checkForUpdates();
      setUpdateInfo(info);
    } catch {}
  };

  const loadSecurityReport = async () => {
    try {
      const rep = await apiService.getSecurityReport();
      setSecurityReport(rep);
    } catch {}
  };

  const handleVerifyUpdateChecksum = async () => {
    if (!updateInfo) return;
    soundFx.playClick();
    setInstallStatus({ text: 'Verifying SHA-256 package digest...', type: 'info' });
    try {
      const result = await apiService.verifyApkChecksum(
        updateInfo.sha256Checksum,
        updateInfo.latestVersion
      );
      if (result.valid) {
        soundFx.playAuthorize();
        setInstallStatus({
          text: `${result.status} Release v${updateInfo.latestVersion} verified.`,
          type: 'ok',
        });
      } else {
        soundFx.playAbort();
        setInstallStatus({
          text: `Checksum validation failed: ${result.status}.`,
          type: 'err',
        });
      }
    } catch (err: any) {
      soundFx.playAbort();
      setInstallStatus({
        text: `Verification request failed: ${err?.message || 'Unknown error'}`,
        type: 'err',
      });
    }
  };

  const handleRequestPermissions = () => {
    soundFx.playClick();
    const sent = deviceBridgeService.requestNativePermissions();
    if (sent) {
      soundFx.playAuthorize();
      setPermissionNote(
        'Requested Android permissions for Microphone, Camera, and Notifications.'
      );
    } else {
      setPermissionNote(
        'Web mode: browser requests Microphone and Camera permissions when you start Voice or Vision.'
      );
    }
  };

  // Top Header Honest Status (Server-Side Gemini Interactions API + Offline AI)
  const topStatusMeta = (() => {
    if (routerStatus.mode === 'offline') {
      return routerStatus.localReady
        ? { label: 'Offline AI Active', dot: 'bg-emerald-400', text: 'text-emerald-300' }
        : { label: 'Offline Mode', dot: 'bg-amber-400', text: 'text-amber-300' };
    }
    if (connStatus.state === 'CONNECTED' && connStatus.geminiConfigured === false) {
      return { label: 'Server Key Missing', dot: 'bg-amber-400', text: 'text-amber-300' };
    }
    if (connStatus.state === 'CONNECTED') {
      return { label: 'Gemini Connected', dot: 'bg-emerald-400', text: 'text-emerald-300' };
    }
    return { label: 'Server Gemini Ready', dot: 'bg-teal-400', text: 'text-teal-300' };
  })();

  const connMeta = STATE_LABELS[connStatus.state];
  const activeVoiceProfile = voiceProfileManager.getActiveProfile();

  const SectionShell: React.FC<{
    id: SettingsSectionId;
    icon: React.ReactNode;
    title: string;
    summary: string;
    children: React.ReactNode;
  }> = ({ id, icon, title, summary, children }) => {
    const isOpen = openSection === id;
    return (
      <div className="rounded-2xl bg-[#0b1522]/85 backdrop-blur-xl border border-emerald-500/20 overflow-hidden shadow-lg">
        <button
          type="button"
          onClick={() => toggleSection(id)}
          aria-expanded={isOpen}
          className="w-full min-h-[60px] px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-emerald-500/5 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-[#070d14] border border-emerald-500/25 flex items-center justify-center shrink-0">
              {icon}
            </div>
            <div className="min-w-0">
              <span className="text-sm font-medium text-slate-100 block">{title}</span>
              <span className="text-xs text-slate-400 block truncate">{summary}</span>
            </div>
          </div>
          {isOpen ? (
            <ChevronDown className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
          )}
        </button>

        {isOpen && (
          <div className="px-4 pb-4 pt-2 border-t border-emerald-500/15 space-y-3">
            {children}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="w-full max-w-2xl mx-auto px-4 py-4 pb-24 space-y-4">
      {/* Settings Header & Honest Status */}
      <div className="flex items-center justify-between gap-3 pb-2 border-b border-emerald-500/20">
        <div>
          <h2 className="text-lg font-semibold text-white tracking-wide">System Settings</h2>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={`w-2 h-2 rounded-full ${topStatusMeta.dot}`} />
            <span className={`text-xs font-medium ${topStatusMeta.text}`}>{topStatusMeta.label}</span>
            <span className="text-xs text-slate-500">·</span>
            <span className="text-xs text-slate-400 truncate">
              {routerStatus.mode === 'offline' && routerStatus.localReady
                ? routerStatus.activeLocalModelName
                : selectedModel}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            soundFx.playClick();
            loadAllDiagnostics();
            modelPreferenceService.refreshFromServer().catch(() => {});
          }}
          aria-label="Refresh settings and telemetry"
          className="min-h-[38px] min-w-[38px] p-2 rounded-xl bg-[#0b1522]/85 border border-emerald-500/25 hover:border-emerald-400/50 text-emerald-300 flex items-center justify-center cursor-pointer"
        >
          <RefreshCw className={`w-4 h-4 ${isVerifyingServer || isTestingConnection ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* 1. Gemini AI & Model Configuration (Server-Side Interactions API) */}
      <SectionShell
        id="gemini"
        icon={<Sparkles className="w-4 h-4 text-emerald-400" />}
        title="Gemini AI & Model Configuration (Server-Side)"
        summary={`${selectedModel} · ${
          connStatus.geminiConfigured === false
            ? 'Server secret pending'
            : 'Interactions API & Live API Active'
        }`}
      >
        <div className="p-3.5 rounded-xl bg-[#070d14]/90 border border-emerald-500/25 space-y-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 font-semibold text-emerald-300">
              <Sparkles className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>Server-Side Gemini Interactions API</span>
            </div>
            <span className={`text-[11px] font-medium ${topStatusMeta.text}`}>
              {topStatusMeta.label}
            </span>
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed">
            All Gemini text, streaming, vision, studio, multi-agent, and Live Voice calls execute securely on the backend server using the Interactions API &amp; Live API. No user API key setup is required.
          </p>
        </div>

        {/* Select Gemini Model */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="buddy-gemini-model-select" className="text-xs text-slate-200 font-medium flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-emerald-400" />
              <span>Select Gemini Model</span>
            </label>
            <button
              type="button"
              onClick={handleRefreshModels}
              disabled={isRefreshingModels}
              className="text-[11px] text-teal-300 hover:underline disabled:opacity-40 inline-flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${isRefreshingModels ? 'animate-spin' : ''}`} />
              <span>Refresh Models</span>
            </button>
          </div>
          <select
            id="buddy-gemini-model-select"
            value={selectedModel}
            onChange={(e) => handleModelChange(e.target.value)}
            className="w-full min-h-[42px] px-3 py-2 bg-[#070d14] border border-emerald-500/25 focus:border-emerald-400 rounded-xl text-xs text-slate-100 focus:outline-none"
          >
            {availableModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.id}) — {m.speed}
              </option>
            ))}
          </select>
        </div>

        {/* Verify Server Gemini Connection */}
        <button
          type="button"
          onClick={handleVerifyServerGemini}
          disabled={isVerifyingServer}
          className="w-full min-h-[42px] px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer shadow-sm"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isVerifyingServer ? 'animate-spin' : ''}`} />
          <span>{isVerifyingServer ? 'Verifying...' : 'Verify Gemini Connection'}</span>
        </button>

        {geminiNotice && (
          <div
            className={`text-xs p-3 rounded-xl border ${
              geminiNotice.tone === 'ok'
                ? 'bg-emerald-950/40 border-emerald-500/35 text-emerald-200'
                : geminiNotice.tone === 'warn'
                ? 'bg-amber-950/40 border-amber-500/35 text-amber-200'
                : geminiNotice.tone === 'info'
                ? 'bg-[#070d14] border-slate-700 text-slate-200'
                : 'bg-rose-950/40 border-rose-500/35 text-rose-200'
            }`}
          >
            {geminiNotice.text}
          </div>
        )}

        <div className="p-3 rounded-xl bg-[#070d14]/70 border border-slate-800/80 flex items-start gap-2 text-[11px] text-slate-400 leading-relaxed">
          <Lock className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
          <span>
            API credentials remain isolated exclusively in the server environment and are never stored in browser storage or shipped to client apps.
          </span>
        </div>
      </SectionShell>

      {/* 2. Offline AI & Local Models (Completely Independent) */}
      <SectionShell
        id="offline"
        icon={<Radio className="w-4 h-4 text-[#d4a84f]" />}
        title="Offline AI & Local Models"
        summary={
          routerStatus.activeLocalModelName
            ? `Mode: ${routerStatus.mode} · Active: ${routerStatus.activeLocalModelName}`
            : `Mode: ${routerStatus.mode} · ${downloadedCount} downloaded model(s)`
        }
      >
        <OfflineModelStore />
      </SectionShell>

      {/* 3. Server Gateway Configuration (Web uses /api automatically; Android APK can specify custom server) */}
      <SectionShell
        id="backend"
        icon={<Server className="w-4 h-4 text-[#60a5fa]" />}
        title="BUDDY Server Gateway"
        summary={
          connStatus.effectiveUrl
            ? `Server: ${connStatus.effectiveUrl}`
            : 'Built-in /api server active for Gemini & Studio'
        }
      >
        <div className="p-3 rounded-xl bg-[#070d14] border border-slate-800 space-y-1.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Server Status</span>
            <span className={`font-semibold inline-flex items-center gap-1.5 ${connMeta.text}`}>
              <span className={`w-2 h-2 rounded-full ${connMeta.dot}`} />
              <span>{connMeta.label}</span>
            </span>
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed">
            Web runtime automatically routes Gemini Interactions API &amp; Live API calls through <code className="text-slate-300 font-mono">/api/*</code>. For standalone mobile APKs, specify your HTTPS server URL below.
          </p>
        </div>

        {connStatus.isPreviewUrl && (
          <div className="p-3 rounded-xl bg-amber-950/35 border border-amber-500/30 text-xs text-amber-100 space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-[#d4a84f]">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>AI Studio Preview URL Detected</span>
            </div>
            <p className="text-slate-300 text-[11px] leading-relaxed">
              AI Studio preview hosts enforce browser cookie checks and do not accept mobile APK requests. Clear this URL unless you deploy an independent HTTPS server.
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          <label className="text-xs text-slate-300 block">Optional Backend HTTPS Service Root URL</label>
          <input
            type="url"
            value={backendUrl}
            onChange={(e) => setBackendUrl(e.target.value)}
            placeholder="https://your-optional-server.example.com"
            className="w-full min-h-[42px] px-3 py-2 bg-[#070d14] border border-slate-800 rounded-xl text-xs font-mono text-slate-100 placeholder-slate-600 focus:outline-none focus:border-[#60a5fa]"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs text-slate-300 flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-slate-400" />
              <span>Optional Server Access Token</span>
            </label>
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="text-xs text-[#60a5fa] hover:underline"
            >
              {showToken ? 'Hide' : 'Show'}
            </button>
          </div>
          <input
            type={showToken ? 'text' : 'password'}
            value={apiTokenInput}
            onChange={(e) => setApiTokenInput(e.target.value)}
            placeholder="Optional BUDDY_API_TOKEN"
            className="w-full min-h-[42px] px-3 py-2 bg-[#070d14] border border-slate-800 rounded-xl text-xs font-mono text-slate-100 placeholder-slate-600 focus:outline-none focus:border-emerald-400"
          />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <button
            type="button"
            onClick={handleSaveUrlOnly}
            className="min-h-[40px] px-3 py-2 bg-[#070d14] hover:bg-slate-800 border border-slate-700 text-slate-200 rounded-xl text-xs font-medium flex items-center justify-center gap-1.5"
          >
            <Save className="w-3.5 h-3.5" />
            <span>Save</span>
          </button>

          <button
            type="button"
            onClick={handleTestConnection}
            disabled={isTestingConnection}
            className="min-h-[40px] px-3 py-2 bg-[#070d14] hover:bg-slate-800 border border-slate-700 text-[#60a5fa] rounded-xl text-xs font-medium flex items-center justify-center gap-1.5"
          >
            <Wifi className="w-3.5 h-3.5" />
            <span>Test</span>
          </button>

          <button
            type="button"
            onClick={handleSaveAndTest}
            disabled={isTestingConnection}
            className="min-h-[40px] px-3 py-2 bg-[#60a5fa] hover:bg-blue-400 text-slate-950 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isTestingConnection ? 'animate-spin' : ''}`} />
            <span>Save &amp; Test</span>
          </button>

          <button
            type="button"
            onClick={handleResetGateway}
            className="min-h-[40px] px-3 py-2 bg-[#070d14] hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-slate-200 rounded-xl text-xs font-medium flex items-center justify-center gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Clear</span>
          </button>
        </div>

        {gatewayNotice && (
          <div
            className={`text-xs p-3 rounded-xl border ${
              gatewayNotice.tone === 'ok'
                ? 'bg-emerald-950/35 border-emerald-500/30 text-emerald-200'
                : gatewayNotice.tone === 'warn'
                ? 'bg-amber-950/35 border-amber-500/30 text-amber-200'
                : gatewayNotice.tone === 'err'
                ? 'bg-rose-950/35 border-rose-500/30 text-rose-200'
                : 'bg-[#070d14] border-slate-800 text-slate-300'
            }`}
          >
            {gatewayNotice.text}
          </div>
        )}
      </SectionShell>

      {/* 2. Voice & Hands-Free */}
      <SectionShell
        id="voice"
        icon={<Mic className="w-4 h-4 text-[#d4a84f]" />}
        title="Voice & Hands-Free"
        summary={`${activeVoiceProfile.name} · ${wakeState.isActive ? 'Wake word on' : 'Wake word off'}`}
      >
        <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-[#0b0f17] border border-slate-800">
          <div>
            <span className="text-xs font-medium text-slate-100 block">
              Hands-Free Wake Word
            </span>
            <span className="text-xs text-slate-400">
              Listen for &ldquo;Hey BUDDY&rdquo; with active mic indicator
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              soundFx.playClick();
              wakeWordService.toggle();
            }}
            className={`min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 border ${
              wakeState.isActive
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                : 'bg-[#121826] border-slate-700 text-slate-300'
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            <span>{wakeState.isActive ? 'Enabled' : 'Disabled'}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="p-3 rounded-xl bg-[#0b0f17] border border-slate-800">
            <div className="flex justify-between text-xs text-slate-400 mb-1.5">
              <span>Wake Sensitivity</span>
              <span className="tabular-nums text-slate-200">
                {Math.round(wakeState.sensitivity * 100)}%
              </span>
            </div>
            <input
              type="range"
              min="0.3"
              max="0.95"
              step="0.05"
              value={wakeState.sensitivity}
              onChange={(e) => wakeWordService.setSensitivity(parseFloat(e.target.value))}
              className="w-full accent-[#d4a84f]"
              aria-label="Wake-word sensitivity"
            />
          </div>

          <label className="p-3 rounded-xl bg-[#0b0f17] border border-slate-800 flex items-center justify-between cursor-pointer">
            <span className="text-xs text-slate-200">Continuous Follow-up</span>
            <input
              type="checkbox"
              checked={wakeState.continuousConversation}
              onChange={(e) => wakeWordService.setContinuousConversation(e.target.checked)}
              className="w-4 h-4 accent-[#d4a84f]"
            />
          </label>
        </div>

        <div className="flex items-start gap-2 text-xs text-slate-400 leading-relaxed">
          <Info className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" />
          <span>{wakeWordService.getBackgroundLimitationNote()}</span>
        </div>

        {onOpenVoiceModal && (
          <button
            type="button"
            onClick={() => {
              soundFx.playClick();
              onOpenVoiceModal();
            }}
            className="w-full min-h-[42px] px-4 py-2 rounded-xl bg-[#0b0f17] border border-slate-700 hover:border-slate-600 text-xs font-medium text-slate-200"
          >
            Configure Voice Profile, Language &amp; Speed
          </button>
        )}
      </SectionShell>

      {/* 3. Appearance */}
      <SectionShell
        id="appearance"
        icon={<Sliders className="w-4 h-4 text-[#60a5fa]" />}
        title="Appearance"
        summary={`${theme.name} · ${theme.layout.density === 'compact' ? 'Compact' : 'Comfortable'}`}
      >
        <label className="p-3 rounded-xl bg-[#0b0f17] border border-slate-800 flex items-center justify-between cursor-pointer">
          <div>
            <span className="text-xs font-medium text-slate-200 block">Reduced Motion</span>
            <span className="text-xs text-slate-400">Minimize orb and transition animations</span>
          </div>
          <input
            type="checkbox"
            checked={theme.accessibility.reducedMotion}
            onChange={(e) =>
              uiThemeEngine.applyTheme({
                accessibility: { ...theme.accessibility, reducedMotion: e.target.checked },
              })
            }
            className="w-4 h-4 accent-[#d4a84f]"
          />
        </label>

        {onOpenThemeModal && (
          <button
            type="button"
            onClick={() => {
              soundFx.playClick();
              onOpenThemeModal();
            }}
            className="w-full min-h-[42px] px-4 py-2 rounded-xl bg-[#0b0f17] border border-slate-700 hover:border-slate-600 text-xs font-medium text-slate-200"
          >
            Open Theme &amp; Color Customizer
          </button>
        )}
      </SectionShell>

      {/* 4. Permissions */}
      <SectionShell
        id="permissions"
        icon={<ShieldCheck className="w-4 h-4 text-emerald-400" />}
        title="Permissions"
        summary="Microphone, camera, and notification access"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-xl bg-[#0b0f17] border border-slate-800">
          <p className="text-xs text-slate-300">
            Verify Android runtime permissions for voice input, vision camera, and alerts.
          </p>
          <button
            type="button"
            onClick={handleRequestPermissions}
            className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-[#60a5fa] text-slate-950 text-xs font-semibold shrink-0"
          >
            Check Permissions
          </button>
        </div>
        {permissionNote && (
          <div className="p-3 rounded-xl bg-[#0b0f17] border border-slate-800 text-xs text-slate-300">
            {permissionNote}
          </div>
        )}
      </SectionShell>

      {/* 5. Security & Privacy */}
      <SectionShell
        id="security"
        icon={<Lock className="w-4 h-4 text-emerald-400" />}
        title="Security & Privacy"
        summary="Server credentials isolated · Veronica active"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          <div className="p-2.5 rounded-xl bg-[#0b0f17] border border-slate-800 flex items-center justify-between gap-2">
            <span className="text-slate-400">Server Credentials</span>
            <span className="text-emerald-300">
              {securityReport?.serverCredentialsIsolated !== false ? 'Server-Only (Isolated)' : 'Check Config'}
            </span>
          </div>
          <div className="p-2.5 rounded-xl bg-[#0b0f17] border border-slate-800 flex items-center justify-between gap-2">
            <span className="text-slate-400">Client API Key Exposure</span>
            <span className="text-emerald-300">None (Zero Client Keys)</span>
          </div>
          {securityReport && (
            <>
              <div className="p-2.5 rounded-xl bg-[#0b0f17] border border-slate-800 flex items-center justify-between gap-2">
                <span className="text-slate-400">Server CORS</span>
                <span className="text-slate-200">{securityReport.corsPolicy}</span>
              </div>
              <div className="p-2.5 rounded-xl bg-[#0b0f17] border border-slate-800 flex items-center justify-between gap-2">
                <span className="text-slate-400">Veronica Events</span>
                <span className="text-slate-200 tabular-nums">{securityReport.auditLogCount}</span>
              </div>
            </>
          )}
        </div>
        <p className="text-[11px] text-slate-400 leading-relaxed">
          All Gemini API keys are stored strictly in the server environment (<code className="text-slate-300 font-mono">GEMINI_API_KEY</code>) and never sent to or persisted in the browser.
        </p>
      </SectionShell>

      {/* 6. Device Information */}
      <SectionShell
        id="device"
        icon={<Smartphone className="w-4 h-4 text-slate-300" />}
        title="Device Information"
        summary={`${
          telemetry.platform === 'android' ? telemetry.deviceModel || 'Android SDK 36' : 'Web Runtime'
        } · ${telemetry.online ? telemetry.networkType : 'Offline'}`}
      >
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="p-2.5 rounded-xl bg-[#0b0f17] border border-slate-800">
            <span className="text-slate-400 block">Platform</span>
            <span className="text-slate-100 font-medium">
              {telemetry.platform === 'android'
                ? `Android ${telemetry.deviceModel || 'SDK 36'}`
                : 'Web Browser'}
            </span>
          </div>
          <div className="p-2.5 rounded-xl bg-[#0b0f17] border border-slate-800">
            <span className="text-slate-400 block">Battery</span>
            <span className="text-slate-100 font-medium tabular-nums">
              {telemetry.batteryLevel !== null ? `${telemetry.batteryLevel}%` : 'Unavailable'}
            </span>
          </div>
        </div>

        {updateInfo && (
          <div className="p-3 rounded-xl bg-[#0b0f17] border border-slate-800 space-y-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-200">APK Build Verification</span>
              <span className="text-emerald-300">v{updateInfo.latestVersion}</span>
            </div>
            <p className="text-slate-400">{updateInfo.releaseNotes}</p>
            <div className="flex items-center gap-1.5 text-[11px] font-mono text-slate-400 truncate">
              <FileCheck className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="truncate">SHA-256: {updateInfo.sha256Checksum}</span>
            </div>

            {installStatus && (
              <div
                className={`p-2.5 rounded-lg border flex items-start gap-2 ${
                  installStatus.type === 'ok'
                    ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-200'
                    : installStatus.type === 'err'
                    ? 'bg-rose-950/40 border-rose-500/30 text-rose-200'
                    : 'bg-[#121826] border-slate-700 text-slate-200'
                }`}
              >
                {installStatus.type === 'err' ? (
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                ) : (
                  <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
                )}
                <span>{installStatus.text}</span>
              </div>
            )}

            <button
              type="button"
              onClick={handleVerifyUpdateChecksum}
              className="w-full min-h-[40px] py-2 px-3 rounded-xl bg-[#121826] border border-slate-700 hover:border-slate-600 text-slate-200 text-xs font-medium flex items-center justify-center gap-2"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Verify Package Checksum</span>
            </button>
          </div>
        )}

        {onOpenAudit && (
          <button
            type="button"
            onClick={() => {
              soundFx.playClick();
              onOpenAudit();
            }}
            className="w-full min-h-[42px] px-4 py-2 rounded-xl bg-[#0b0f17] border border-slate-700 hover:border-slate-600 text-xs font-medium text-slate-200"
          >
            Run Controlled Self-Improvement Audit
          </button>
        )}
      </SectionShell>

      {/* 7. Memory & Personalization */}
      <SectionShell
        id="memory"
        icon={<Database className="w-4 h-4 text-[#d4a84f]" />}
        title="Memory & Personalization"
        summary={memoryEnabled ? 'Personal memory active' : 'Personal memory paused'}
      >
        <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-[#0b0f17] border border-slate-800">
          <div>
            <span className="text-xs font-medium text-slate-100 block">Personal Memory</span>
            <span className="text-xs text-slate-400">
              Allow BUDDY to recall user-approved facts and preferences
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              soundFx.playClick();
              const next = !memoryEnabled;
              personalMemoryService.setEnabled(next);
              setMemoryEnabled(next);
            }}
            className={`min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-medium border ${
              memoryEnabled
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                : 'bg-[#121826] border-slate-700 text-slate-300'
            }`}
          >
            {memoryEnabled ? 'Active' : 'Paused'}
          </button>
        </div>

        {onOpenMemory && (
          <button
            type="button"
            onClick={() => {
              soundFx.playClick();
              onOpenMemory();
            }}
            className="w-full min-h-[42px] px-4 py-2 rounded-xl bg-[#0b0f17] border border-slate-700 hover:border-slate-600 text-xs font-medium text-slate-200"
          >
            Manage Personal World Model Entries
          </button>
        )}
      </SectionShell>
    </div>
  );
};
