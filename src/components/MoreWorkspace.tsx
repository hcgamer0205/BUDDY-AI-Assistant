import React, { useState, useEffect } from 'react';
import {
  CheckSquare,
  Code2,
  BookOpen,
  Zap,
  Cpu,
  Database,
  Navigation,
  Mic,
  Sliders,
  Settings,
  Atom,
  ChevronRight,
  Radio,
} from 'lucide-react';
import { TabType } from '../types/surya';
import { productivityService } from '../services/productivityService';
import { wakeWordService, WakeWordState } from '../services/wakeWordService';
import { uiThemeEngine } from '../services/uiThemeEngine';
import { intelligenceRouter } from '../services/intelligenceRouter';
import { modelDownloadManager } from '../services/modelDownloadManager';
import { soundFx } from '../services/soundFx';

interface MoreWorkspaceProps {
  onNavigateTab: (tab: TabType) => void;
  onOpenProductivity: (initialTab: 'tasks' | 'notes' | 'focus' | 'vault' | 'automations') => void;
  onOpenSystemSection: (subTab: 'health' | 'world' | 'science' | 'improve') => void;
  onOpenOfflineAI: () => void;
  onOpenAgents: () => void;
  onOpenVoiceModal: () => void;
  onOpenThemeModal: () => void;
}

