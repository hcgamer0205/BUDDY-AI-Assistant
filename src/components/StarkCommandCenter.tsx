import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Volume2,
  Square,
  ArrowRight,
  RefreshCw,
  Cpu,
  Settings,
  Mic,
  Trash2,
  Download,
  MoreHorizontal,
  SlidersHorizontal,
  Search,
  X,
  WifiOff,
  Radio,
} from 'lucide-react';
import { ChatMessage, ResponseMode, StarkActionPlan } from '../types/surya';
import { apiService, ConnectionStatusSnapshot } from '../services/apiService';
import { intelligenceRouter } from '../services/intelligenceRouter';
import { liveApiService, LiveSessionState } from '../services/liveApiService';
import { voiceService } from '../services/voiceService';
import { soundFx } from '../services/soundFx';
import { uiThemeEngine } from '../services/uiThemeEngine';
import { SuryaThemeConfig } from '../types/suryaTheme';

interface StarkCommandCenterProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  onVoiceCapture?: (transcript: string) => void;
  onClearHistory?: () => void;
  onExecutePlan: (plan: StarkActionPlan) => void;
  isProcessing: boolean;
  activeModel?: string;
  responseMode: ResponseMode;
  onChangeResponseMode: (mode: ResponseMode) => void;
  onOpenModelModal?: () => void;
  onOpenGeminiSettings?: () => void;
  onOpenTelemetry?: () => void;
  onOpenOfflineSettings?: () => void;
  onStopGenerating?: () => void;
}

