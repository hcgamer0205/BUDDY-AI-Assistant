import React, { useEffect, useState } from 'react';
import { Mic, Square, Radio, Sparkles } from 'lucide-react';
import { voiceService } from '../services/voiceService';
import { wakeWordService, WakeWordState } from '../services/wakeWordService';
import { liveApiService, LiveSessionState } from '../services/liveApiService';
import { intelligenceRouter } from '../services/intelligenceRouter';
import { soundFx } from '../services/soundFx';

interface VoiceVisualizerProps {
  onTranscriptCaptured: (text: string) => void;
}

export const VoiceVisualizer: React.FC<VoiceVisualizerProps> = ({ onTranscriptCaptured }) => {
  const [voiceState, setVoiceState] = useState(voiceService.getState());
  const [wakeState, setWakeState] = useState<WakeWordState>(wakeWordService.getState());
  const [liveState, setLiveState] = useState<LiveSessionState>(() => liveApiService.getState());
  const [routerStatus, setRouterStatus] = useState(() => intelligenceRouter.getEffectiveStatus());
  const [waveAmplitudes, setWaveAmplitudes] = useState<number[]>(new Array(12).fill(6));

  useEffect(() => {
    const unsubVoice = voiceService.subscribe(setVoiceState);
    const unsubWake = wakeWordService.subscribe(setWakeState);
    const unsubLive = liveApiService.subscribe(setLiveState);
    const unsubRouter = intelligenceRouter.subscribe(setRouterStatus);
    return () => {
      unsubVoice();
      unsubWake();
      unsubLive();
      unsubRouter();
    };
  }, []);

  useEffect(() => {
    let interval: any = null;
    if (voiceState.isListening || voiceState.isSpeaking || liveState.connected || liveState.isSpeaking) {
      interval = setInterval(() => {
        const factor = voiceState.isSpeaking || liveState.isSpeaking ? 24 : 18;
        setWaveAmplitudes(Array.from({ length: 12 }, () => 4 + Math.floor(Math.random() * factor)));
      }, 85);
    } else {
      setWaveAmplitudes(new Array(12).fill(4));
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [voiceState.isListening, voiceState.isSpeaking, liveState.connected, liveState.isSpeaking]);

  const handleToggleTalk = () => {
    soundFx.playClick();
    if (liveState.connected) {
      liveApiService.disconnect();
    }
    if (voiceState.isListening) {
      voiceService.stopListening();
    } else if (voiceState.isSpeaking) {
      voiceService.interruptAndListen((transcript) => {
        if (transcript) onTranscriptCaptured(transcript);
      });
    } else {
      voiceService.startListening((transcript) => {
        if (transcript) onTranscriptCaptured(transcript);
      });
    }
  };

  const handleToggleLiveVoice = async () => {
    soundFx.playClick();
    if (liveState.connected || liveState.connecting) {
      liveApiService.disconnect();
      return;
    }
    if (voiceState.isListening) {
      voiceService.stopListening();
    }
    if (voiceState.isSpeaking) {
      voiceService.stopSpeaking();
    }
    await liveApiService.connect();
  };

  const handleStopSpeaking = () => {
    soundFx.playClick();
    voiceService.stopSpeaking();
  };

  const isLiveBlockedOffline = routerStatus.mode === 'offline' || !routerStatus.networkOnline;

  return (
    <div className="w-full max-w-md mx-auto px-4 flex flex-col items-center gap-3 select-none">
      {/* Live interim transcript bubble in emerald glass */}
      {voiceState.transcript && (
        <div className="w-full px-4 py-2.5 rounded-2xl bg-[#0b1522]/80 backdrop-blur-xl border border-emerald-500/25 shadow-lg shadow-black/40 text-center animate-fadeIn">
          <p className="text-xs text-emerald-100 font-medium truncate">
            &ldquo;{voiceState.transcript}&rdquo;
          </p>
        </div>
      )}

      {(voiceState.error || liveState.error) && (
        <div className="w-full px-4 py-2 rounded-2xl bg-rose-950/60 backdrop-blur-md border border-rose-500/35 text-xs text-rose-200 text-center">
          {liveState.error || voiceState.error}
        </div>
      )}

      {/* Emerald & Teal Acoustic Waveform */}
      {(voiceState.isListening || voiceState.isSpeaking || liveState.connected || liveState.isSpeaking) && (
        <div className="flex items-center justify-center gap-1.5 h-9" aria-hidden="true">
          {waveAmplitudes.map((height, idx) => (
            <div
              key={idx}
              className={`w-1 rounded-full transition-all duration-100 ${
                voiceState.isSpeaking || liveState.isSpeaking
                  ? 'bg-gradient-to-t from-teal-400 to-emerald-300'
                  : 'bg-gradient-to-t from-emerald-500 to-cyan-400'
              }`}
              style={{ height: `${height}px` }}
            />
          ))}
        </div>
      )}

      {/* Prominent Translucent Circular & Pill Controls */}
      <div className="flex items-center justify-center gap-2.5 flex-wrap">
        <button
          type="button"
          onClick={handleToggleTalk}
          aria-label={voiceState.isListening ? 'Stop listening' : 'Talk to BUDDY'}
          className={`min-h-[50px] px-5 py-2.5 rounded-full text-sm font-semibold flex items-center gap-2.5 transition-all duration-200 active:scale-95 cursor-pointer backdrop-blur-xl ${
            voiceState.isListening
              ? 'bg-emerald-500 text-slate-950 shadow-[0_0_24px_rgba(16,185,129,0.55)] border border-emerald-300'
              : 'bg-emerald-950/40 hover:bg-emerald-900/50 text-emerald-200 border border-emerald-500/30 hover:border-emerald-400/50 shadow-[0_4px_20px_rgba(0,0,0,0.4)]'
          }`}
        >
          <div
            className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors ${
              voiceState.isListening ? 'bg-slate-950/20' : 'bg-emerald-500/20 text-emerald-300'
            }`}
          >
            <Mic className="w-4 h-4" />
          </div>
          <span className="tracking-wide">
            {voiceState.isListening ? 'Listening... Tap to stop' : 'Talk to BUDDY'}
          </span>
          {!voiceState.isListening && <Sparkles className="w-3.5 h-3.5 text-emerald-400/80" />}
        </button>

        {!isLiveBlockedOffline && (
          <button
            type="button"
            onClick={handleToggleLiveVoice}
            aria-label={liveState.connected ? 'End Live Voice session' : 'Start Gemini Live Voice'}
            className={`min-h-[50px] px-4 py-2.5 rounded-full text-xs font-semibold flex items-center gap-2 transition-all duration-200 active:scale-95 cursor-pointer backdrop-blur-xl border ${
              liveState.connected
                ? 'bg-teal-400 text-slate-950 border-teal-200 shadow-[0_0_20px_rgba(45,212,191,0.5)]'
                : 'bg-[#0b1522]/85 hover:bg-[#0f1f30] text-teal-200 border-teal-500/35 hover:border-teal-400/60'
            }`}
          >
            <Radio className={`w-3.5 h-3.5 ${liveState.connected || liveState.connecting ? 'animate-pulse' : ''}`} />
            <span>
              {liveState.connecting
                ? 'Connecting...'
                : liveState.connected
                ? 'Live Active'
                : 'Live Voice'}
            </span>
          </button>
        )}

        {voiceState.isSpeaking && (
          <button
            type="button"
            onClick={handleStopSpeaking}
            aria-label="Stop speaking"
            className="min-h-[50px] px-4 py-2.5 rounded-full bg-[#0b1522]/80 hover:bg-[#0f1f30] border border-slate-700/80 hover:border-teal-500/50 text-slate-200 text-sm font-medium flex items-center gap-2 backdrop-blur-xl transition-all active:scale-95 cursor-pointer"
          >
            <Square className="w-3.5 h-3.5 fill-current text-rose-400" />
            <span>Stop</span>
          </button>
        )}
      </div>

      {/* Visible hands-free mic indicator when enabled */}
      {wakeState.isActive && (
        <div className="flex items-center gap-1.5 text-xs text-emerald-300/90 font-medium">
          <Radio className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
          <span>Hands-free wake word active (&ldquo;Hey BUDDY&rdquo;)</span>
        </div>
      )}
    </div>
  );
};
