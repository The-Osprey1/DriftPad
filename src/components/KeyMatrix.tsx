import React, { useState, useMemo } from 'react';
import { LayerKey, KeyStatus } from '../types/driftpad';
import {
  Flame,
  RotateCcw,
  ShieldAlert,
  Grid,
  Layers as LayersIcon,
} from 'lucide-react';
import { HoverExplain } from './HoverExplain';

interface KeyMatrixProps {
  keys: LayerKey[];
  allLayers?: LayerKey[][];
  activeLayerIdx: number;
  onSelectLayerIdx: (layerIdx: number) => void;
  keysStatus: KeyStatus[];
  selectedSimKey: number;
  workspaceName?: string;
  pressCounts: Record<number, number>;
  onOpenRemap: (keyIdx: number, layerIdx?: number) => void;
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
  allLayers,
  activeLayerIdx,
  onSelectLayerIdx,
  keysStatus,
  selectedSimKey,
  workspaceName = 'Standard Number Pad & Calc',
  pressCounts,
  onOpenRemap,
  onSelectSimKey,
  onResetHeatmap,
}) => {
  const [heatmapEnabled, setHeatmapEnabled] = useState<boolean>(false);
  const [multiLayerOverlay, setMultiLayerOverlay] = useState<boolean>(false);

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
      {/* Workspace Header & Heatmap/Layer Navigation Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#f0ebdF] pb-2.5">
        {/* Left: Active Workspace Badge, Layer Switches & Title */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[#f6f3ec] rounded-xl border border-[#ded7ca] text-xs">
            <Grid className="w-3.5 h-3.5 text-[#c86443]" />
            <span className="text-[#71828a] font-medium">Layout:</span>
            <span className="font-bold text-[#1b2930] truncate max-w-[150px] sm:max-w-none">
              {workspaceName}
            </span>
          </div>

          {/* Layer Switcher Pill */}
          <div className="flex items-center bg-[#f6f3ec] p-0.5 rounded-xl border border-[#ded7ca]">
            {[0, 1, 2].map((lIdx) => (
              <button
                key={lIdx}
                onClick={() => onSelectLayerIdx(lIdx)}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${
                  activeLayerIdx === lIdx
                    ? 'bg-[#153641] text-white shadow-xs'
                    : 'text-[#5a6a72] hover:text-[#1b2930]'
                }`}
                title={`Switch to Layer ${lIdx}`}
              >
                L{lIdx}
              </button>
            ))}
          </div>

          <HoverExplain
            title="4x4 Physical Key Matrix & Layers"
            badge="Hardware"
            explanation="16 linear Hall-effect key switches arranged in a standard 4x4 macropad grid. Toggle layers L0/L1/L2 or enable Multi-Layer view to see all layer assignments at once."
            tip="Double-click any key to remap its command on the active layer."
          />
        </div>

        {/* Right: Simultaneous Layer Overlay & Heatmap Toggles */}
        <div className="flex items-center gap-2">
          {allLayers && allLayers.length > 1 && (
            <button
              onClick={() => setMultiLayerOverlay((prev) => !prev)}
              className={`px-2.5 py-1.5 rounded-xl text-xs font-semibold border flex items-center gap-1.5 transition-colors ${
                multiLayerOverlay
                  ? 'bg-[#153641] text-white border-[#153641]'
                  : 'bg-[#f6f3ec] text-[#5a6a72] border-[#ded7ca] hover:text-[#1b2930]'
              }`}
              title="Show mappings across all layers on keycaps simultaneously"
            >
              <LayersIcon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">All Layers View</span>
            </button>
          )}

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

            const l0Key = allLayers?.[0]?.[i];
            const l1Key = allLayers?.[1]?.[i];
            const l2Key = allLayers?.[2]?.[i];

            return (
              <div
                key={i}
                onClick={() => onSelectSimKey(i)}
                onDoubleClick={() => onOpenRemap(i, activeLayerIdx)}
                className={`relative rounded-xl flex flex-col justify-between p-2.5 sm:p-3 select-none transition-all cursor-pointer h-24 sm:h-28 overflow-hidden shadow-xs ${
                  isSelected ? 'ring-2 ring-[#c86443] ring-offset-2' : ''
                } ${
                  heatmapEnabled
                    ? heat.bg
                    : isActuated
                    ? 'translate-y-1 bg-[#c86443] text-white border-b-2 border-r border-[#a84e31] shadow-inner'
                    : 'bg-[#ffffff] hover:bg-[#faf7f2] text-[#1b2930] border border-[#ded7ca] border-b-4 border-r-2 border-b-[#cfc5b3] border-r-[#ded7ca] hover:border-b-[#b8ad99]'
                }`}
              >
                {/* Dynamic Key Travel Fill Bar */}
                <div
                  className={`absolute bottom-0 left-0 right-0 pointer-events-none transition-all duration-75 ${
                    isActuated ? 'bg-white/20' : 'bg-[#5b8e85]/20'
                  }`}
                  style={{ height: `${travelRatio * 100}%` }}
                />

                {/* Top Row: Index, Active Layer Tag, Modifiers, Heatmap Count */}
                <div className="flex items-center justify-between text-[10px] z-10">
                  <div className="flex items-center gap-1">
                    <span
                      className={`font-mono font-bold ${
                        isActuated || (heatmapEnabled && heatRatio >= 0.15)
                          ? 'text-white/80'
                          : 'text-[#71828a]'
                      }`}
                    >
                      #{i}
                    </span>
                    <span
                      className={`text-[9px] font-mono px-1 rounded font-bold ${
                        isActuated
                          ? 'bg-black/20 text-white'
                          : 'bg-[#f6f3ec] text-[#153641] border border-[#ded7ca]'
                      }`}
                    >
                      L{activeLayerIdx}
                    </span>
                  </div>

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

                {/* Center: Key Primary Label or Simultaneous Multi-Layer Overlay */}
                {multiLayerOverlay && allLayers ? (
                  <div className="my-auto z-10 flex flex-col gap-0.5 text-[10px] font-mono w-full">
                    <div className="flex justify-between items-center bg-[#e0f2fe]/80 px-1 py-0.5 rounded text-[#0369a1] font-bold">
                      <span>L0:</span> <span className="truncate">{l0Key?.label || '-'}</span>
                    </div>
                    <div className="flex justify-between items-center bg-[#f3e8ff]/80 px-1 py-0.5 rounded text-[#6b21a8] font-bold">
                      <span>L1:</span> <span className="truncate">{l1Key?.label || '-'}</span>
                    </div>
                    <div className="flex justify-between items-center bg-[#fce7f3]/80 px-1 py-0.5 rounded text-[#be185d] font-bold">
                      <span>L2:</span> <span className="truncate">{l2Key?.label || '-'}</span>
                    </div>
                  </div>
                ) : (
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
                )}

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
