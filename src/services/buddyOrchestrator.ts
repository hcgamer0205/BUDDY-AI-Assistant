/**
 * BUDDY Unified Intelligence Orchestrator
 * Coordinates voice commands, local Android intents (0ms), UI navigation,
 * user-controlled Personal World Model directives, Knowledge Vault lookups,
 * stream cancellation (cloud AbortController + on-device cancelGeneration),
 * multi-turn previousInteractionId chaining, and permission-gated proactive hints.
 */

import { ChatMessage, ResponseMode, TabType } from '../types/surya';
import { deviceBridgeService } from './deviceBridgeService';
import { intelligenceRouter } from './intelligenceRouter';
import { knowledgeVaultService } from './knowledgeVaultService';
import { localInferenceRuntime } from './localInferenceRuntime';
import { personalMemoryService } from './personalMemoryService';
import { productivityService } from './productivityService';
import { voiceCommandParser } from './voiceCommandParser';

export interface OrchestrationCallbacks {
  onStreamChunk?: (partialText: string) => void;
  onNavigateTab?: (tab: TabType) => void;
  onStopSpeaking?: () => void;
  onSpeak?: (text: string) => void;
  activeTab: TabType;
  model: string;
  responseMode: ResponseMode;
  language: string;
  history: ChatMessage[];
}

export interface OrchestrationOutcome {
  responseText: string;
  model: string;
  latencyMs: number;
  ttftMs?: number;
  handledLocally: boolean;
  activePath?: string;
  interactionId?: string;
  actionSummary?: string;
  proactiveHint?: string;
}

class BuddyOrchestrator {
  private activeAbortController: AbortController | null = null;
  private lastInteractionId: string | undefined = undefined;
  private pendingConversationReset = false;

  public resetConversation(): void {
    this.cancelActiveGeneration();
    this.lastInteractionId = undefined;
    this.pendingConversationReset = true;
  }

  public cancelActiveGeneration(): void {
    if (this.activeAbortController) {
      try {
        this.activeAbortController.abort();
      } catch {}
      this.activeAbortController = null;
    }
    try {
      localInferenceRuntime.cancelGeneration();
    } catch {}
  }

  public isGenerating(): boolean {
    return Boolean(this.activeAbortController) || localInferenceRuntime.getState().status === 'generating';
  }

  private getProactiveHint(lowerInput: string): string | undefined {
    const tel = deviceBridgeService.getTelemetry();
    if (typeof tel.batteryLevel === 'number' && tel.batteryLevel > 0 && tel.batteryLevel <= 15 && !tel.isCharging) {
      return `Device battery is low (${tel.batteryLevel}%). Consider switching to Concise Mode or charging soon.`;
    }
    const status = intelligenceRouter.getEffectiveStatus();
    if (!status.networkOnline && !status.localReady && !lowerInput.includes('offline')) {
      return 'Offline tip: Download an offline AI model in System > Settings > Offline AI for full on-device chat without internet.';
    }
    return undefined;
  }

