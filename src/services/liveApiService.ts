/**
 * BUDDY Real-Time Gemini Live API Client
 * Bridges microphone 16kHz PCM audio to server-side /api/live WebSocket (ai.live.connect)
 * and plays back 24kHz PCM responses seamlessly with interruption support.
 */

import { apiService, getApiBaseUrl } from './apiService';
import { intelligenceRouter } from './intelligenceRouter';

export interface LiveSessionState {
  connected: boolean;
  connecting: boolean;
  isSpeaking: boolean;
  error: string | null;
}

type LiveStateListener = (state: LiveSessionState) => void;

function pcmFloatTo16BitBase64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToPcmFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 0x8000;
  }
  return float32;
}

class LiveApiService {
  private ws: WebSocket | null = null;
  private inputCtx: AudioContext | null = null;
  private outputCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private nextPlayTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private listeners = new Set<LiveStateListener>();
  private abortedAttempt = false;
  private state: LiveSessionState = {
    connected: false,
    connecting: false,
    isSpeaking: false,
    error: null,
  };

  public getState(): LiveSessionState {
    return { ...this.state };
  }

  public subscribe(listener: LiveStateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  private setState(patch: Partial<LiveSessionState>) {
    this.state = { ...this.state, ...patch };
    const snap = this.getState();
    for (const cb of this.listeners) {
      try {
        cb(snap);
      } catch {}
    }
  }

  private getWebSocketUrl(ticket?: string): string {
    const base = getApiBaseUrl();
    const qs = ticket ? `?ticket=${encodeURIComponent(ticket)}` : '';
    if (base) {
      const wsBase = base.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://').replace(/\/+$/, '');
      return `${wsBase}/api/live${qs}`;
    }
    const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = typeof window !== 'undefined' ? window.location.host : 'localhost:3000';
    return `${protocol}//${host}/api/live${qs}`;
  }

  private clearOutputQueue() {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {}
    }
    this.activeSources = [];
    this.nextPlayTime = this.outputCtx ? this.outputCtx.currentTime : 0;
    this.setState({ isSpeaking: false });
  }

  private playAudioChunk(base64: string) {
    if (!this.outputCtx) return;
    const pcm = base64ToPcmFloat32(base64);
    const buffer = this.outputCtx.createBuffer(1, pcm.length, 24000);
    buffer.getChannelData(0).set(pcm);

    const source = this.outputCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outputCtx.destination);

    const now = this.outputCtx.currentTime;
    if (this.nextPlayTime < now) {
      this.nextPlayTime = now;
    }
    source.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;
    this.activeSources.push(source);
    this.setState({ isSpeaking: true });

    source.onended = () => {
      this.activeSources = this.activeSources.filter((s) => s !== source);
      if (this.activeSources.length === 0) {
        this.setState({ isSpeaking: false });
      }
    };
  }

  public async connect(): Promise<void> {
    if (this.state.connected || this.state.connecting) return;

    const routerStatus = intelligenceRouter.getEffectiveStatus();
    if (routerStatus.mode === 'offline' || !routerStatus.networkOnline) {
      this.setState({
        connected: false,
        connecting: false,
        error:
          routerStatus.mode === 'offline'
            ? 'Gemini Live Voice is unavailable in Offline Mode. Switch to Auto or Online mode to stream live voice.'
            : 'No internet connection detected. Gemini Live Voice requires an active backend connection.',
      });
      return;
    }

    this.abortedAttempt = false;
    this.setState({ connecting: true, error: null });

    try {
      const ticketRes = await apiService.createLiveSessionTicket();
      if (this.abortedAttempt) return;

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.inputCtx = new AudioCtx({ sampleRate: 16000 });
      this.outputCtx = new AudioCtx({ sampleRate: 24000 });
      await Promise.all([
        this.inputCtx.state === 'suspended' ? this.inputCtx.resume().catch(() => {}) : Promise.resolve(),
        this.outputCtx.state === 'suspended' ? this.outputCtx.resume().catch(() => {}) : Promise.resolve(),
      ]);
      this.nextPlayTime = this.outputCtx.currentTime;

      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.abortedAttempt) {
        this.disconnect();
        return;
      }
      const source = this.inputCtx.createMediaStreamSource(this.mediaStream);
      this.processor = this.inputCtx.createScriptProcessor(4096, 1, 1);

      const wsUrl = this.getWebSocketUrl(ticketRes?.ticket);
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        if (this.abortedAttempt) {
          ws.close();
          return;
        }
        this.setState({ connected: true, connecting: false, error: null });
        source.connect(this.processor!);
        this.processor!.connect(this.inputCtx!.destination);
      };

      this.processor.onaudioprocess = (e) => {
        if (ws.readyState === WebSocket.OPEN) {
          const base64 = pcmFloatTo16BitBase64(e.inputBuffer.getChannelData(0));
          ws.send(JSON.stringify({ audio: base64 }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.audio) {
            this.playAudioChunk(msg.audio);
          }
          if (msg.interrupted) {
            this.clearOutputQueue();
          }
          if (msg.error) {
            this.setState({ error: String(msg.error) });
          }
        } catch {}
      };

      ws.onerror = () => {
        this.setState({ error: 'Live voice WebSocket connection error.', connecting: false });
      };

      ws.onclose = () => {
        this.disconnect();
      };
    } catch (err: any) {
      this.setState({
        connected: false,
        connecting: false,
        error: err?.message || 'Unable to start Gemini Live voice session.',
      });
      this.disconnect();
    }
  }

  public disconnect() {
    this.abortedAttempt = true;
    this.clearOutputQueue();
    if (this.processor) {
      try {
        this.processor.disconnect();
      } catch {}
      this.processor = null;
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        try {
          track.stop();
        } catch {}
      }
      this.mediaStream = null;
    }
    if (this.inputCtx) {
      try {
        this.inputCtx.close();
      } catch {}
      this.inputCtx = null;
    }
    if (this.outputCtx) {
      try {
        this.outputCtx.close();
      } catch {}
      this.outputCtx = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.setState({ connected: false, connecting: false, isSpeaking: false });
  }
}

export const liveApiService = new LiveApiService();
