/**
 * SURYA Native Android & Web Voice Pipeline
 * Direct integration with AndroidSuryaBridge (SDK 36, TextToSpeech) and Web Speech API.
 * Supports male and female voice selection, true TTS completion callbacks, speech interruption,
 * and unified voice resolution for preview, assistant responses, and voice conversations.
 */

import { voiceProfileManager } from './voiceProfileManager';
import { VoiceProfileId } from '../types/suryaTheme';

export interface VoiceState {
  isListening: boolean;
  isSpeaking: boolean;
  transcript: string;
  error: string | null;
  supported: boolean;
  isNative: boolean;
  audioLevel: number;
}

export interface SystemVoice {
  id: string;
  name: string;
  lang: string;
  voiceURI: string;
  localService: boolean;
  gender: 'male' | 'female' | 'unverified';
  isNative: boolean;
  isVerifiedMale: boolean;
  displayName?: string;
  quality?: number;
  latency?: number;
}

export interface ResolvedVoiceResult {
  voice: any | null;
  voiceURI: string | null;
  gender: 'male' | 'female' | 'neutral' | 'unverified';
  isVerifiedMale: boolean;
  isExactSelection: boolean;
  requiresVoiceInstall: boolean;
  warningMessage: string | null;
  appliedLanguage: string;
  engine: 'android_native' | 'web_speech' | 'none';
}

type VoiceStateCallback = (state: VoiceState) => void;

/**
 * Accurately detects voice gender without female/male substring collisions.
 * Checks female tokens FIRST with word boundary delimiters so "female" will NEVER match "male".
 */
export function detectVoiceGender(voiceName: string, features?: string[]): 'male' | 'female' | 'unverified' {
  if (!voiceName) return 'unverified';

  // Check features array if supplied (Android TTS Voice.getFeatures())
  if (features && Array.isArray(features)) {
    for (const f of features) {
      const lf = f.toLowerCase();
      if (lf.includes('gender=male') || lf === 'male') return 'male';
      if (lf.includes('gender=female') || lf === 'female') return 'female';
    }
  }

  const name = voiceName.toLowerCase();

  // Check female FIRST with boundary delimiters so "female" never matches "male"!
  const isFemale =
    /(^|[^a-z])female([^a-z]|$)/i.test(name) ||
    /(^|[^a-z])(woman|girl|lady)([^a-z]|$)/i.test(name) ||
    /zira|helen|jenny|hazel|samantha|victoria|karen|sfg#female|rjs#female|cfc#female|cxx#female|m01#female/i.test(name);
  if (isFemale) return 'female';

  // Check male with boundary delimiters and known male voice identifiers
  const isMale =
    /(^|[^a-z])(male|guy|man|boy)([^a-z]|$)/i.test(name) ||
    /#male|-male|_male|male_|\bmale\d*\b/i.test(name) ||
    /david|mark|george|daniel|james|richard|ravi|pradeep|mohan|amit|sfg#male|rjs#male|iob#male|cxx#male|cfc#male|hie#male|hid#male|smt-.*-m0\d/i.test(name);
  if (isMale) return 'male';

  return 'unverified';
}

class VoiceService {
  private recognition: any = null;
  private synth: SpeechSynthesis | null = null;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private state: VoiceState = {
    isListening: false,
    isSpeaking: false,
    transcript: '',
    error: null,
    supported: false,
    isNative: false,
    audioLevel: 0,
  };
  private listeners: VoiceStateCallback[] = [];
  private onResultCallback: ((text: string) => void) | null = null;
  private pendingNativeTtsDone: (() => void) | null = null;
  private nativeTtsSafetyTimer: any = null;
  private audioLevelInterval: any = null;

