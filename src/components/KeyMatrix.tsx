import React, { useState, useMemo } from 'react';
import { LayerKey, KeyStatus } from '../types/driftpad';
import {
  Flame,
  RotateCcw,
  ShieldAlert,
  Grid,
} from 'lucide-react';
import { HoverExplain } from './HoverExplain';

interface KeyMatrixProps {
  keys: LayerKey[];
  keysStatus: KeyStatus[];
  selectedSimKey: number;
  workspaceName?: string;
  pressCounts: Record<number, number>;
  onOpenRemap: (keyIdx: number) => void;
  onSelectSimKey: (keyIdx: number) => void;
  onResetHeatmap: () => void;
}

function formatModifiers(mods?: LayerKey['modifiers']): string {
  if (!mods) return '';
  const parts: string[] = [];
  if (mods.ctrl) parts.push('^');
  if (mods.alt) parts.push('⌥');
  if (mods.shift) parts.push('⇧');
  if (mods.meta) parts.push('⌘');
  return parts.join('');
}

function getHeatmapTier(ratio: number) {
  if (ratio >= 0.75) {
    return {
      bg: 'bg-[#c86443] border-[#a84e31] text-white shadow-inner',
      tag: 'bg-[#9b4226] text-white',
      badge: 'Peak',
    };
  }
  if (ratio >= 0.45) {
    return {
      bg: 'bg-[#d97d5a] border-[#b8613f] text-white shadow-inner',
      tag: 'bg-[#c86443] text-white',
      badge: 'High',
    };
  }
  if (ratio >= 0.15) {
    return {
      bg: 'bg-[#5b8e85] border-[#46726a] text-white shadow-inner',
      tag: 'bg-[#46726a] text-white',
      badge: 'Mid',
    };
  }
  return {
    bg: 'bg-[#ffffff] border-[#ded7ca] text-[#1b2930]',
    tag: 'bg-[#f6f3ec] text-[#5a6a72]',
    badge: 'Low',
  };
}

