import React, { useState, useEffect } from 'react';
import {
  Cpu,
  X,
  Activity,
  HardDrive,
  Download,
  RefreshCw,
} from 'lucide-react';
import { soundFx } from '../services/soundFx';
import { apiService } from '../services/apiService';
import {
  modelPreferenceService,
  ServerGeminiModel,
} from '../services/modelPreferenceService';
import { OFFLINE_MODEL_CATALOG, formatBytes } from '../services/offlineModelHelpers.js';
import { modelDownloadManager } from '../services/modelDownloadManager';
import { localInferenceRuntime } from '../services/localInferenceRuntime';
import { intelligenceRouter } from '../services/intelligenceRouter';

interface ModelSelectorModalProps {
  onClose: () => void;
  activeModel: string;
  onSelectModel: (modelId: string) => void;
  onOpenOfflineStore?: () => void;
  onOpenGeminiSettings?: () => void;
}

export const ModelSelectorModal: React.FC<ModelSelectorModalProps> = ({
  onClose,
  activeModel,
  onSelectModel,
  onOpenOfflineStore,
}) => {
  const [cloudModels, setCloudModels] = useState<ServerGeminiModel[]>(() =>
    modelPreferenceService.getModels()
  );
  const [selectedId, setSelectedId] = useState(
    activeModel || modelPreferenceService.getSelectedModel()
  );
  const [routerStatus, setRouterStatus] = useState(() => intelligenceRouter.getEffectiveStatus());
  const [runtimeState, setRuntimeState] = useState(() => localInferenceRuntime.getState());
  const [downloadedIds, setDownloadedIds] = useState<string[]>(() =>
    modelDownloadManager.getDownloadedModels().map((d) => d.modelId)
  );
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    const unsubModel = modelPreferenceService.subscribe((snap) => {
      setCloudModels(snap.models);
      setSelectedId(snap.selectedModel);
    });
    const unsubRouter = intelligenceRouter.subscribe(setRouterStatus);
    const unsubRt = localInferenceRuntime.subscribe(setRuntimeState);
    const unsubDl = modelDownloadManager.subscribe(() => {
      setDownloadedIds(modelDownloadManager.getDownloadedModels().map((d) => d.modelId));
    });
    modelPreferenceService.refreshFromServer().catch(() => {});
    return () => {
      unsubModel();
      unsubRouter();
      unsubRt();
      unsubDl();
    };
  }, []);

  const handleSelectCloud = (id: string) => {
    soundFx.playClick();
    const updated = modelPreferenceService.setSelectedModel(id);
    setSelectedId(updated);
    onSelectModel(updated);
    setVerifyMessage(null);
  };

  const handleToggleLocalModel = async (modelId: string) => {
    soundFx.playClick();
    setLocalError(null);
    try {
      if (runtimeState.activeModelId === modelId) {
        await localInferenceRuntime.unloadModel();
      } else {
        await localInferenceRuntime.loadModel(modelId);
        soundFx.playAuthorize();
      }
    } catch (e: any) {
      soundFx.playAbort();
      setLocalError(e?.message || 'Unable to load offline model.');
    }
  };

  const handleVerifyServerGemini = async () => {
    soundFx.playClick();
    setIsVerifying(true);
    setVerifyMessage('Verifying server-side Gemini Interactions API...');
    try {
      const res = await apiService.verifyGeminiConnection();
      soundFx.playAuthorize();
      setVerifyMessage(
        `Verified · ${res.model} (${res.resolvedUpstreamModel || 'Interactions API'}) ready (${res.latencyMs} ms).`
      );
    } catch (e: any) {
      soundFx.playAbort();
      setVerifyMessage(e?.message || 'Unable to verify server Gemini connection.');
    } finally {
      setIsVerifying(false);
    }
  };

  const downloadedCatalogModels = OFFLINE_MODEL_CATALOG.filter((m) =>
    downloadedIds.includes(m.id)
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="AI Model Selector"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-[#05080f]/85 backdrop-blur-md"
    >
      <div className="w-full max-w-xl max-h-[90vh] flex flex-col bg-[#0b1522] border border-emerald-500/25 rounded-2xl shadow-2xl overflow-hidden font-sans">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-[#070d14] border-b border-emerald-500/20">
          <div className="flex items-center gap-2.5">
            <Cpu className="w-4 h-4 text-emerald-400" />
            <div>
              <h2 className="text-sm font-semibold text-white">Model &amp; Routing Selector</h2>
              <p className="text-xs text-slate-400">
                Choose Server Gemini, On-Device AI, or automatic routing
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              soundFx.playClick();
              onClose();
            }}
            aria-label="Close modal"
            className="min-h-[36px] min-w-[36px] rounded-xl text-slate-400 hover:text-white bg-[#0b1522] border border-slate-800 flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 p-4 overflow-y-auto space-y-4">
          {/* Routing Mode */}
          <div className="p-3 rounded-xl bg-[#070d14] border border-slate-800 space-y-2">
            <span className="text-xs font-medium text-slate-200 block">Intelligence Mode</span>
            <div className="grid grid-cols-3 gap-1.5 p-1 rounded-xl bg-[#0b1522] border border-slate-800">
              {(['auto', 'online', 'offline'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    soundFx.playClick();
                    intelligenceRouter.setMode(m);
                  }}
                  className={`min-h-[36px] rounded-lg text-xs font-medium capitalize transition-colors cursor-pointer ${
                    routerStatus.mode === m
                      ? 'bg-emerald-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* Downloaded On-Device Models */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
                <HardDrive className="w-3.5 h-3.5 text-[#60a5fa]" />
                <span>On-Device Offline Models</span>
              </span>
              {onOpenOfflineStore && (
                <button
                  type="button"
                  onClick={() => {
                    soundFx.playClick();
                    onClose();
                    onOpenOfflineStore();
                  }}
                  className="text-xs text-[#d4a84f] hover:underline flex items-center gap-1 cursor-pointer"
                >
                  <Download className="w-3 h-3" />
                  <span>Open Model Store</span>
                </button>
              )}
            </div>

            {localError && (
              <div className="p-2.5 rounded-lg bg-rose-950/35 border border-rose-500/30 text-xs text-rose-200">
                {localError}
              </div>
            )}

            {downloadedCatalogModels.length === 0 ? (
              <div className="p-3 rounded-xl bg-[#070d14] border border-slate-800 text-xs text-slate-400 flex items-center justify-between gap-2">
                <span>No local models downloaded yet.</span>
                {onOpenOfflineStore && (
                  <button
                    type="button"
                    onClick={() => {
                      soundFx.playClick();
                      onClose();
                      onOpenOfflineStore();
                    }}
                    className="px-3 py-1.5 rounded-lg bg-[#60a5fa] text-slate-950 font-semibold text-xs shrink-0 cursor-pointer"
                  >
                    Download Model
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {downloadedCatalogModels.map((model) => {
                  const isActive = runtimeState.activeModelId === model.id;
                  return (
                    <div
                      key={model.id}
                      className={`p-3 rounded-xl border flex items-center justify-between gap-3 ${
                        isActive
                          ? 'bg-emerald-950/35 border-emerald-500/50'
                          : 'bg-[#070d14] border-slate-800'
                      }`}
                    >
                      <div className="min-w-0">
                        <span className="text-xs font-semibold text-slate-100 block truncate">
                          {model.displayName}
                        </span>
                        <span className="text-[11px] text-slate-400 block tabular-nums">
                          {model.quantization} · {formatBytes(model.sizeBytes)} · Local
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleToggleLocalModel(model.id)}
                        className={`min-h-[34px] px-3 rounded-lg text-xs font-medium shrink-0 cursor-pointer ${
                          isActive
                            ? 'bg-[#0b1522] border border-slate-700 text-slate-200'
                            : 'bg-emerald-500 text-slate-950 font-semibold'
                        }`}
                      >
                        {isActive ? 'Unload' : 'Activate'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Server Gemini Models */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-300 block">
                Google Gemini Models (Server-Side)
              </span>
              {routerStatus.mode === 'offline' && (
                <span className="text-[10px] text-amber-300">
                  Disabled while Offline mode is active
                </span>
              )}
            </div>

            {cloudModels.map((model) => {
              const isSelected = selectedId === model.id;
              return (
                <button
                  type="button"
                  key={model.id}
                  onClick={() => handleSelectCloud(model.id)}
                  className={`w-full text-left p-3 rounded-xl border transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-emerald-950/35 border-emerald-500/50'
                      : 'bg-[#070d14] border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <span className="text-xs font-semibold text-slate-100 block">
                        {model.name}
                      </span>
                      <span className="text-[10px] text-emerald-300/80 font-mono block">
                        {model.id} · {model.speed}
                      </span>
                    </div>
                    <span
                      className={`text-[11px] shrink-0 font-medium ${
                        isSelected ? 'text-emerald-400' : 'text-slate-400'
                      }`}
                    >
                      {isSelected ? 'Selected' : 'Available'}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1">{model.description}</p>
                </button>
              );
            })}
          </div>

          {/* Verify Server Gemini Connection */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={handleVerifyServerGemini}
              disabled={isVerifying}
              className="w-full min-h-[40px] px-3 rounded-xl bg-[#070d14] hover:bg-slate-800 border border-emerald-500/30 text-xs text-emerald-300 font-medium flex items-center justify-center gap-1.5 cursor-pointer"
            >
              {isVerifying ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Activity className="w-3.5 h-3.5" />
              )}
              <span>{isVerifying ? 'Verifying...' : 'Verify Server Gemini Connection'}</span>
            </button>
            {verifyMessage && (
              <div className="p-2.5 rounded-lg bg-[#070d14] border border-slate-800 text-xs text-slate-300">
                {verifyMessage}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 bg-[#070d14] border-t border-emerald-500/20 flex justify-end">
          <button
            type="button"
            onClick={() => {
              soundFx.playClick();
              onClose();
            }}
            className="min-h-[40px] px-4 py-2 rounded-xl bg-emerald-500 text-slate-950 text-xs font-semibold hover:bg-emerald-400 cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
