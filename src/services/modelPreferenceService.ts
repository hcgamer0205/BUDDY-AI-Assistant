/**
 * BUDDY Server-Side Gemini Model Preference Store
 * Tracks the active Gemini model selected by the user and syncs available models from /api/models.
 */

import { apiService } from './apiService';

export interface ServerGeminiModel {
  id: string;
  name: string;
  description: string;
  speed: 'Ultra-Fast' | 'Fast' | 'Deep Reasoning';
  latencyRating: number;
  isDefault?: boolean;
  isFallback?: boolean;
  isPaid?: boolean;
}

const STORAGE_KEY_SELECTED_MODEL = 'buddy_selected_gemini_model_v1';
export const DEFAULT_SERVER_MODEL = 'gemini-4-hydrogen';

export const DEFAULT_SERVER_MODELS: ServerGeminiModel[] = [
  {
    id: 'gemini-4-hydrogen',
    name: 'Gemini 4 Hydrogen',
    description: 'Primary intelligent multimodal model with balanced reasoning, speed, and multilingual precision',
    speed: 'Fast',
    latencyRating: 5,
    isDefault: true,
  },
  {
    id: 'gemini-4-carbon',
    name: 'Gemini 4 Carbon',
    description: 'Balanced high-speed multimodal model tuned for real-time mobile assistant interactions',
    speed: 'Ultra-Fast',
    latencyRating: 5,
  },
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    description: 'Lightweight high-throughput model, lowest latency, primary overload fallback',
    speed: 'Ultra-Fast',
    latencyRating: 5,
    isFallback: true,
  },
  {
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    description: 'Complex multi-step reasoning, mathematical STEM, deep coding & architecture',
    speed: 'Deep Reasoning',
    latencyRating: 3,
    isPaid: true,
  },
];

function readInitialModel(): string {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY_SELECTED_MODEL);
      if (saved && saved.trim() && !/gemini-1\.|gemini-2\.0|gemini-pro$/i.test(saved)) {
        return saved.trim();
      }
    } catch {}
  }
  return DEFAULT_SERVER_MODEL;
}

class ModelPreferenceService {
  private selectedModel: string = readInitialModel();
  private models: ServerGeminiModel[] = [...DEFAULT_SERVER_MODELS];
  private listeners = new Set<(state: { selectedModel: string; models: ServerGeminiModel[] }) => void>();

  public getSelectedModel(): string {
    return this.selectedModel;
  }

  public getModels(): ServerGeminiModel[] {
    return [...this.models];
  }

  public setSelectedModel(modelId: string): string {
    const cleaned = (modelId || '').trim() || DEFAULT_SERVER_MODEL;
    this.selectedModel = cleaned;
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(STORAGE_KEY_SELECTED_MODEL, cleaned);
      } catch {}
    }
    this.notify();
    return cleaned;
  }

  public async refreshFromServer(): Promise<ServerGeminiModel[]> {
    try {
      const res = await apiService.getAvailableModels();
      if (Array.isArray(res?.models) && res.models.length > 0) {
        this.models = res.models;
        this.notify();
      }
    } catch {
      // Retain default server models when offline
    }
    return this.getModels();
  }

  public subscribe(listener: (state: { selectedModel: string; models: ServerGeminiModel[] }) => void): () => void {
    this.listeners.add(listener);
    listener({ selectedModel: this.selectedModel, models: this.getModels() });
    return () => this.listeners.delete(listener);
  }

  private notify() {
    const snap = { selectedModel: this.selectedModel, models: this.getModels() };
    for (const cb of this.listeners) {
      try {
        cb(snap);
      } catch {}
    }
  }
}

export const modelPreferenceService = new ModelPreferenceService();