export const KeyMatrix: React.FC<KeyMatrixProps> = ({
  keys,
  keysStatus,
  selectedSimKey,
  workspaceName = 'Standard Number Pad & Calc',
  pressCounts,
  onOpenRemap,
  onSelectSimKey,
  onResetHeatmap,
}) => {
  const [heatmapEnabled, setHeatmapEnabled] = useState<boolean>(false);

  const { maxCount, totalPresses, topKeyIdx } = useMemo(() => {
    let max = 1;
    let sum = 0;
    let top = 0;

    for (let i = 0; i < 16; i++) {
      const c = pressCounts[i] || 0;
      sum += c;
      if (c > max) {
        max = c;
        top = i;
      }
    }
    return { maxCount: max, totalPresses: sum, topKeyIdx: top };
  }, [pressCounts]);

  const topKeyLabel = keys[topKeyIdx]?.label || `K${topKeyIdx}`;

  return (
    <div className="flex flex-col gap-3">
      {/* Workspace Header & Heatmap Navigation Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#f0ebdF] pb-2.5">
        {/* Left: Active Workspace Title & Hardware Info */}
        <div className="flex items-center gap-2 text-xs">
          <div className="flex items-center gap-1.5 text-[#1b2930] font-semibold">
            <Grid className="w-3.5 h-3.5 text-[#c86443]" />
            <span className="text-[#71828a] font-normal">Workspace:</span>
            <span className="font-bold truncate max-w-[200px] sm:max-w-none">
              {workspaceName}
            </span>
          </div>

          <span aria-hidden="true" className="text-[#ded7ca]">·</span>

          <HoverExplain
            title="4x4 Physical Key Matrix"
            badge="Hardware"
            explanation="16 linear Hall-effect key switches arranged in a standard 4x4 macropad grid. Double-click any key to remap its command or adjust per-key safety actuation."
            tip="Click any key to simulate its physical travel down to 4.0mm."
          />
        </div>

        {/* Right: Heatmap Toggle & Helper */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setHeatmapEnabled((prev) => !prev)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold border flex items-center gap-1.5 transition-colors ${
              heatmapEnabled
                ? 'bg-[#c86443]/15 text-[#c86443] border-[#c86443]/40'
                : 'bg-[#f6f3ec] text-[#5a6a72] border-[#ded7ca] hover:text-[#1b2930]'
            }`}
          >
            <Flame className={`w-3.5 h-3.5 ${heatmapEnabled ? 'text-[#c86443]' : 'text-[#71828a]'}`} />
            <span>Heatmap</span>
          </button>

          <HoverExplain
            title="Activity Heatmap"
            badge="Telemetry"
            explanation="Visualizes keystroke frequency across your 16 keys. Terracotta represents peak hotkeys, and sea-glass represents moderate use."
          />
        </div>
      </div>

      {/* Heatmap Summary Strip */}
      {heatmapEnabled && (
        <div className="flex items-center justify-between px-3.5 py-2 bg-[#faf7f2] rounded-xl border border-[#c86443]/30 text-xs text-[#1b2930] animate-in fade-in">
          <div className="flex items-center gap-2 truncate">
            <span className="font-bold text-[#c86443]">Usage Heatmap</span>
            <span aria-hidden="true" className="text-[#ded7ca]">·</span>
            <span className="text-[#5a6a72]">
              Total Presses: <strong className="text-[#1b2930] font-mono">{totalPresses}</strong>
            </span>
            <span aria-hidden="true" className="text-[#ded7ca]">·</span>
            <span className="text-[#5a6a72]">
              Top Key: <strong className="text-[#c86443] font-mono">{topKeyLabel}</strong> ({maxCount})
            </span>
          </div>
          <button
            onClick={onResetHeatmap}
            className="flex items-center gap-1 text-[11px] text-[#71828a] hover:text-[#c86443] transition-colors p-1"
            title="Reset Heatmap counters for this workspace"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Reset</span>
          </button>
        </div>
      )}

      {/* Recessed Switch Plate: 4x4 Tactile Key Matrix */}
      <div className="bg-[#ece6db] p-3 sm:p-3.5 rounded-2xl border border-[#d8d0c2] shadow-inner">
        <div className="grid grid-cols-4 gap-2.5 sm:gap-3">
          {keys.map((k, i) => {
            const status = keysStatus[i] || {
              idx: i,
              pressed: false,
              travel: 0.0,
              label: k.label,
            };
            const isActuated = status.pressed;
            const isSelected = selectedSimKey === i;
            const travelRatio = Math.min(1, Math.max(0, status.travel / 4.0));
            const mods = formatModifiers(k.modifiers);

            const pressCount = pressCounts[i] || 0;
            const heatRatio = maxCount > 0 ? pressCount / maxCount : 0;
            const heat = getHeatmapTier(heatRatio);

            return (
              <div
                key={i}
                onClick={() => onSelectSimKey(i)}
                onDoubleClick={() => onOpenRemap(i)}
                className={`relative rounded-xl flex flex-col justify-between p-2.5 sm:p-3 select-none transition-all cursor-pointer h-24 sm:h-28 overflow-hidden ${
                  isSelected ? 'ring-2 ring-[#c86443] ring-offset-2' : ''
                } ${
                  heatmapEnabled
                    ? heat.bg
                    : isActuated
                    ? 'translate-y-1 bg-[#c86443] text-white border-b-2 border-r border-[#a84e31] shadow-inner'
                    : 'bg-gradient-to-b from-[#ffffff] via-[#faf8f5] to-[#f1ebe0] text-[#1b2930] border border-[#ded7ca] border-b-[4px] border-r-[2px] border-b-[#cfc5b3] border-r-[#ded7ca] hover:border-b-[#b8ad99] shadow-xs active:translate-y-1 active:border-b-2'
                }`}
              >
                {/* Subtle Mechanical Switch Cross-Stem Behind Legend */}
                <div
                  aria-hidden="true"
                  className={`absolute inset-0 flex items-center justify-center pointer-events-none transition-opacity ${
                    isActuated ? 'opacity-10 text-white' : 'opacity-[0.06] text-[#153641]'
                  }`}
                >
                  <div className="w-6 h-6 border border-current rounded-xs flex items-center justify-center">
                    <span className="font-mono text-base font-black">+</span>
                  </div>
                </div>

                {/* Tactile Homing Pip on Key #6 (Numpad 5) */}
                {i === 6 && (
                  <div
                    aria-hidden="true"
                    className={`absolute bottom-6 left-1/2 -translate-x-1/2 w-2 h-0.5 rounded-full pointer-events-none ${
                      isActuated ? 'bg-white/40' : 'bg-[#ded7ca]'
                    }`}
                  />
                )}

                {/* Dynamic Key Travel Fill Bar */}
                <div
                  className={`absolute bottom-0 left-0 right-0 pointer-events-none transition-all duration-75 ${
                    isActuated ? 'bg-white/25' : 'bg-[#5b8e85]/20'
                  }`}
                  style={{ height: `${travelRatio * 100}%` }}
                />

                {/* Top Row: Index, Modifiers, Heatmap Count */}
                <div className="flex items-center justify-between text-[10px] z-10">
                  <span
                    className={`font-mono font-bold ${
                      isActuated || (heatmapEnabled && heatRatio >= 0.15)
                        ? 'text-white/80'
                        : 'text-[#71828a]'
                    }`}
                  >
                    #{i}
                  </span>

                  <div className="flex items-center gap-1">
                    {mods && (
                      <span
                        className={`font-mono font-bold px-1 rounded ${
                          isActuated || (heatmapEnabled && heatRatio >= 0.15)
                            ? 'bg-black/20 text-white'
                            : 'bg-[#5b8e85]/20 text-[#153641]'
                        }`}
                      >
                        {mods}
                      </span>
                    )}
                    {k.customActuation && (
                      <span title={`Safety actuation: ${k.customActuation.toFixed(1)}mm`}>
                        <ShieldAlert
                          className={`w-3 h-3 ${
                            isActuated ? 'text-amber-200' : 'text-[#b45309]'
                          }`}
                        />
                      </span>
                    )}
                    {heatmapEnabled && pressCount > 0 && (
                      <span
                        className={`text-[9px] font-mono px-1 py-0.2 rounded font-bold ${heat.tag}`}
                      >
                        {pressCount}
                      </span>
                    )}
                  </div>
                </div>

                {/* Center: Key Primary Label */}
                <div className="my-auto text-center z-10 flex flex-col items-center justify-center">
                  <span
                    className={`font-black tracking-tight leading-none text-base sm:text-xl font-mono ${
                      isActuated || (heatmapEnabled && heatRatio >= 0.15)
                        ? 'text-white'
                        : 'text-[#1b2930]'
                    }`}
                  >
                    {k.label}
                  </span>
                  {k.description && (
                    <span
                      className={`text-[9px] truncate max-w-full mt-1 font-medium ${
                        isActuated || (heatmapEnabled && heatRatio >= 0.15)
                          ? 'text-white/80'
                          : 'text-[#5a6a72]'
                      }`}
                    >
                      {k.description}
                    </span>
                  )}
                </div>

                {/* Bottom Row: Live Analog Sensor Travel */}
                <div className="flex items-center justify-between text-[10px] font-mono z-10 pt-1 border-t border-black/5">
                  <span
                    className={`tabular-nums font-semibold ${
                      isActuated || (heatmapEnabled && heatRatio >= 0.15)
                        ? 'text-white/90'
                        : 'text-[#5a6a72]'
                    }`}
                  >
                    {status.travel.toFixed(2)}mm
                  </span>
                  <span
                    className={`text-[9px] uppercase font-bold tracking-wider ${
                      isActuated
                        ? 'text-white font-extrabold'
                        : 'text-[#71828a]'
                    }`}
                  >
                    {isActuated ? 'ACTUATED' : 'REST'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