export const MoreWorkspace: React.FC<MoreWorkspaceProps> = ({
  onNavigateTab,
  onOpenProductivity,
  onOpenSystemSection,
  onOpenOfflineAI,
  onOpenAgents,
  onOpenVoiceModal,
  onOpenThemeModal,
}) => {
  const [pendingTasks, setPendingTasks] = useState(
    () => productivityService.getTasks().filter((t) => t.status !== 'completed').length
  );
  const [wakeState, setWakeState] = useState<WakeWordState>(wakeWordService.getState());
  const [themeName, setThemeName] = useState(uiThemeEngine.getCurrentTheme().name);
  const [routerStatus, setRouterStatus] = useState(() => intelligenceRouter.getEffectiveStatus());
  const [downloadedCount, setDownloadedCount] = useState(
    () => modelDownloadManager.getDownloadedModels().length
  );

  useEffect(() => {
    const unsubWake = wakeWordService.subscribe(setWakeState);
    const unsubTheme = uiThemeEngine.subscribe((t) => setThemeName(t.name));
    const unsubRouter = intelligenceRouter.subscribe(setRouterStatus);
    const unsubDl = modelDownloadManager.subscribe(() => {
      setDownloadedCount(modelDownloadManager.getDownloadedModels().length);
    });
    setPendingTasks(productivityService.getTasks().filter((t) => t.status !== 'completed').length);
    return () => {
      unsubWake();
      unsubTheme();
      unsubRouter();
      unsubDl();
    };
  }, []);

  const ItemRow: React.FC<{
    icon: React.ReactNode;
    title: string;
    subtitle: string;
    badge?: string;
    onClick: () => void;
  }> = ({ icon, title, subtitle, badge, onClick }) => (
    <button
      type="button"
      onClick={() => {
        soundFx.playClick();
        onClick();
      }}
      className="w-full min-h-[58px] px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-emerald-950/20 transition-all border-b border-emerald-500/15 last:border-b-0 cursor-pointer"
    >
      <div className="flex items-center gap-3.5 min-w-0">
        <div className="w-9 h-9 rounded-xl bg-[#070d14] border border-emerald-500/25 flex items-center justify-center shrink-0 shadow-inner">
          {icon}
        </div>
        <div className="min-w-0">
          <span className="text-sm font-semibold text-slate-100 block truncate">{title}</span>
          <span className="text-xs text-slate-400 block truncate">{subtitle}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {badge && (
          <span className="text-xs font-semibold text-emerald-300 tabular-nums">{badge}</span>
        )}
        <ChevronRight className="w-4 h-4 text-emerald-500/60" />
      </div>
    </button>
  );

  return (
    <div className="w-full max-w-2xl mx-auto px-4 py-5 pb-24 space-y-6 select-none">
      <div>
        <h2 className="text-xl font-bold text-white tracking-wide">BUDDY Hub</h2>
        <p className="text-xs text-emerald-300/80 mt-0.5 font-medium">
          Workspace tools, personal intelligence, and system preferences
        </p>
      </div>

      {/* Productivity & Workspace */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-400 px-1">
          Workspace
        </h3>
        <div className="rounded-2xl bg-[#0b1522]/80 backdrop-blur-xl border border-emerald-500/20 shadow-xl overflow-hidden">
          <ItemRow
            icon={<CheckSquare className="w-4 h-4 text-emerald-400" />}
            title="Tasks & Agenda"
            subtitle="Today's tasks, reminders, and focus timer"
            badge={pendingTasks > 0 ? `${pendingTasks} open` : undefined}
            onClick={() => onOpenProductivity('tasks')}
          />
          <ItemRow
            icon={<Code2 className="w-4 h-4 text-teal-400" />}
            title="BUDDY Studio"
            subtitle="Create apps, edit code, and inspect builds"
            onClick={() => onNavigateTab('studio')}
          />
          <ItemRow
            icon={<BookOpen className="w-4 h-4 text-cyan-400" />}
            title="Knowledge Vault & Notes"
            subtitle="Personal notes and grounded document search"
            onClick={() => onOpenProductivity('vault')}
          />
          <ItemRow
            icon={<Zap className="w-4 h-4 text-emerald-300" />}
            title="Automations"
            subtitle="Scheduled routines and approval-gated triggers"
            onClick={() => onOpenProductivity('automations')}
          />
        </div>
      </section>

      {/* Intelligence & Device */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-400 px-1">
          Intelligence &amp; Device
        </h3>
        <div className="rounded-2xl bg-[#0b1522]/80 backdrop-blur-xl border border-emerald-500/20 shadow-xl overflow-hidden">
          <ItemRow
            icon={<Cpu className="w-4 h-4 text-emerald-400" />}
            title="Offline AI &amp; Models"
            subtitle={
              routerStatus.activeLocalModelName
                ? `Active: ${routerStatus.activeLocalModelName} (${routerStatus.mode})`
                : `Download on-device models (${downloadedCount} ready)`
            }
            badge={routerStatus.mode.toUpperCase()}
            onClick={onOpenOfflineAI}
          />
          <ItemRow
            icon={<Cpu className="w-4 h-4 text-teal-400" />}
            title="10-Agent Orchestrator"
            subtitle="Multi-step task planning and verification matrix"
            onClick={onOpenAgents}
          />
          <ItemRow
            icon={<Database className="w-4 h-4 text-cyan-400" />}
            title="Personal Memory"
            subtitle="Inspect, edit, or pause learned context"
            onClick={() => onOpenSystemSection('world')}
          />
          <ItemRow
            icon={<Navigation className="w-4 h-4 text-emerald-300" />}
            title="App Link Hub"
            subtitle="Launch Android apps and deep-link actions"
            onClick={() => onNavigateTab('hub')}
          />
          <ItemRow
            icon={<Atom className="w-4 h-4 text-slate-300" />}
            title="Scientific Archive"
            subtitle="Reference equations and AI deep dives"
            onClick={() => onOpenSystemSection('science')}
          />
        </div>
      </section>

      {/* Preferences & Settings */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-400 px-1">
          Preferences &amp; System
        </h3>
        <div className="rounded-2xl bg-[#0b1522]/80 backdrop-blur-xl border border-emerald-500/20 shadow-xl overflow-hidden">
          <div className="w-full px-4 py-3 flex items-center justify-between gap-3 border-b border-emerald-500/15">
            <button
              type="button"
              onClick={() => {
                soundFx.playClick();
                onOpenVoiceModal();
              }}
              className="flex items-center gap-3.5 min-w-0 flex-1 text-left cursor-pointer"
            >
              <div className="w-9 h-9 rounded-xl bg-[#070d14] border border-emerald-500/25 flex items-center justify-center shrink-0 shadow-inner">
                <Mic className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="min-w-0">
                <span className="text-sm font-semibold text-slate-100 block truncate">
                  Voice &amp; Hands-Free
                </span>
                <span className="text-xs text-slate-400 block truncate">
                  Voice profile, language, and wake word
                </span>
              </div>
            </button>
            <button
              type="button"
              onClick={() => {
                soundFx.playClick();
                wakeWordService.toggle();
              }}
              className={`min-h-[34px] px-3.5 py-1 rounded-xl text-xs font-semibold flex items-center gap-1.5 border transition-all shrink-0 cursor-pointer ${
                wakeState.isActive
                  ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.3)]'
                  : 'bg-[#070d14] border-emerald-500/25 text-slate-300 hover:border-emerald-400/50'
              }`}
            >
              <Radio className="w-3.5 h-3.5" />
              <span>{wakeState.isActive ? 'Wake On' : 'Wake Off'}</span>
            </button>
          </div>

          <ItemRow
            icon={<Sliders className="w-4 h-4 text-teal-400" />}
            title="Appearance"
            subtitle={themeName}
            onClick={onOpenThemeModal}
          />
          <ItemRow
            icon={<Settings className="w-4 h-4 text-emerald-300" />}
            title="System Settings"
            subtitle="Backend & Gemini, Permissions, Security, Device Info"
            onClick={() => onOpenSystemSection('health')}
          />
        </div>
      </section>
    </div>
  );
};