export const StarkCommandCenter: React.FC<StarkCommandCenterProps> = ({
  messages,
  onSendMessage,
  onVoiceCapture,
  onClearHistory,
  onExecutePlan,
  isProcessing,
  activeModel = 'gemini-3.8-flash',
  responseMode,
  onChangeResponseMode,
  onOpenModelModal,
  onOpenGeminiSettings,
  onOpenTelemetry,
  onOpenOfflineSettings,
  onStopGenerating,
}) => {
  const [inputText, setInputText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [theme, setTheme] = useState<SuryaThemeConfig>(uiThemeEngine.getCurrentTheme());
  const [voiceState, setVoiceState] = useState(voiceService.getState());
  const [liveState, setLiveState] = useState<LiveSessionState>(() => liveApiService.getState());
  const [routerStatus, setRouterStatus] = useState(() => intelligenceRouter.getEffectiveStatus());
  const [connStatus, setConnStatus] = useState<ConnectionStatusSnapshot>(() =>
    apiService.getConnectionStatus()
  );
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const unsubTheme = uiThemeEngine.subscribe(setTheme);
    const unsubVoice = voiceService.subscribe(setVoiceState);
    const unsubLive = liveApiService.subscribe(setLiveState);
    const unsubRouter = intelligenceRouter.subscribe(setRouterStatus);
    const unsubConn = apiService.subscribeConnectionState(setConnStatus);
    return () => {
      unsubTheme();
      unsubVoice();
      unsubLive();
      unsubRouter();
      unsubConn();
    };
  }, []);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages, isProcessing]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isProcessing) return;
    soundFx.playClick();
    onSendMessage(inputText.trim());
    setInputText('');
  };

  const handleExportChat = () => {
    const blob = new Blob([JSON.stringify(messages, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `buddy-conversation-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMenuOpen(false);
  };

  const openGeminiSetup = () => {
    soundFx.playClick();
    if (onOpenGeminiSettings) {
      onOpenGeminiSettings();
    } else if (onOpenTelemetry) {
      onOpenTelemetry();
    }
  };

  const quickSuggestions = [
    'Summarize my day',
    'Open YouTube',
    'Add task Review Android APK build',
    'Remember that I prefer concise replies',
  ];

  const isOfflineMode = routerStatus.mode === 'offline';

  const visibleMessages = searchQuery.trim()
    ? messages.filter((m) =>
        m.content.toLowerCase().includes(searchQuery.trim().toLowerCase())
      )
    : messages;

  return (
    <div className="flex flex-col h-[calc(100vh-7.5rem)] w-full max-w-3xl mx-auto px-4 pt-3 pb-20 select-none">
      {/* Clean Chat Header with Glassmorphism */}
      <div className="flex items-center justify-between gap-2 pb-3 border-b border-emerald-500/20">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-white tracking-wide">BUDDY Chat</h2>
          <p className="text-xs text-emerald-300/80 truncate">
            {isOfflineMode
              ? routerStatus.localReady
                ? `Offline Ready · ${routerStatus.activeLocalModelName}`
                : 'Offline Mode · Local tools active (no local model installed)'
              : routerStatus.activePath === 'on-device-llm'
              ? `Offline Ready · ${routerStatus.activeLocalModelName}`
              : !routerStatus.networkOnline
              ? routerStatus.localReady
                ? `Offline Ready · ${routerStatus.activeLocalModelName}`
                : 'Server Unavailable · Network offline'
              : connStatus.state === 'CONNECTING'
              ? `Connecting · ${activeModel}`
              : connStatus.state === 'CONNECTED' && connStatus.geminiConfigured === true
              ? `Gemini Ready · ${activeModel}`
              : 'Server Unavailable'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {onOpenModelModal && (
            <button
              type="button"
              onClick={() => {
                soundFx.playClick();
                onOpenModelModal();
              }}
              className="min-h-[36px] flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#0b1522]/80 backdrop-blur-md border border-emerald-500/25 hover:border-emerald-400/50 text-xs text-slate-200 transition-all cursor-pointer shadow-sm"
            >
              <Cpu className="w-3.5 h-3.5 text-emerald-400" />
              <span className="truncate max-w-[130px]">
                {routerStatus.activePath === 'on-device-llm' && routerStatus.activeLocalModelName
                  ? routerStatus.activeLocalModelName
                  : activeModel}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              soundFx.playClick();
              setShowSearch((prev) => !prev);
            }}
            aria-label="Search conversation history"
            className={`min-h-[36px] min-w-[36px] p-2 rounded-xl border flex items-center justify-center transition-all cursor-pointer ${
              showSearch
                ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.4)]'
                : 'bg-[#0b1522]/80 backdrop-blur-md border-emerald-500/25 hover:border-emerald-400/50 text-slate-300'
            }`}
          >
            <Search className="w-4 h-4" />
          </button>

          {/* Overflow Menu */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => {
                soundFx.playClick();
                setMenuOpen((prev) => !prev);
              }}
              aria-label="Conversation options"
              aria-expanded={menuOpen}
              className="min-h-[36px] min-w-[36px] p-2 rounded-xl bg-[#0b1522]/80 backdrop-blur-md border border-emerald-500/25 hover:border-emerald-400/50 text-slate-300 flex items-center justify-center transition-all cursor-pointer"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>

            {menuOpen && (
              <div className="absolute right-0 mt-2 w-56 rounded-2xl bg-[#0b1522]/95 backdrop-blur-2xl border border-emerald-500/25 shadow-2xl py-1.5 z-30">
                <div className="px-3 py-2 border-b border-emerald-500/15">
                  <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1.5">
                    <SlidersHorizontal className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Response Mode</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1 p-0.5 rounded-lg bg-[#070d14] border border-emerald-500/20">
                    <button
                      type="button"
                      onClick={() => {
                        soundFx.playClick();
                        onChangeResponseMode('concise');
                      }}
                      className={`py-1 rounded-md text-xs font-medium transition-colors ${
                        responseMode === 'concise'
                          ? 'bg-[#d4a84f] text-slate-950'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Concise
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        soundFx.playClick();
                        onChangeResponseMode('detailed');
                      }}
                      className={`py-1 rounded-md text-xs font-medium transition-colors ${
                        responseMode === 'detailed'
                          ? 'bg-[#d4a84f] text-slate-950'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Detailed
                    </button>
                  </div>
                </div>

                {(onOpenGeminiSettings || onOpenTelemetry) && (
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      openGeminiSetup();
                    }}
                    className="w-full px-3.5 py-2.5 text-left text-xs text-slate-200 hover:bg-slate-800/60 flex items-center gap-2.5"
                  >
                    <Settings className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Gemini &amp; Model Settings</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleExportChat}
                  className="w-full px-3.5 py-2.5 text-left text-xs text-slate-200 hover:bg-slate-800/60 flex items-center gap-2.5"
                >
                  <Download className="w-3.5 h-3.5 text-slate-400" />
                  <span>Export Conversation</span>
                </button>

                {onClearHistory && (
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onClearHistory();
                    }}
                    className="w-full px-3.5 py-2.5 text-left text-xs text-rose-300 hover:bg-rose-950/30 flex items-center gap-2.5"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Clear Conversation</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Local History Search Bar */}
      {showSearch && (
        <div className="mt-2.5 flex items-center gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search local conversation history..."
            aria-label="Filter local conversation history"
            className="flex-1 min-h-[38px] px-3 rounded-xl bg-[#121826] border border-slate-800 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-[#d4a84f]"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
              className="min-h-[38px] px-2.5 rounded-xl bg-[#121826] border border-slate-800 text-slate-400 hover:text-slate-200"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {/* Offline AI Status Card when in Offline Mode */}
      {isOfflineMode && (
        <div className="mt-3 p-3.5 rounded-2xl bg-[#0b1522]/90 backdrop-blur-xl border border-emerald-500/25 shadow-lg flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0 mt-0.5">
              {routerStatus.localReady ? (
                <Radio className="w-4 h-4 text-emerald-400" />
              ) : (
                <WifiOff className="w-4 h-4 text-amber-400" />
              )}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-emerald-200">
                {routerStatus.localReady
                  ? `Offline AI Ready · ${routerStatus.activeLocalModelName}`
                  : 'Offline Mode · Local AI Model Not Installed'}
              </p>
              <p className="text-[11px] text-slate-400 leading-relaxed mt-0.5">
                {routerStatus.localReady
                  ? 'Running 100% on-device. Online Gemini requests are disabled in Offline mode.'
                  : 'Local commands, tasks, notes, and Knowledge Vault work offline. Install & load an offline model for on-device chat.'}
              </p>
            </div>
          </div>
          {!routerStatus.localReady && onOpenOfflineSettings && (
            <button
              type="button"
              onClick={() => {
                soundFx.playClick();
                onOpenOfflineSettings();
              }}
              className="min-h-[34px] px-3 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs shrink-0 cursor-pointer"
            >
              Open Offline AI Settings
            </button>
          )}
        </div>
      )}

      {/* Messages Area */}
      <div
        ref={chatScrollRef}
        className="flex-1 overflow-y-auto py-4 space-y-4 pr-1"
      >
        {visibleMessages.length === 0 && searchQuery.trim() && (
          <p className="text-xs text-slate-400 text-center py-6">
            No local messages matching &ldquo;{searchQuery.trim()}&rdquo;.
          </p>
        )}
        {visibleMessages.map((msg) => {
          const isUser = msg.role === 'user';
          const isSystem = msg.role === 'system';

          return (
            <div
              key={msg.id}
              className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
            >
              <div
                className={`max-w-[86%] sm:max-w-[78%] rounded-2xl px-4 py-3 text-sm leading-relaxed backdrop-blur-xl shadow-lg ${
                  isUser
                    ? 'bg-emerald-950/45 border border-emerald-500/30 text-emerald-100 rounded-br-sm'
                    : isSystem
                    ? 'bg-rose-950/45 border border-rose-500/35 text-rose-100 rounded-bl-sm'
                    : 'bg-[#0b1522]/85 border border-emerald-500/20 text-slate-100 rounded-bl-sm'
                }`}
              >
                <div className="whitespace-pre-wrap">{msg.content || '...'}</div>

                {msg.suggestedAction && (
                  <div className="mt-3 p-3 rounded-2xl bg-[#070d14]/90 border border-emerald-500/25 flex items-center justify-between gap-3 shadow-inner">
                    <div className="min-w-0">
                      <span className="text-xs font-semibold text-emerald-200 block truncate">
                        {msg.suggestedAction.name}
                      </span>
                      <span className="text-[11px] text-slate-400 block truncate">
                        {msg.suggestedAction.riskLevel === 'HIGH' ? 'Requires confirmation · ' : ''}
                        {msg.suggestedAction.intent}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        soundFx.playClick();
                        onExecutePlan(msg.suggestedAction!);
                      }}
                      className="min-h-[36px] px-3.5 py-1.5 rounded-xl text-xs font-semibold text-slate-950 flex items-center gap-1.5 shrink-0 bg-emerald-500 hover:bg-emerald-400 transition-colors shadow-sm cursor-pointer"
                    >
                      <span>Run</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                <div className="mt-1.5 flex items-center justify-between gap-4 text-[11px] text-slate-500">
                  <span className="tabular-nums">
                    {new Date(msg.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>

                  {msg.role === 'assistant' && msg.content && (
                    <button
                      type="button"
                      onClick={() => {
                        soundFx.playClick();
                        voiceService.speak(msg.content);
                      }}
                      aria-label="Speak reply aloud"
                      className="text-slate-400 hover:text-emerald-300 transition-colors p-0.5 cursor-pointer"
                      title="Speak aloud"
                    >
                      <Volume2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {messages.length <= 1 && !isProcessing && (
          <div className="flex flex-wrap gap-2 pt-2">
            {quickSuggestions.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => {
                  soundFx.playClick();
                  onSendMessage(prompt);
                }}
                className="px-3 py-1.5 rounded-xl bg-[#0b1522]/70 hover:bg-[#0f1f32]/90 border border-emerald-500/20 hover:border-emerald-500/40 text-xs text-emerald-200 transition-all cursor-pointer shadow-sm"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}

        {isProcessing && (
          <div className="flex items-center justify-between gap-2 text-xs text-emerald-300 px-1 font-medium">
            <div className="flex items-center gap-2">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-teal-400" />
              <span>BUDDY is thinking...</span>
            </div>
            {onStopGenerating && (
              <button
                type="button"
                onClick={() => {
                  soundFx.playAbort();
                  onStopGenerating();
                }}
                aria-label="Stop generating"
                className="px-2.5 py-1 rounded-lg bg-rose-950/50 border border-rose-500/40 text-rose-200 hover:bg-rose-900/50 flex items-center gap-1 text-[11px] font-semibold cursor-pointer"
              >
                <Square className="w-3 h-3 fill-current" />
                <span>Stop</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Bottom Composer in Emerald-Teal Glassmorphic Panel */}
      <form onSubmit={handleSubmit} className="pt-2 flex items-center gap-2">
        {onVoiceCapture && (
          <button
            type="button"
            onClick={() => {
              soundFx.playClick();
              if (voiceState.isSpeaking) {
                voiceService.interruptAndListen(onVoiceCapture);
              } else if (voiceState.isListening) {
                voiceService.stopListening();
              } else {
                voiceService.startListening(onVoiceCapture);
              }
            }}
            aria-label={voiceState.isListening ? 'Stop voice input' : 'Voice input'}
            className={`min-h-[46px] min-w-[46px] rounded-2xl border flex items-center justify-center transition-all cursor-pointer ${
              voiceState.isListening
                ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow-[0_0_16px_rgba(16,185,129,0.5)]'
                : 'bg-[#0b1522]/85 text-emerald-300 border-emerald-500/25 hover:border-emerald-400/50 shadow-sm'
            }`}
          >
            <Mic className="w-4 h-4" />
          </button>
        )}

        {!isOfflineMode && (
          <button
            type="button"
            onClick={() => {
              soundFx.playClick();
              if (liveState.connected || liveState.connecting) {
                liveApiService.disconnect();
              } else {
                liveApiService.connect();
              }
            }}
            aria-label={liveState.connected ? 'End Live Voice' : 'Live Voice'}
            title={liveState.connected ? 'End Gemini Live Voice' : 'Start Gemini Live Voice'}
            className={`min-h-[46px] min-w-[46px] rounded-2xl border flex items-center justify-center transition-all cursor-pointer ${
              liveState.connected
                ? 'bg-teal-400 text-slate-950 border-teal-200 shadow-[0_0_16px_rgba(45,212,191,0.5)]'
                : 'bg-[#0b1522]/85 text-teal-300 border-emerald-500/25 hover:border-teal-400/60 shadow-sm'
            }`}
          >
            <Radio className={`w-4 h-4 ${liveState.connected || liveState.connecting ? 'animate-pulse' : ''}`} />
          </button>
        )}

        {voiceState.isSpeaking && (
          <button
            type="button"
            onClick={() => voiceService.stopSpeaking()}
            aria-label="Stop speaking"
            className="min-h-[46px] min-w-[46px] rounded-2xl bg-[#0b1522]/85 border border-slate-700 text-rose-400 flex items-center justify-center cursor-pointer shadow-sm"
          >
            <Square className="w-3.5 h-3.5 fill-current" />
          </button>
        )}

        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Message BUDDY..."
          aria-label="Message BUDDY"
          className="flex-1 min-h-[46px] bg-[#0b1522]/85 backdrop-blur-xl border border-emerald-500/25 focus:border-emerald-400/80 rounded-2xl px-4 text-sm text-slate-100 placeholder-slate-400 focus:outline-none transition-all shadow-inner"
        />

        <button
          type="submit"
          disabled={!inputText.trim() || isProcessing}
          aria-label="Send message"
          className="min-h-[46px] min-w-[46px] px-4 rounded-2xl disabled:opacity-40 text-slate-950 font-semibold flex items-center justify-center active:scale-95 transition-all bg-emerald-500 hover:bg-emerald-400 shadow-[0_0_18px_rgba(16,185,129,0.4)] cursor-pointer"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
};
