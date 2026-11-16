import React, { useState, useEffect } from 'react';
import { soundFx } from '../services/soundFx';
import { uiThemeEngine } from '../services/uiThemeEngine';
import { SuryaThemeConfig } from '../types/suryaTheme';

interface HolographicCoreProps {
  isListening: boolean;
  isSpeaking: boolean;
  isThinking?: boolean;
  statusText?: string;
  onCoreTap?: () => void;
  audioLevel?: number;
}

export const HolographicCore: React.FC<HolographicCoreProps> = ({
  isListening,
  isSpeaking,
  isThinking = false,
  statusText,
  onCoreTap,
  audioLevel = 0,
}) => {
  const [pulseActive, setPulseActive] = useState(false);
  const [theme, setTheme] = useState<SuryaThemeConfig>(uiThemeEngine.getCurrentTheme());

  useEffect(() => {
    const unsub = uiThemeEngine.subscribe((t) => setTheme(t));
    return () => unsub();
  }, []);

  const handleTap = () => {
    soundFx.playCorePulse();
    setPulseActive(true);
    setTimeout(() => setPulseActive(false), 360);
    onCoreTap?.();
  };

  const primaryCol = theme.palette.primary || '#10b981';
  const accentCol = theme.palette.accent || '#14b8a6';
  const reducedMotion = theme.accessibility.reducedMotion;

  const isActive = isListening || isSpeaking || isThinking;
  const reactiveScale = isSpeaking
    ? 1.04 + Math.min(0.12, audioLevel * 0.12)
    : isListening
    ? 1.05
    : isThinking
    ? 1.02
    : pulseActive
    ? 0.96
    : 1;

  const ringColor = isListening
    ? '#10b981'
    : isThinking
    ? '#06b6d4'
    : isSpeaking
    ? '#2dd4bf'
    : primaryCol;

  return (
    <div
      role="region"
      aria-label={statusText ? `BUDDY AI Orb — ${statusText}` : 'BUDDY AI Orb'}
      className="relative flex flex-col items-center justify-center py-4 select-none"
    >
      {/* Dynamic ambient halo with soft emerald/cyan gradient */}
      <div
        className={`absolute w-52 h-52 rounded-full pointer-events-none transition-all duration-700 blur-3xl ${
          reducedMotion ? '' : 'animate-orb-breathe'
        }`}
        style={{
          background: isListening
            ? 'radial-gradient(circle, rgba(16, 185, 129, 0.45) 0%, rgba(20, 184, 166, 0.25) 50%, transparent 75%)'
            : isThinking
            ? 'radial-gradient(circle, rgba(6, 182, 212, 0.4) 0%, rgba(16, 185, 129, 0.2) 50%, transparent 75%)'
            : isSpeaking
            ? 'radial-gradient(circle, rgba(45, 212, 191, 0.45) 0%, rgba(16, 185, 129, 0.3) 50%, transparent 75%)'
            : 'radial-gradient(circle, rgba(16, 185, 129, 0.28) 0%, rgba(20, 184, 166, 0.15) 55%, transparent 80%)',
          opacity: isActive ? 1 : 0.65,
        }}
      />

      {/* Outer Ripple Wave Echo Ring for Listening state */}
      {isListening && !reducedMotion && (
        <div
          className="absolute w-44 h-44 rounded-full border border-emerald-400/40 pointer-events-none animate-ping opacity-30"
          style={{ animationDuration: '2s' }}
        />
      )}

      {/* Main Interactive AI Orb Button */}
      <button
        type="button"
        onClick={handleTap}
        aria-label={
          isListening
            ? 'BUDDY is listening. Tap to stop.'
            : isSpeaking
            ? 'BUDDY is speaking. Tap to interrupt and listen.'
            : isThinking
            ? 'BUDDY is thinking...'
            : 'Tap to talk to BUDDY'
        }
        className="relative w-36 h-36 rounded-full flex items-center justify-center cursor-pointer transition-transform duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[#070d14]"
        style={{ transform: `scale(${reactiveScale})` }}
      >
        {/* Futuristic Gyro Optical Rings */}
        <svg
          className={`absolute inset-0 w-full h-full pointer-events-none ${
            reducedMotion
              ? ''
              : isThinking
              ? 'animate-orb-thinking'
              : isActive
              ? 'animate-spin-slow'
              : 'animate-spin-slow'
          }`}
          viewBox="0 0 144 144"
        >
          {/* Outer Dashed Orbit */}
          <circle
            cx="72"
            cy="72"
            r="66"
            fill="none"
            stroke={ringColor}
            strokeWidth="1.2"
            strokeDasharray="12 10"
            opacity={isActive ? 0.85 : 0.45}
          />
          {/* Middle Counter-Rotating Arc */}
          <circle
            cx="72"
            cy="72"
            r="56"
            fill="none"
            stroke={accentCol}
            strokeWidth="1"
            strokeDasharray="24 16 8 16"
            opacity={isActive ? 0.7 : 0.3}
          />
        </svg>

        {/* Counter-Spin Optical Ring for Multi-layer Depth */}
        {!reducedMotion && (
          <svg
            className={`absolute inset-0 w-full h-full pointer-events-none ${
              isThinking ? 'animate-spin-reverse-slow' : 'animate-spin-reverse-slow'
            }`}
            viewBox="0 0 144 144"
          >
            <circle
              cx="72"
              cy="72"
              r="48"
              fill="none"
              stroke="#06b6d4"
              strokeWidth="0.85"
              strokeDasharray="6 14"
              opacity={isActive ? 0.65 : 0.25}
            />
          </svg>
        )}

        {/* Emerald-Cyan Glass Core Disk */}
        <div
          className={`w-[86px] h-[86px] rounded-full border flex items-center justify-center backdrop-blur-xl transition-all duration-300 shadow-2xl ${
            reducedMotion
              ? ''
              : isListening
              ? 'animate-orb-listening'
              : isSpeaking
              ? 'animate-core-pulse'
              : isThinking
              ? 'animate-pulse'
              : 'animate-orb-breathe'
          }`}
          style={{
            background:
              'radial-gradient(circle, rgba(16, 185, 129, 0.4) 0%, rgba(20, 184, 166, 0.25) 45%, rgba(7, 13, 20, 0.85) 90%)',
            borderColor: `${ringColor}77`,
            boxShadow: isActive
              ? `0 0 35px ${ringColor}66, inset 0 0 20px rgba(16, 185, 129, 0.4)`
              : '0 8px 24px rgba(0, 0, 0, 0.5), inset 0 0 15px rgba(16, 185, 129, 0.2)',
          }}
        >
          {/* Inner Glowing Pupil */}
          <div
            className="w-10 h-10 rounded-full border flex items-center justify-center transition-all duration-300 shadow-inner"
            style={{
              borderColor: `${ringColor}88`,
              background: `radial-gradient(circle, ${ringColor}55 0%, rgba(16, 185, 129, 0.15) 70%, transparent 100%)`,
            }}
          >
            <div
              className="w-4 h-4 rounded-full transition-all duration-300 shadow-[0_0_12px_rgba(16,185,129,0.9)]"
              style={{
                backgroundColor: ringColor,
                transform: isActive ? 'scale(1.2)' : 'scale(1)',
              }}
            />
          </div>
        </div>
      </button>

      {/* Sub-Orb Status Legend */}
      {statusText && (
        <div className="mt-2.5 flex items-center gap-1.5 text-xs text-emerald-400/90 font-medium tracking-wide">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              isListening
                ? 'bg-emerald-400 animate-ping'
                : isSpeaking
                ? 'bg-teal-300 animate-pulse'
                : isThinking
                ? 'bg-cyan-400 animate-spin'
                : 'bg-emerald-500/70'
            }`}
          />
          <span className="uppercase text-[10px] tracking-wider font-semibold text-slate-300">
            {statusText}
          </span>
        </div>
      )}
    </div>
  );
};
