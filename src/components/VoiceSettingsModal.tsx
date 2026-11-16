import React, { useState, useEffect } from 'react';
import {
  Volume2,
  Globe,
  Sliders,
  Play,
  Square,
  Sparkles,
  Info,
  X,
  Radio,
  Check,
  RotateCcw,
  User,
  AlertTriangle,
  Download,
} from 'lucide-react';
import {
  voiceProfileManager,
  VOICE_PROFILES,
  SUPPORTED_LANGUAGES,
} from '../services/voiceProfileManager';
import { voiceService, SystemVoice, ResolvedVoiceResult } from '../services/voiceService';
import { wakeWordService } from '../services/wakeWordService';
import { soundFx } from '../services/soundFx';
import { VoiceProfileId } from '../types/suryaTheme';

interface VoiceSettingsModalProps {
  onClose: () => void;
}

export const VoiceSettingsModal: React.FC<VoiceSettingsModalProps> = ({ onClose }) => {
  const [settings, setSettings] = useState(voiceProfileManager.getSettings());
  const [isPlayingSample, setIsPlayingSample] = useState(false);
  const [filterGender, setFilterGender] = useState<'all' | 'male' | 'female' | 'neutral'>('all');
  const [systemVoices, setSystemVoices] = useState<SystemVoice[]>([]);
  const [previewingURI, setPreviewingURI] = useState<string | null>(null);
  const [resolvedVoice, setResolvedVoice] = useState<ResolvedVoiceResult>(() => voiceService.resolveVoice());

  const activeProfile = voiceProfileManager.getActiveProfile();
  const hardwareNotice = voiceProfileManager.getHardwareCapabilityNotice();
  const filteredProfiles = voiceProfileManager.getProfilesByGender(filterGender);

  const refreshVoicesAndResolution = () => {
    const voices = voiceService.getAvailableVoices();
    setSystemVoices(voices);
    setResolvedVoice(voiceService.resolveVoice());
  };

  useEffect(() => {
    refreshVoicesAndResolution();

    // Listen to voice settings changes
    const unsub = voiceProfileManager.subscribe((newSettings) => {
      setSettings(newSettings);
      setResolvedVoice(voiceService.resolveVoice());
    });

    // In browsers, voices might load asynchronously
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = () => {
        refreshVoicesAndResolution();
      };
    }

    return () => {
      unsub();
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.onvoiceschanged = null;
      }
    };
  }, []);

  const handleSelectProfile = (id: VoiceProfileId) => {
    soundFx.playClick();
    voiceProfileManager.setProfile(id);
    setResolvedVoice(voiceService.resolveVoice({ profileId: id }));
  };

  const handleSelectLanguage = (code: string) => {
    soundFx.playClick();
    voiceProfileManager.setLanguage(code);
    setResolvedVoice(voiceService.resolveVoice({ language: code }));
  };

  const handleRateChange = (newRate: number) => {
    voiceProfileManager.setRate(newRate);
  };

  const handlePitchChange = (newPitch: number) => {
    voiceProfileManager.setPitch(newPitch);
  };

  const handleSelectVoiceURI = (uri: string) => {
    soundFx.playClick();
    voiceProfileManager.setSelectedVoiceURI(uri);
    setResolvedVoice(voiceService.resolveVoice({ voiceOverrideURI: uri }));
  };

  const handleReset = () => {
    soundFx.playClick();
    voiceProfileManager.resetToDefault();
    setResolvedVoice(voiceService.resolveVoice());
  };

  const handleToggleWakeWord = () => {
    soundFx.playClick();
    const nextVal = !settings.wakeWordEnabled;
    voiceProfileManager.setWakeWordEnabled(nextVal);
    if (nextVal) {
      wakeWordService.enable();
    } else {
      wakeWordService.disable();
    }
  };

  const handleAudition = () => {
    if (isPlayingSample) {
      voiceService.stopSpeaking();
      setIsPlayingSample(false);
      return;
    }

    soundFx.playAuthorize();
    setIsPlayingSample(true);
    // Speaks with active profile's resolved voice
    voiceService.speak(activeProfile.samplePhrase, () => {
      setIsPlayingSample(false);
    });
  };

  const handlePreviewSystemVoice = (voice: SystemVoice) => {
    if (previewingURI === voice.voiceURI) {
      voiceService.stopSpeaking();
      setPreviewingURI(null);
      return;
    }
    setPreviewingURI(voice.voiceURI);
    // Directly previews THAT EXACT VOICE by passing voice.voiceURI as voiceOverrideURI!
    voiceService.speak(
      `Auditioning voice ${voice.displayName || voice.name}.`,
      () => {
        setPreviewingURI(null);
      },
      voice.voiceURI
    );
  };

  const handleOpenInstaller = () => {
    soundFx.playClick();
    voiceService.openOfflineVoicePackInstaller();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Voice & Personality Settings"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-slate-950/85 backdrop-blur-md animate-in fade-in"
    >
      <div className="w-full max-w-2xl max-h-[92vh] flex flex-col bg-slate-900 border border-amber-500/40 rounded-2xl shadow-2xl overflow-hidden font-sans">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-[#070d14]/90 border-b border-emerald-500/20">
          <div className="flex items-center gap-2">
            <Volume2 className="w-5 h-5 text-emerald-400" />
            <div>
              <h2 className="text-sm font-mono font-bold text-emerald-300 tracking-wider uppercase">
                BUDDY VOICE &amp; TTS SELECTION
              </h2>
              <p className="text-[10px] text-slate-400">JARVIS, STARK, ATLAS (Male) &amp; Preserved Female Voices</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleReset}
              title="Reset to Default"
              className="px-2.5 py-1.5 rounded-lg text-xs font-mono text-slate-300 bg-[#0b1522] hover:bg-[#0f1f32] border border-emerald-500/25 flex items-center gap-1 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5 text-emerald-400" />
              <span>Reset</span>
            </button>
            <button
              onClick={() => {
                soundFx.playClick();
                voiceService.stopSpeaking();
                onClose();
              }}
              aria-label="Close voice settings"
              className="p-1.5 rounded-lg text-slate-400 hover:text-white bg-slate-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 p-4 overflow-y-auto space-y-4">
          {/* Active Voice Profile Card & Audition */}
          <div className="p-3.5 rounded-xl bg-gradient-to-r from-amber-950/40 via-slate-900 to-slate-900 border border-amber-500/30 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
                <span className="text-xs font-mono font-bold text-amber-300 uppercase">
                  ACTIVE PROFILE: {activeProfile.name}
                </span>
                {activeProfile.gender === 'male' && (
                  <span
                    className={`text-[9px] px-2 py-0.5 rounded font-mono font-bold uppercase ${
                      resolvedVoice.isVerifiedMale
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                    }`}
                  >
                    {resolvedVoice.isVerifiedMale ? 'MALE (VERIFIED)' : 'MALE (FALLBACK)'}
                  </span>
                )}
                {activeProfile.gender === 'female' && (
                  <span className="text-[9px] px-2 py-0.5 rounded font-mono font-bold uppercase bg-pink-500/20 text-pink-300 border border-pink-500/30">
                    FEMALE
                  </span>
                )}
                {activeProfile.gender === 'neutral' && (
                  <span className="text-[9px] px-2 py-0.5 rounded font-mono font-bold uppercase bg-slate-700/50 text-slate-300 border border-slate-600">
                    NEUTRAL
                  </span>
                )}
              </div>
              <h3 className="text-sm font-bold text-slate-100 truncate">{activeProfile.title}</h3>
              <p className="text-[11px] text-slate-400 mt-0.5 truncate">{activeProfile.timbreDescription}</p>
              <div className="text-[10px] font-mono text-cyan-300 mt-1 flex items-center gap-1 truncate">
                <span>Output Voice:</span>
                <span className="text-slate-200 font-semibold truncate">
                  {resolvedVoice.voice?.name || resolvedVoice.voiceURI || 'Default Engine Voice'}
                </span>
              </div>
            </div>

            <button
              onClick={handleAudition}
              className={`px-3.5 py-2.5 rounded-xl font-mono text-xs font-bold flex items-center gap-1.5 transition-all shadow-md shrink-0 active:scale-95 ${
                isPlayingSample
                  ? 'bg-rose-500 text-white animate-pulse'
                  : 'bg-amber-500 text-slate-950 hover:bg-amber-400'
              }`}
            >
              {isPlayingSample ? <Square className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              <span>{isPlayingSample ? 'STOP' : 'AUDITION'}</span>
            </button>
          </div>

          {/* Missing Male Voice Warning Banner */}
          {activeProfile.gender === 'male' && resolvedVoice.requiresVoiceInstall && (
            <div className="p-3.5 rounded-xl bg-amber-950/40 border border-amber-500/50 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs animate-in fade-in">
              <div className="flex items-start gap-2.5 text-amber-200">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold text-amber-300 block">No Verified Male Voice Pack Installed</span>
                  <span className="text-[11px] text-slate-300 leading-relaxed block mt-0.5">
                    {resolvedVoice.warningMessage ||
                      'Your device speech engine does not have an installed male voice for this language. Install voice data in Android settings to enable true male speech.'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={handleOpenInstaller}
                className="px-3 py-1.5 rounded-lg bg-amber-500 text-slate-950 font-bold text-xs flex items-center gap-1.5 shrink-0 hover:bg-amber-400 transition-colors shadow-sm"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Install Voices</span>
              </button>
            </div>
          )}

          {/* Gender Filter Tabs & Profiles Grid */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-bold text-slate-300 uppercase">
                VOICE PROFILES ({filteredProfiles.length})
              </span>
              <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
                {(['all', 'male', 'female', 'neutral'] as const).map((g) => (
                  <button
                    key={g}
                    onClick={() => {
                      soundFx.playClick();
                      setFilterGender(g);
                    }}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-mono capitalize transition-colors ${
                      filterGender === g
                        ? 'bg-amber-500 text-slate-950 font-bold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              {filteredProfiles.map((prof) => {
                const isSelected = settings.profileId === prof.id;
                return (
                  <button
                    key={prof.id}
                    onClick={() => handleSelectProfile(prof.id)}
                    className={`p-3 rounded-xl border text-left transition-all flex flex-col justify-between min-h-[96px] active:scale-95 ${
                      isSelected
                        ? 'bg-slate-800 border-amber-400 ring-1 ring-amber-400 shadow-md shadow-amber-500/20'
                        : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold text-slate-100 truncate flex items-center gap-1.5">
                          <User
                            className={`w-3.5 h-3.5 ${
                              prof.gender === 'male'
                                ? 'text-blue-400'
                                : prof.gender === 'female'
                                ? 'text-pink-400'
                                : 'text-amber-400'
                            }`}
                          />
                          {prof.name}
                        </span>
                        {isSelected && <Check className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                      </div>
                      <span className="text-[10px] font-mono text-amber-400 block mb-1">
                        {prof.title}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400 line-clamp-2 leading-relaxed">
                      {prof.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Installed Device TTS Voices List with Audition & Apply */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-bold text-slate-300 uppercase">
                INSTALLED TTS VOICES ({systemVoices.length})
              </span>
              <button
                type="button"
                onClick={handleOpenInstaller}
                className="text-[10px] font-mono text-cyan-400 hover:underline flex items-center gap-1"
              >
                <span>Manage Voice Packs</span>
              </button>
            </div>
            {systemVoices.length === 0 ? (
              <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800 text-center text-xs text-slate-400">
                Querying installed system voices... (Android TTS / Web Speech)
              </div>
            ) : (
              <div className="max-h-40 overflow-y-auto space-y-1.5 p-2 bg-slate-950/60 rounded-xl border border-slate-800">
                {systemVoices.map((v, idx) => {
                  const isApplied = settings.selectedVoiceURI === v.voiceURI;
                  const isPreviewing = previewingURI === v.voiceURI;
                  return (
                    <div
                      key={v.voiceURI || idx}
                      className={`px-3 py-2 rounded-lg flex items-center justify-between text-xs transition-colors ${
                        isApplied
                          ? 'bg-amber-500/15 border border-amber-500/40 text-amber-200'
                          : 'bg-slate-900 hover:bg-slate-800/80 text-slate-300'
                      }`}
                    >
                      <div className="min-w-0 pr-2">
                        <div className="font-medium truncate flex items-center gap-1.5 flex-wrap">
                          <span className="truncate">{v.name}</span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                            {v.lang}
                          </span>
                          <span
                            className={`text-[9px] px-1.5 py-0.5 rounded font-mono uppercase font-bold ${
                              v.gender === 'male'
                                ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                                : v.gender === 'female'
                                ? 'bg-pink-500/20 text-pink-300 border border-pink-500/30'
                                : 'bg-slate-800 text-slate-400'
                            }`}
                          >
                            {v.gender}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => handlePreviewSystemVoice(v)}
                          className={`px-2 py-1 rounded text-[10px] font-mono flex items-center gap-1 transition-colors ${
                            isPreviewing
                              ? 'bg-rose-500 text-white animate-pulse'
                              : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                          }`}
                        >
                          {isPreviewing ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3 text-amber-400" />}
                          <span>{isPreviewing ? 'Stop' : 'Preview'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSelectVoiceURI(v.voiceURI)}
                          className={`px-2.5 py-1 rounded text-[10px] font-mono font-bold transition-colors ${
                            isApplied
                              ? 'bg-amber-500 text-slate-950'
                              : 'bg-slate-800 hover:bg-slate-700 text-amber-300'
                          }`}
                        >
                          {isApplied ? 'ACTIVE' : 'APPLY'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Multilingual Language Selector */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Globe className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-mono font-bold text-slate-300 uppercase">
                TARGET LANGUAGE &amp; LOCALE (20+ SUPPORTED)
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-36 overflow-y-auto p-1 bg-slate-950/60 rounded-xl border border-slate-800">
              {SUPPORTED_LANGUAGES.map((lang) => {
                const active = settings.language === lang.code;
                return (
                  <button
                    key={lang.code}
                    onClick={() => handleSelectLanguage(lang.code)}
                    className={`px-2.5 py-1.5 rounded-lg text-left text-xs transition-colors flex items-center justify-between ${
                      active
                        ? 'bg-amber-500 text-slate-950 font-bold'
                        : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <span className="truncate">{lang.name}</span>
                    <span className="text-[9px] opacity-75 font-mono">{lang.code.slice(0, 2).toUpperCase()}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Speech Rate & Pitch Controls */}
          <div className="p-3.5 rounded-xl bg-slate-800/60 border border-slate-700/60 space-y-3">
            <span className="text-xs font-mono font-bold text-slate-300 block uppercase">
              SPEECH RATE &amp; PITCH CALIBRATION
            </span>

            <div>
              <div className="flex items-center justify-between text-xs text-slate-300 mb-1">
                <span>Speech Rate ({settings.rate.toFixed(2)}x)</span>
                <span className="text-[10px] font-mono text-amber-400">
                  {settings.rate > 1.1 ? 'Fast' : settings.rate < 0.95 ? 'Slow' : 'Optimal'}
                </span>
              </div>
              <input
                type="range"
                min="0.75"
                max="1.45"
                step="0.05"
                value={settings.rate}
                onChange={(e) => handleRateChange(parseFloat(e.target.value))}
                className="w-full accent-amber-500"
              />
            </div>

            <div>
              <div className="flex items-center justify-between text-xs text-slate-300 mb-1">
                <span>Pitch Tone ({settings.pitch.toFixed(2)})</span>
                <span className="text-[10px] font-mono text-amber-400">
                  {settings.pitch < 0.92 ? 'Deep Baritone' : settings.pitch > 1.05 ? 'Crisp Tenor' : 'Neutral'}
                </span>
              </div>
              <input
                type="range"
                min="0.65"
                max="1.35"
                step="0.05"
                value={settings.pitch}
                onChange={(e) => handlePitchChange(parseFloat(e.target.value))}
                className="w-full accent-amber-500"
              />
            </div>
          </div>

          {/* "Hey BUDDY" Wake Word Activation */}
          <div className="p-3.5 rounded-xl bg-[#0b1522] border border-emerald-500/25 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Radio
                  className={`w-4 h-4 ${settings.wakeWordEnabled ? 'text-emerald-400 animate-pulse' : 'text-slate-400'}`}
                />
                <div>
                  <span className="text-xs font-bold text-slate-200 block">"Hey BUDDY" Voice Activation</span>
                  <span className="text-[10px] text-slate-400">Continuously listen for "Hey BUDDY" / "Hey SURYA"</span>
                </div>
              </div>
              <input
                type="checkbox"
                checked={settings.wakeWordEnabled}
                onChange={handleToggleWakeWord}
                className="w-4 h-4 rounded text-emerald-500 focus:ring-emerald-400 cursor-pointer"
              />
            </div>

            {settings.wakeWordEnabled && (
              <div className="pt-2 border-t border-slate-700/60 text-[11px] text-emerald-400 font-mono flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                <span>Wake-word listener online. Microphone active with visible indicator.</span>
              </div>
            )}
          </div>

          {/* Hardware Capability Notice */}
          <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 flex items-start gap-2.5 text-[11px] text-slate-400 leading-relaxed">
            <Info className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-bold text-slate-300 block mb-0.5">Device Telemetry &amp; Limitations:</span>
              <span>{hardwareNotice.message}</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 bg-slate-950/90 border-t border-slate-800 flex justify-end">
          <button
            onClick={() => {
              soundFx.playClick();
              voiceService.stopSpeaking();
              onClose();
            }}
            className="px-4 py-2 rounded-xl bg-amber-500 text-slate-950 font-mono text-xs font-bold hover:bg-amber-400 transition-colors"
          >
            DONE
          </button>
        </div>
      </div>
    </div>
  );
};