  constructor() {
    if (typeof window !== 'undefined') {
      const nativeBridge = (window as any).AndroidSuryaBridge;
      if (nativeBridge && typeof nativeBridge.startListening === 'function') {
        this.state.isNative = true;
        this.state.supported = true;

        window.addEventListener('onNativeSpeechReady', () => {
          this.state.isListening = true;
          this.state.error = null;
          this.startAudioSim();
          this.notify();
        });

        window.addEventListener('onNativeSpeechEnd', () => {
          this.state.isListening = false;
          this.stopAudioSim();
          this.notify();
        });

        window.addEventListener('onNativeSpeechResult', (e: any) => {
          const detail = e.detail || {};
          const text = detail.text || '';
          this.state.transcript = text;
          this.notify();

          if (detail.isFinal && this.onResultCallback && text.trim()) {
            this.state.isListening = false;
            this.stopAudioSim();
            this.notify();
            this.onResultCallback(text.trim());
          }
        });

        window.addEventListener('onNativeSpeechError', (e: any) => {
          const detail = e.detail || {};
          this.state.isListening = false;
          this.stopAudioSim();
          this.state.error = `Android Speech Error (code: ${detail.code || 'UNKNOWN'})`;
          this.notify();
        });

        window.addEventListener('onNativeTtsStart', () => {
          this.state.isSpeaking = true;
          this.startAudioSim();
          this.notify();
        });

        window.addEventListener('onNativeTtsDone', () => {
          clearTimeout(this.nativeTtsSafetyTimer);
          this.state.isSpeaking = false;
          this.stopAudioSim();
          this.notify();
          const cb = this.pendingNativeTtsDone;
          this.pendingNativeTtsDone = null;
          if (cb) cb();
        });
      } else {
        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        this.synth = typeof window !== 'undefined' && window.speechSynthesis ? window.speechSynthesis : null;

        if (SpeechRecognition) {
          this.recognition = new SpeechRecognition();
          this.recognition.continuous = false;
          this.recognition.interimResults = true;
          this.recognition.lang = voiceProfileManager.getSettings().language || 'en-IN';

          this.recognition.onstart = () => {
            this.state.isListening = true;
            this.state.error = null;
            this.startAudioSim();
            this.notify();
          };

          this.recognition.onresult = (event: any) => {
            let currentTranscript = '';
            let finalTranscript = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
              const seg = event.results[i][0].transcript;
              currentTranscript += seg;
              if (event.results[i].isFinal) {
                finalTranscript += seg;
              }
            }
            this.state.transcript = currentTranscript;
            this.notify();

            if (finalTranscript.trim() && this.onResultCallback) {
              this.state.isListening = false;
              this.stopAudioSim();
              this.notify();
              this.onResultCallback(finalTranscript.trim());
            }
          };

          this.recognition.onerror = (event: any) => {
            this.state.isListening = false;
            this.stopAudioSim();
            if (event.error !== 'no-speech' && event.error !== 'aborted') {
              this.state.error = `Microphone: ${event.error}`;
            }
            this.notify();
          };

          this.recognition.onend = () => {
            this.state.isListening = false;
            this.stopAudioSim();
            this.notify();
          };

          this.state.supported = true;
        }
      }
    }
  }

  private startAudioSim() {
    this.stopAudioSim();
    this.audioLevelInterval = setInterval(() => {
      this.state.audioLevel = 0.2 + Math.random() * 0.65;
      this.notify();
    }, 80);
  }

  private stopAudioSim() {
    if (this.audioLevelInterval) {
      clearInterval(this.audioLevelInterval);
      this.audioLevelInterval = null;
    }
    this.state.audioLevel = 0;
  }

  public subscribe(callback: VoiceStateCallback): () => void {
    this.listeners.push(callback);
    callback({ ...this.state });
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  private notify() {
    for (const listener of this.listeners) {
      listener({ ...this.state });
    }
  }

  public startListening(onResult: (text: string) => void) {
    this.stopSpeaking();
    this.onResultCallback = onResult;
    this.state.transcript = '';
    this.state.error = null;

    const currentLang = voiceProfileManager.getSettings().language || 'en-IN';
    const preferOffline = typeof navigator !== 'undefined' && !navigator.onLine;
    const nativeBridge = typeof window !== 'undefined' ? (window as any).AndroidSuryaBridge : null;

    if (nativeBridge && typeof nativeBridge.startListening === 'function') {
      try {
        if (nativeBridge.startListening.length >= 2) {
          nativeBridge.startListening(currentLang, preferOffline);
        } else {
          nativeBridge.startListening(currentLang);
        }
        this.state.isListening = true;
        this.startAudioSim();
        this.notify();
        return;
      } catch (err) {
        console.warn('Native speech error, falling back to web:', err);
      }
    }

    if (!this.recognition) {
      this.state.error = 'Speech Recognition not supported in this browser.';
      this.notify();
      return;
    }

    try {
      this.recognition.lang = currentLang;
      this.recognition.start();
    } catch {
      try {
        this.recognition.stop();
        setTimeout(() => this.recognition.start(), 180);
      } catch {
        this.state.error = 'Could not access microphone.';
        this.notify();
      }
    }
  }

  public stopListening() {
    const nativeBridge = typeof window !== 'undefined' ? (window as any).AndroidSuryaBridge : null;
    if (nativeBridge && typeof nativeBridge.stopListening === 'function') {
      try {
        nativeBridge.stopListening();
      } catch {}
    }

    if (this.recognition && this.state.isListening) {
      try {
        this.recognition.stop();
      } catch {}
    }
    this.stopAudioSim();
    this.state.isListening = false;
    this.notify();
  }

  /**
   * Enumerate all installed Android TTS and Web Speech voices.
   */
  public getAvailableVoices(): SystemVoice[] {
    if (typeof window === 'undefined') return [];

    const nativeBridge = (window as any).AndroidSuryaBridge;
    if (nativeBridge && typeof nativeBridge.getAvailableTtsVoices === 'function') {
      try {
        const rawJson = nativeBridge.getAvailableTtsVoices();
        const parsed: any[] = JSON.parse(rawJson);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((v) => {
            const gender = v.gender === 'male' || v.gender === 'female'
              ? v.gender
              : detectVoiceGender(v.name || v.id, v.features);
            return {
              id: v.id,
              name: v.name || v.id,
              lang: v.locale || v.language || 'en-US',
              voiceURI: v.id,
              localService: !v.isNetwork,
              gender,
              isNative: true,
              isVerifiedMale: gender === 'male',
              displayName: v.displayName || v.name || v.id,
              quality: v.quality,
              latency: v.latency,
            };
          });
        }
      } catch (e) {
        console.warn('[VoiceService] Failed to query native TTS voices:', e);
      }
    }

    if (this.synth) {
      try {
        const voices = this.synth.getVoices() || [];
        return voices.map((v) => {
          const gender = detectVoiceGender(v.name);
          return {
            id: v.voiceURI,
            name: v.name,
            lang: v.lang,
            voiceURI: v.voiceURI,
            localService: v.localService,
            gender,
            isNative: false,
            isVerifiedMale: gender === 'male',
            displayName: v.name,
          };
        });
      } catch {
        return [];
      }
    }

    return [];
  }

  /**
   * Unified voice resolution function.
   * Resolves the exact voice object and identifier for preview, assistant responses, and chat.
   * Checks voice availability, verified male status, and reports honest fallback status.
   */
  public resolveVoice(options?: {
    profileId?: VoiceProfileId;
    language?: string;
    voiceOverrideURI?: string;
  }): ResolvedVoiceResult {
    const settings = voiceProfileManager.getSettings();
    const targetProfileId = options?.profileId || settings.profileId;
    const profile = voiceProfileManager.getActiveProfile();
    const activeProfile = (options?.profileId && targetProfileId !== settings.profileId)
      ? (voiceProfileManager.getAllProfiles().find((p) => p.id === targetProfileId) || profile)
      : profile;

    const requestedLang = options?.language || settings.language || activeProfile.preferredLang || 'en-US';
    const langPrefix = requestedLang.slice(0, 2).toLowerCase();
    const availableVoices = this.getAvailableVoices();
    const nativeBridge = typeof window !== 'undefined' ? (window as any).AndroidSuryaBridge : null;
    const engine: 'android_native' | 'web_speech' | 'none' = nativeBridge ? 'android_native' : (this.synth ? 'web_speech' : 'none');

    // Case 1: Specific voice URI specified (either override for preview or user-applied URI)
    const targetURI = options?.voiceOverrideURI || settings.selectedVoiceURI;
    if (targetURI && availableVoices.length > 0) {
      const match = availableVoices.find((v) => v.voiceURI === targetURI || v.id === targetURI);
      if (match) {
        return {
          voice: match,
          voiceURI: match.voiceURI,
          gender: match.gender,
          isVerifiedMale: match.gender === 'male',
          isExactSelection: true,
          requiresVoiceInstall: activeProfile.gender === 'male' && match.gender !== 'male',
          warningMessage: activeProfile.gender === 'male' && match.gender !== 'male'
            ? `Selected voice "${match.name}" is not a verified male voice.`
            : null,
          appliedLanguage: match.lang || requestedLang,
          engine,
        };
      }
    }

    // Case 2: Male voice profile (JARVIS, STARK, ATLAS)
    if (activeProfile.gender === 'male') {
      // Find voices matching language prefix where gender is verified male
      const maleVoicesInLang = availableVoices.filter(
        (v) => v.gender === 'male' && v.lang.toLowerCase().startsWith(langPrefix)
      );

      if (maleVoicesInLang.length > 0) {
        // Specific profile tuning for best male timbre match
        let best = maleVoicesInLang[0];
        const pId = activeProfile.id;
        if (pId === 'jarvis-male') {
          // JARVIS prefers British English or sophisticated deep male voices
          best = maleVoicesInLang.find((v) => /rjs#male|george|daniel|gb|british/i.test(v.name)) || best;
        } else if (pId === 'stark-male') {
          // STARK prefers confident articulate US male voices
          best = maleVoicesInLang.find((v) => /iob#male|mark|richard|us/i.test(v.name)) || best;
        } else if (pId === 'atlas-male') {
          // ATLAS prefers deep steady male voices
          best = maleVoicesInLang.find((v) => /sfg#male|david|atlas/i.test(v.name)) || best;
        }

        return {
          voice: best,
          voiceURI: best.voiceURI,
          gender: 'male',
          isVerifiedMale: true,
          isExactSelection: false,
          requiresVoiceInstall: false,
          warningMessage: null,
          appliedLanguage: best.lang,
          engine,
        };
      }

      // If no male voice in exact locale, search across English if current lang is English
      if (langPrefix === 'en') {
        const anyEnglishMale = availableVoices.find((v) => v.gender === 'male' && v.lang.toLowerCase().startsWith('en'));
        if (anyEnglishMale) {
          return {
            voice: anyEnglishMale,
            voiceURI: anyEnglishMale.voiceURI,
            gender: 'male',
            isVerifiedMale: true,
            isExactSelection: false,
            requiresVoiceInstall: false,
            warningMessage: null,
            appliedLanguage: anyEnglishMale.lang,
            engine,
          };
        }
      }

      // HONEST FALLBACK: No suitable male voice installed for this language!
      // Pick best available voice for language without claiming it is male
      const defaultLangVoice = availableVoices.find((v) => v.lang.toLowerCase().startsWith(langPrefix)) || availableVoices[0] || null;
      return {
        voice: defaultLangVoice,
        voiceURI: defaultLangVoice?.voiceURI || null,
        gender: defaultLangVoice ? defaultLangVoice.gender : 'unverified',
        isVerifiedMale: false,
        isExactSelection: false,
        requiresVoiceInstall: true,
        warningMessage: `No male TTS voice installed for ${requestedLang}. System playback is using default voice. Install voice data in Android settings for true male speech.`,
        appliedLanguage: defaultLangVoice?.lang || requestedLang,
        engine,
      };
    }

    // Case 3: Female profile (Suryadev, Hindi Command, etc.)
    if (activeProfile.gender === 'female') {
      const femaleVoices = availableVoices.filter(
        (v) => v.gender === 'female' && v.lang.toLowerCase().startsWith(langPrefix)
      );
      const chosen = femaleVoices[0] || availableVoices.find((v) => v.lang.toLowerCase().startsWith(langPrefix)) || availableVoices[0] || null;
      return {
        voice: chosen,
        voiceURI: chosen?.voiceURI || null,
        gender: chosen ? chosen.gender : 'female',
        isVerifiedMale: false,
        isExactSelection: false,
        requiresVoiceInstall: false,
        warningMessage: null,
        appliedLanguage: chosen?.lang || requestedLang,
        engine,
      };
    }

    // Case 4: Neutral profile
    const neutralVoice = availableVoices.find((v) => v.lang.toLowerCase().startsWith(langPrefix)) || availableVoices[0] || null;
    return {
      voice: neutralVoice,
      voiceURI: neutralVoice?.voiceURI || null,
      gender: neutralVoice ? neutralVoice.gender : 'neutral',
      isVerifiedMale: neutralVoice?.gender === 'male',
      isExactSelection: false,
      requiresVoiceInstall: false,
      warningMessage: null,
      appliedLanguage: neutralVoice?.lang || requestedLang,
      engine,
    };
  }

  /**
   * Unified speech output function.
   * Respects resolved voice, voiceOverrideURI (for preview), pitch, rate, and language.
   */
  public speak(text: string, onEnd?: () => void, voiceOverrideURI?: string) {
    this.stopSpeaking();

    const cleanText = text
      .replace(/[*_#`[\]()]/g, ' ')
      .replace(/https?:\/\/\S+/g, 'link')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanText) {
      if (onEnd) onEnd();
      return;
    }

    const settings = voiceProfileManager.getSettings();
    const resolved = this.resolveVoice({ voiceOverrideURI });
    const nativeBridge = typeof window !== 'undefined' ? (window as any).AndroidSuryaBridge : null;

    if (nativeBridge && typeof nativeBridge.speakText === 'function') {
      try {
        this.pendingNativeTtsDone = onEnd || null;
        this.state.isSpeaking = true;
        this.startAudioSim();
        this.notify();

        if (typeof nativeBridge.speakTextWithConfig === 'function') {
          nativeBridge.speakTextWithConfig(
            cleanText,
            resolved.voiceURI || '',
            settings.pitch,
            settings.rate,
            resolved.appliedLanguage
          );
        } else {
          if (typeof nativeBridge.setVoiceLanguage === 'function') {
            nativeBridge.setVoiceLanguage(resolved.appliedLanguage);
          }
          if (resolved.voiceURI && typeof nativeBridge.setVoiceById === 'function') {
            nativeBridge.setVoiceById(resolved.voiceURI);
          }
          if (typeof nativeBridge.setPitchAndRate === 'function') {
            nativeBridge.setPitchAndRate(settings.pitch, settings.rate);
          }
          nativeBridge.speakText(cleanText);
        }

        const safetyMs = Math.min(24000, Math.max(3000, cleanText.split(' ').length * 420));
        clearTimeout(this.nativeTtsSafetyTimer);
        this.nativeTtsSafetyTimer = setTimeout(() => {
          if (this.state.isSpeaking) {
            this.state.isSpeaking = false;
            this.stopAudioSim();
            this.notify();
            const cb = this.pendingNativeTtsDone;
            this.pendingNativeTtsDone = null;
            if (cb) cb();
          }
        }, safetyMs);
        return;
      } catch (e) {
        console.warn('[VoiceService] Native TTS error, falling back to Web Speech:', e);
      }
    }

    if (!this.synth) {
      if (onEnd) onEnd();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;
    utterance.lang = resolved.appliedLanguage;

    if (this.synth) {
      const allWebVoices = this.synth.getVoices() || [];
      const matchVoice =
        (resolved.voiceURI ? allWebVoices.find((v) => v.voiceURI === resolved.voiceURI) : null) ||
        (resolved.appliedLanguage ? allWebVoices.find((v) => v.lang.toLowerCase().startsWith(resolved.appliedLanguage.toLowerCase().slice(0, 2))) : null) ||
        allWebVoices[0];
      if (matchVoice) {
        utterance.voice = matchVoice;
      }
    }

    utterance.onstart = () => {
      this.state.isSpeaking = true;
      this.startAudioSim();
      this.notify();
    };

    utterance.onend = () => {
      this.state.isSpeaking = false;
      this.stopAudioSim();
      this.currentUtterance = null;
      this.notify();
      if (onEnd) onEnd();
    };

    utterance.onerror = () => {
      this.state.isSpeaking = false;
      this.stopAudioSim();
      this.currentUtterance = null;
      this.notify();
      if (onEnd) onEnd();
    };

    this.currentUtterance = utterance;
    this.synth.speak(utterance);
  }

  public stopSpeaking() {
    clearTimeout(this.nativeTtsSafetyTimer);
    this.pendingNativeTtsDone = null;

    const nativeBridge = typeof window !== 'undefined' ? (window as any).AndroidSuryaBridge : null;
    if (nativeBridge && typeof nativeBridge.stopSpeaking === 'function') {
      try {
        nativeBridge.stopSpeaking();
      } catch {}
    }

    if (this.synth) {
      this.synth.cancel();
    }
    this.state.isSpeaking = false;
    this.stopAudioSim();
    this.currentUtterance = null;
    this.notify();
  }

  public interruptAndListen(onResult: (text: string) => void) {
    this.stopSpeaking();
    this.startListening(onResult);
  }

  public getState(): VoiceState {
    return { ...this.state };
  }

  public getOfflineVoiceReadiness(langCode?: string): {
    isNative: boolean;
    ttsReady: boolean;
    onDeviceSttSupported: boolean;
    localeSupportedOffline: boolean;
    note: string;
  } {
    const lang = langCode || voiceProfileManager.getSettings().language || 'en-IN';
    const bridge = typeof window !== 'undefined' ? (window as any).AndroidSuryaBridge : null;
    if (bridge && typeof bridge.checkOfflineVoiceReadiness === 'function') {
      try {
        const parsed = JSON.parse(bridge.checkOfflineVoiceReadiness(lang));
        return {
          isNative: true,
          ttsReady: Boolean(parsed.ttsReady),
          onDeviceSttSupported: Boolean(parsed.onDeviceSttSupported),
          localeSupportedOffline: Boolean(parsed.localeSupportedOffline),
          note: parsed.note || 'Android speech readiness checked.',
        };
      } catch {}
    }
    return {
      isNative: false,
      ttsReady: Boolean(this.synth),
      onDeviceSttSupported: false,
      localeSupportedOffline: Boolean(this.synth && this.synth.getVoices().some((v) => v.localService)),
      note: 'Offline Android voice packs can be managed natively inside the SURYA Android APK.',
    };
  }

  public openOfflineVoicePackInstaller(): boolean {
    const bridge = typeof window !== 'undefined' ? (window as any).AndroidSuryaBridge : null;
    if (bridge) {
      if (typeof bridge.openTtsSettings === 'function') {
        try {
          return Boolean(bridge.openTtsSettings());
        } catch {}
      }
      if (typeof bridge.openOfflineVoiceDataSettings === 'function') {
        try {
          return Boolean(bridge.openOfflineVoiceDataSettings());
        } catch {}
      }
    }
    return false;
  }
}

export const voiceService = new VoiceService();
