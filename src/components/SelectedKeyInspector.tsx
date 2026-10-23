import React from 'react';
import { LayerKey, KeyStatus } from '../types/driftpad';
import { Edit3, ArrowDown } from 'lucide-react';
import { HoverExplain } from './HoverExplain';

export interface SelectedKeyInspectorProps {
  keyIdx: number;
  layerKey: LayerKey;
  status: KeyStatus;
  workspaceName?: string;
  onOpenRemap: (keyIdx: number) => void;
  onSimulatePress: (keyIdx: number) => void;
}

function formatModifiers(mods?: LayerKey['modifiers']): string[] {
  if (!mods) return [];
  const res: string[] = [];
  if (mods.ctrl) res.push('Ctrl');
  if (mods.alt) res.push('Alt');
  if (mods.shift) res.push('Shift');
  if (mods.meta) res.push('Cmd');
  return res;
}

export const SelectedKeyInspectorComponent: React.FC<SelectedKeyInspectorProps> = ({
  keyIdx,
  layerKey,
  status,
  workspaceName = 'Active Workspace',
  onOpenRemap,
  onSimulatePress,
}) => {
  const mods = formatModifiers(layerKey.modifiers);

  return (
    <div className="bg-[#ffffff] border border-[#ded7ca] rounded-2xl p-3 sm:px-4 flex flex-wrap items-center justify-between gap-3 text-xs shadow-xs">
      {/* Left: Key Identity */}
      <div className="flex items-center gap-3">
        <div
          className={`w-11 h-11 rounded-xl flex flex-col items-center justify-center font-mono border transition-all ${
            status.pressed
              ? 'bg-[#c86443] text-white border-[#a84e31] font-bold shadow-xs'
              : 'bg-[#f6f3ec] text-[#1b2930] border-[#ded7ca] shadow-xs'
          }`}
        >
          <span className="text-xs font-black leading-none">{layerKey.label}</span>
          <span className="text-[9px] opacity-65 mt-0.5 tabular-nums">#{keyIdx}</span>
        </div>

        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="font-bold text-[#1b2930] text-xs">Key #{keyIdx}</span>
            <span className="text-[#71828a] text-[10px] hidden sm:inline truncate max-w-[120px]">
              · {workspaceName}
            </span>
            <span className="text-[#5a6a72] font-mono text-[11px] tabular-nums">
              HID {layerKey.code}
            </span>
            <HoverExplain
              title="HID Keycode"
              badge="Standard"
              explanation={`HID code ${layerKey.code} tells your OS which key is pressed.`}
            />
            {layerKey.customActuation && (
              <div className="flex items-center gap-1">
                <span className="text-[#b45309] font-mono text-[10px] bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20 font-semibold">
                  {layerKey.customActuation.toFixed(1)}mm Safety
                </span>
                <HoverExplain
                  title="Per-Key Safety Actuation"
                  badge="Safety"
                  explanation={`This key has a custom actuation depth of ${layerKey.customActuation.toFixed(1)}mm instead of global default.`}
                />
              </div>
            )}
          </div>

          <div className="text-[#5a6a72] text-[11px] truncate max-w-[280px]">
            {layerKey.description || 'Standard key assignment'}
          </div>

          {mods.length > 0 && (
            <div className="flex items-center gap-1 mt-0.5">
              {mods.map((m) => (
                <span
                  key={m}
                  className="text-[10px] font-mono font-bold text-[#153641] bg-[#5b8e85]/20 px-1.5 py-0.5 rounded"
                >
                  {m}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right: Live Analog Status & Actions */}
      <div className="flex items-center gap-2 ml-auto">
        <div className="hidden sm:flex flex-col items-end text-right mr-2">
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-[#71828a] uppercase tracking-wider font-bold">Travel Depth</span>
            <HoverExplain
              title="Hall-Effect Travel Depth"
              badge="Sensor"
              explanation="Continuous distance (0.00mm to 4.00mm) the key switch is currently pressed."
            />
          </div>
          <span
            className={`font-mono text-xs font-bold tabular-nums ${
              status.pressed ? 'text-[#c86443]' : 'text-[#1b2930]'
            }`}
          >
            {status.travel.toFixed(2)} mm {status.pressed ? '· Actuated' : ''}
          </span>
        </div>

        <button
          onClick={() => onSimulatePress(keyIdx)}
          className="px-3 py-1.5 bg-[#f7f4ee] hover:bg-[#ede7da] text-[#1b2930] rounded-xl text-xs font-semibold border border-[#ded7ca] flex items-center gap-1.5 transition-colors shadow-xs"
          title="Simulate pressing down this key"
        >
          <ArrowDown className="w-3.5 h-3.5 text-[#c86443]" />
          <span>Press</span>
        </button>

        <button
          onClick={() => onOpenRemap(keyIdx)}
          className="px-3.5 py-1.5 bg-[#153641] hover:bg-[#0f262e] text-white font-semibold rounded-xl text-xs flex items-center gap-1.5 transition-colors shadow-xs"
        >
          <Edit3 className="w-3.5 h-3.5 text-[#5b8e85]" />
          <span>Remap</span>
        </button>
      </div>
    </div>
  );
};

export const SelectedKeyInspector = React.memo(SelectedKeyInspectorComponent);
