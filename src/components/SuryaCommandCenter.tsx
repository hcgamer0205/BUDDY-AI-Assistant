import React, { useState } from 'react';
import {
  CheckSquare,
  Eye,
  Code2,
  Settings,
  Send,
} from 'lucide-react';
import { soundFx } from '../services/soundFx';
import { ResponseMode, TabType } from '../types/surya';

interface SuryaCommandCenterProps {
  activeModel: string;
  responseMode: ResponseMode;
  onChangeResponseMode: (mode: ResponseMode) => void;
  onSendQuickCommand: (text: string) => void;
  onNavigateTab: (tab: TabType) => void;
  onOpenGeminiSettings?: () => void;
  onOpenBackendSettings?: () => void;
  onOpenVoiceModal: () => void;
  onOpenThemeModal: () => void;
  onOpenProductivityModal: (initialTab?: 'tasks' | 'notes' | 'focus' | 'vault' | 'automations') => void;
  onOpenAgentModal: () => void;
  onOpenModelModal: () => void;
}

export const SuryaCommandCenter: React.FC<SuryaCommandCenterProps> = ({
  onSendQuickCommand,
  onNavigateTab,
  onOpenProductivityModal,
}) => {
  const [quickPrompt, setQuickPrompt] = useState('');

  const handleQuickSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickPrompt.trim()) return;
    soundFx.playClick();
    onSendQuickCommand(quickPrompt.trim());
    setQuickPrompt('');
    onNavigateTab('chat');
  };

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  };

  const shortcuts = [
    {
      label: 'Tasks',
      icon: CheckSquare,
      accent: 'text-emerald-400',
      badge: 'Productivity',
      onClick: () => onOpenProductivityModal('tasks'),
    },
    {
      label: 'Vision',
      icon: Eye,
      accent: 'text-teal-400',
      badge: 'Optics HUD',
      onClick: () => onNavigateTab('optics'),
    },
    {
      label: 'Studio',
      icon: Code2,
      accent: 'text-cyan-400',
      badge: 'Creator',
      onClick: () => onNavigateTab('studio'),
    },
    {
      label: 'Settings',
      icon: Settings,
      accent: 'text-emerald-300',
      badge: 'System',
      onClick: () => onNavigateTab('system'),
    },
  ];

  return (
    <div className="w-full max-w-md mx-auto px-4 pt-3 pb-24 flex flex-col items-center space-y-5 select-none">
      {/* India Sovereign AI Badge & Greeting */}
      <div className="text-center space-y-2 w-full">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full buddy-india-badge text-[11px] font-semibold text-emerald-200 tracking-wider">
          <span className="text-sm">🇮🇳</span>
          <span>INDIA&apos;S SOVEREIGN AI • MADE IN INDIA</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-white flex items-center justify-center gap-2">
          <span className="buddy-gradient-title">{getGreeting()}</span>
        </h2>
        <p className="text-xs text-emerald-300/80 tracking-wide font-medium">
          BUDDY Intelligent Operating Environment &amp; Neural Voice Core
        </p>
      </div>

      {/* Emerald Glass Text Command Input */}
      <form onSubmit={handleQuickSubmit} className="w-full flex items-center gap-2.5">
        <input
          type="text"
          value={quickPrompt}
          onChange={(e) => setQuickPrompt(e.target.value)}
          placeholder="Message or command BUDDY..."
          aria-label="Command BUDDY"
          className="flex-1 min-h-[48px] bg-[#0b1522]/80 backdrop-blur-xl border border-emerald-500/25 focus:border-emerald-400/80 rounded-2xl px-4 text-sm text-slate-100 placeholder-slate-400 focus:outline-none transition-all shadow-inner"
        />
        <button
          type="submit"
          disabled={!quickPrompt.trim()}
          aria-label="Send message"
          className="min-h-[48px] min-w-[48px] rounded-2xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-semibold flex items-center justify-center transition-all duration-200 active:scale-95 shadow-[0_0_18px_rgba(16,185,129,0.35)] cursor-pointer"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>

      {/* 4 Compact Glass Feature Shortcuts */}
      <section aria-label="Quick Shortcuts" className="w-full grid grid-cols-4 gap-2.5 pt-1">
        {shortcuts.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                soundFx.playClick();
                item.onClick();
              }}
              className="min-h-[72px] p-2.5 rounded-2xl bg-[#0b1522]/70 hover:bg-[#0f1f32]/90 backdrop-blur-xl border border-emerald-500/20 hover:border-emerald-500/40 flex flex-col items-center justify-center gap-1.5 transition-all active:scale-95 shadow-md shadow-black/30 cursor-pointer group"
            >
              <div className="w-8 h-8 rounded-xl bg-emerald-500/10 flex items-center justify-center group-hover:scale-105 transition-transform">
                <Icon className={`w-4 h-4 ${item.accent}`} />
              </div>
              <span className="text-xs font-semibold text-slate-200 group-hover:text-emerald-200 transition-colors">
                {item.label}
              </span>
            </button>
          );
        })}
      </section>
    </div>
  );
};
