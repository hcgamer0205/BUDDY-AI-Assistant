import React, { useState, useEffect } from 'react';
import { Home, MessageSquare, Eye, LayoutGrid } from 'lucide-react';
import { TabType } from '../types/surya';
import { soundFx } from '../services/soundFx';
import { uiThemeEngine } from '../services/uiThemeEngine';
import { SuryaThemeConfig } from '../types/suryaTheme';

interface NavigationProps {
  currentTab: TabType;
  onSelectTab: (tab: TabType) => void;
}

const MORE_CHILD_TABS: TabType[] = [
  'more',
  'productivity',
  'studio',
  'system',
  'hub',
  'plugins',
  'security',
];

export const Navigation: React.FC<NavigationProps> = ({ currentTab, onSelectTab }) => {
  const [theme, setTheme] = useState<SuryaThemeConfig>(uiThemeEngine.getCurrentTheme());

  useEffect(() => {
    const unsub = uiThemeEngine.subscribe((t) => setTheme(t));
    return () => unsub();
  }, []);

  const primaryCol = theme.palette.primary || '#10b981';

  const tabs: { id: TabType; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'core', label: 'Home', icon: Home },
    { id: 'chat', label: 'Chat', icon: MessageSquare },
    { id: 'optics', label: 'Vision', icon: Eye },
    { id: 'more', label: 'More', icon: LayoutGrid },
  ];

  return (
    <nav
      aria-label="Primary Navigation"
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-emerald-500/20 bg-[#070d14]/85 backdrop-blur-2xl shadow-[0_-10px_35px_rgba(0,0,0,0.6)] pb-safe select-none"
    >
      <div className="max-w-lg mx-auto grid grid-cols-4 items-center h-15 px-3">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive =
            tab.id === 'more'
              ? MORE_CHILD_TABS.includes(currentTab)
              : currentTab === tab.id;

          return (
            <button
              key={tab.id}
              onClick={() => {
                soundFx.playClick();
                onSelectTab(tab.id);
              }}
              aria-current={isActive ? 'page' : undefined}
              className={`relative flex flex-col items-center justify-center min-h-[48px] py-1.5 rounded-2xl transition-all duration-200 active:scale-95 cursor-pointer ${
                isActive
                  ? 'font-semibold'
                  : 'text-slate-400 hover:text-emerald-300'
              }`}
              style={{ color: isActive ? primaryCol : undefined }}
            >
              <div
                className={`relative flex items-center justify-center w-8 h-8 rounded-xl transition-all ${
                  isActive
                    ? 'bg-emerald-500/15 shadow-[0_0_15px_rgba(16,185,129,0.3)]'
                    : ''
                }`}
              >
                <Icon className="w-[19px] h-[19px]" />
              </div>
              <span className="text-[11px] mt-0.5 tracking-tight leading-none">
                {tab.label}
              </span>
              {isActive && (
                <span
                  className="absolute bottom-1 w-1.5 h-1.5 rounded-full shadow-[0_0_8px_rgba(16,185,129,0.8)]"
                  style={{ backgroundColor: primaryCol }}
                />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
};