  public async handleInput(
    rawInput: string,
    callbacks: OrchestrationCallbacks
  ): Promise<OrchestrationOutcome> {
    const startTime = Date.now();
    const clean = rawInput.trim();
    const lower = clean.toLowerCase();

    if (!clean) {
      return {
        responseText: 'Please enter a message or voice command.',
        model: 'BUDDY Input Guard',
        latencyMs: 0,
        handledLocally: true,
        activePath: 'local-tools',
      };
    }

    // 1. Voice & Local Device Commands (0ms local path)
    const parsedVoice = voiceCommandParser.parse(clean);
    if (parsedVoice.handledLocally) {
      if (parsedVoice.category === 'voice_control' && !parsedVoice.spokenResponse) {
        callbacks.onStopSpeaking?.();
      } else if (parsedVoice.spokenResponse) {
        callbacks.onSpeak?.(parsedVoice.spokenResponse);
      }

      return {
        responseText: parsedVoice.spokenResponse || parsedVoice.actionSummary || 'Done.',
        model: parsedVoice.category === 'local_app' ? 'Local Intent Router (0ms)' : 'BUDDY Command Core',
        latencyMs: Date.now() - startTime,
        handledLocally: true,
        activePath: 'local-intent',
        actionSummary: parsedVoice.actionSummary,
      };
    }

    // 2. Navigation voice shortcuts ("open optics", "open studio", "open tasks", "go home")
    if (/^(open|show|go to)\s+(optics|vision|camera hud)/i.test(lower)) {
      callbacks.onNavigateTab?.('optics');
      const reply = 'Opening BUDDY Vision workspace.';
      callbacks.onSpeak?.(reply);
      return { responseText: reply, model: 'BUDDY Navigator', latencyMs: 5, handledLocally: true, activePath: 'local-intent' };
    }
    if (/^(open|show|go to)\s+(studio|app creator|code)/i.test(lower)) {
      callbacks.onNavigateTab?.('studio');
      const reply = 'Opening BUDDY Studio workspace.';
      callbacks.onSpeak?.(reply);
      return { responseText: reply, model: 'BUDDY Navigator', latencyMs: 5, handledLocally: true, activePath: 'local-intent' };
    }
    if (/^(open|show|go to)\s+(planner|tasks|productivity|agenda|automations)/i.test(lower)) {
      callbacks.onNavigateTab?.('productivity');
      const reply = 'Opening Tasks, Agenda, and Automations.';
      callbacks.onSpeak?.(reply);
      return { responseText: reply, model: 'BUDDY Navigator', latencyMs: 5, handledLocally: true, activePath: 'local-intent' };
    }

    // 3. Explicit User-Controlled Long-Term Memory Directives
    const rememberMatch = clean.match(/^(?:remember that|remember|याद रखो कि|याद रखो)\s+(.+)/i);
    if (rememberMatch && rememberMatch[1]) {
      const fact = rememberMatch[1].trim();
      if (personalMemoryService.isEnabled()) {
        const mem = personalMemoryService.addMemory('fact', `user_directive_${Date.now().toString().slice(-4)}`, fact, 'user');
        const reply = `Saved in your Personal World Model: "${mem.value}". You can inspect, edit, or delete it anytime.`;
        callbacks.onSpeak?.(reply);
        return {
          responseText: reply,
          model: 'Personal World Model',
          latencyMs: Date.now() - startTime,
          handledLocally: true,
          activePath: 'local-tools',
        };
      } else {
        const reply = 'Personal Memory is currently paused. Enable it in Memory settings if you want me to save facts.';
        callbacks.onSpeak?.(reply);
        return {
          responseText: reply,
          model: 'Personal World Model',
          latencyMs: Date.now() - startTime,
          handledLocally: true,
          activePath: 'local-tools',
        };
      }
    }

    const forgetMatch = clean.match(/^(?:forget|delete memory|भूल जाओ)\s+(.+)/i);
    if (forgetMatch && forgetMatch[1]) {
      const query = forgetMatch[1].trim();
      const matches = personalMemoryService.searchMemories(query);
      if (matches.length > 0) {
        matches.forEach((m) => personalMemoryService.deleteMemory(m.id));
        const reply = `Removed ${matches.length} matching item(s) from your Personal World Model.`;
        callbacks.onSpeak?.(reply);
        return {
          responseText: reply,
          model: 'Personal World Model',
          latencyMs: Date.now() - startTime,
          handledLocally: true,
          activePath: 'local-tools',
        };
      }
    }

    // 4. Quick Add Task ("add task ...", "remind me to ...")
    const addTaskMatch = clean.match(/^(?:add task|create task|remind me to)\s+(.+)/i);
    if (addTaskMatch && addTaskMatch[1]) {
      const title = addTaskMatch[1].trim();
      const task = productivityService.addTask(title, 'MEDIUM', 'Voice');
      const reply = `Added task "${task.title}" to your Tasks list.`;
      callbacks.onSpeak?.(reply);
      return {
        responseText: reply,
        model: 'Productivity Agent',
        latencyMs: Date.now() - startTime,
        handledLocally: true,
        activePath: 'local-tools',
      };
    }

    // 5. Unified Intelligence Router (Online Cloud Gemini / On-Device Local LLM / Local Tools)
    const userMemories = personalMemoryService.isEnabled()
      ? personalMemoryService.getAllMemories().slice(0, 8).map((m) => ({
          key: m.key,
          value: m.value,
          category: m.category,
        }))
      : [];

    const telemetry = deviceBridgeService.getTelemetry();
    const vaultHits = knowledgeVaultService.searchDocuments(clean).slice(0, 2);
    const enrichedMessage =
      vaultHits.length > 0 && lower.includes('vault')
        ? `${clean}\n\n[Relevant Knowledge Vault Excerpt: ${vaultHits.map((d) => `${d.title}: ${d.summary}`).join(' | ')}]`
        : clean;

    this.cancelActiveGeneration();
    const abortController = new AbortController();
    this.activeAbortController = abortController;

    const resetFlag = this.pendingConversationReset;
    this.pendingConversationReset = false;

    try {
      const routed = await intelligenceRouter.routeMessage(enrichedMessage, {
        history: callbacks.history,
        onStreamChunk: callbacks.onStreamChunk,
        model: callbacks.model,
        responseMode: callbacks.responseMode,
        language: callbacks.language,
        userMemories,
        previousInteractionId: resetFlag ? undefined : this.lastInteractionId,
        resetConversation: resetFlag,
        signal: abortController.signal,
        deviceContext: {
          batteryLevel: telemetry.batteryLevel,
          online: telemetry.online,
          networkType: telemetry.networkType,
          activeTab: callbacks.activeTab,
        },
      });

      if (routed.interactionId) {
        this.lastInteractionId = routed.interactionId;
      }

      if (routed.text) {
        callbacks.onSpeak?.(routed.text);
      }

      const proactiveHint = this.getProactiveHint(lower);

      return {
        responseText: routed.text,
        model: routed.modelLabel,
        latencyMs: routed.latencyMs || Date.now() - startTime,
        ttftMs: routed.ttftMs,
        handledLocally: routed.handledOffline,
        activePath: routed.source,
        interactionId: routed.interactionId,
        proactiveHint,
      };
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
    }
  }
}

export const buddyOrchestrator = new BuddyOrchestrator();
