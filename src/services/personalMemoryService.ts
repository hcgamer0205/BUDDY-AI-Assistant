/**
 * SURYA Personal Long-Term Memory Service
 * Transparent, user-controlled memory system storing user-approved preferences,
 * ongoing projects, facts, and directives. Supports search, edit, delete, and export.
 */

import { WorldModelMemory } from '../types/surya';

const MEMORY_STORAGE_KEY = 'surya_personal_memory_v2';
const MEMORY_ENABLED_KEY = 'surya_personal_memory_enabled_v1';

class PersonalMemoryService {
  private memories: WorldModelMemory[] = [];
  private isMemoryEnabled = true;

  constructor() {
    this.loadFromStorage();
  }

  private loadFromStorage() {
    if (typeof window === 'undefined') return;
    try {
      const enabledRaw = localStorage.getItem(MEMORY_ENABLED_KEY);
      if (enabledRaw === 'false') {
        this.isMemoryEnabled = false;
      }

      const saved = localStorage.getItem(MEMORY_STORAGE_KEY);
      if (saved !== null) {
        const parsed = JSON.parse(saved);
        this.memories = Array.isArray(parsed) ? parsed : [];
      } else {
        // Default seed memories for BUDDY
        this.memories = [
          {
            id: 'mem_1',
            category: 'preference',
            key: 'voice_identity',
            value: 'JARVIS — Sophisticated Assistant Command',
            confidence: 1.0,
            source: 'system',
            updatedAt: new Date().toISOString(),
          },
          {
            id: 'mem_2',
            category: 'preference',
            key: 'primary_language',
            value: 'Multilingual (English & Hindi)',
            confidence: 0.95,
            source: 'system',
            updatedAt: new Date().toISOString(),
          },
          {
            id: 'mem_3',
            category: 'context',
            key: 'active_platform',
            value: 'BUDDY Android Mobile Assistant (SDK 36)',
            confidence: 1.0,
            source: 'system',
            updatedAt: new Date().toISOString(),
          },
          {
            id: 'mem_4',
            category: 'directive',
            key: 'privacy_policy',
            value: 'Zero silent recordings. Require explicit user authorization for high-risk operations.',
            confidence: 1.0,
            source: 'system',
            updatedAt: new Date().toISOString(),
          },
        ];
        this.saveToStorage();
      }
    } catch (e) {
      console.warn('[PersonalMemoryService] Error loading memory:', e);
    }
  }

  private saveToStorage() {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(this.memories));
    } catch (e) {}
  }

  public getAllMemories(): WorldModelMemory[] {
    return [...this.memories];
  }

  public searchMemories(query: string): WorldModelMemory[] {
    if (!query) return this.getAllMemories();
    const q = query.toLowerCase();
    return this.memories.filter(
      (m) =>
        m.key.toLowerCase().includes(q) ||
        m.value.toLowerCase().includes(q) ||
        m.category.toLowerCase().includes(q)
    );
  }

  public addMemory(
    category: WorldModelMemory['category'],
    key: string,
    value: string,
    source: WorldModelMemory['source'] = 'user',
    confidence = 0.95
  ): WorldModelMemory {
    if (!this.isMemoryEnabled) {
      throw new Error('Personal memory is currently paused by user.');
    }

    const existingIndex = this.memories.findIndex((m) => m.key.toLowerCase() === key.toLowerCase());
    const newEntry: WorldModelMemory = {
      id: existingIndex >= 0 ? this.memories[existingIndex].id : `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      category,
      key,
      value,
      confidence,
      source,
      updatedAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      this.memories[existingIndex] = newEntry;
    } else {
      this.memories.push(newEntry);
    }

    this.saveToStorage();
    return newEntry;
  }

  public updateMemory(id: string, updates: Partial<Omit<WorldModelMemory, 'id'>>): boolean {
    const idx = this.memories.findIndex((m) => m.id === id);
    if (idx < 0) return false;
    this.memories[idx] = {
      ...this.memories[idx],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.saveToStorage();
    return true;
  }

  public replaceAll(records: WorldModelMemory[]): void {
    this.memories = Array.isArray(records) ? records.map((r) => ({ ...r })) : [];
    this.saveToStorage();
  }

  public deleteMemory(id: string): boolean {
    const prevLen = this.memories.length;
    this.memories = this.memories.filter((m) => m.id !== id);
    if (this.memories.length !== prevLen) {
      this.saveToStorage();
      return true;
    }
    return false;
  }

  public clearAll(): void {
    this.memories = [];
    this.saveToStorage();
  }

  public exportJson(): string {
    return JSON.stringify(this.memories, null, 2);
  }

  public isEnabled(): boolean {
    return this.isMemoryEnabled;
  }

  public setEnabled(enabled: boolean): void {
    this.isMemoryEnabled = enabled;
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        localStorage.setItem(MEMORY_ENABLED_KEY, String(enabled));
      } catch {}
    }
  }
}

export const personalMemoryService = new PersonalMemoryService();

