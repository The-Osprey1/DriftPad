import React from 'react';
import { LayerKey, KeyStatus } from '../types/driftpad';
import { Layers, Keyboard as KeyboardIcon, Edit3 } from 'lucide-react';

interface KeyMatrixProps {
  activeLayer: number;
  layers: LayerKey[][];
  keysStatus: KeyStatus[];
  selectedSimKey: number;
  onSelectLayer: (layer: number) => void;
  onOpenRemap: (keyIdx: number) => void;
  onSelectSimKey: (keyIdx: number) => void;
}

const LAYER_NAMES = [
  { id: 0, title: 'L0: Numpad', desc: 'Standard 10-key calculator & macro pad' },
  { id: 1, title: 'L1: Navigation', desc: 'Cursor arrows, Home/End, PgUp/PgDn, editing' },
  { id: 2, title: 'L2: WASD Gaming', desc: 'High-speed FPS / competitive gaming cluster' },
];

export const KeyMatrix: React.FC<KeyMatrixProps> = ({
  activeLayer,
  layers,
  keysStatus,
  selectedSimKey,
  onSelectLayer,
  onOpenRemap,
  onSelectSimKey,
}) => {
  const currentLayerKeys = layers[activeLayer] || [];

  return (
    <div className="flex flex-col gap-4">
      {/* Layer Tabs */}
      <div className="flex bg-[#222738] p-1 rounded-lg gap-1 border border-[#2d3748]">
        {LAYER_NAMES.map((l) => (
          <button
            key={l.id}
            onClick={() => onSelectLayer(l.id)}
            className={`flex-1 py-2 px-3 rounded-md text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
              activeLayer === l.id
                ? 'bg-[#00f2fe] text-black shadow-[0_2px_8px_rgba(0,242,254,0.35)]'
                : 'text-[#9ca3af] hover:text-white hover:bg-[#181c27]'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>{l.title}</span>
          </button>
        ))}
      </div>

      {/* Matrix 4x4 Grid */}
      <div className="flex justify-center p-4 bg-[#11141d] rounded-2xl border border-[#2d3748] shadow-inner">
        <div className="grid grid-cols-4 gap-3 sm:gap-3.5">
          {Array.from({ length: 16 }).map((_, i) => {
            const keyInfo = currentLayerKeys[i] || { idx: i, code: 0, label: 'KEY' };
            const status = keysStatus[i] || { idx: i, pressed: false, travel: 0.0, label: keyInfo.label };
            const isActuated = status.pressed;
            const isSimTarget = selectedSimKey === i;

            // Percentage of travel (0 to 4mm)
            const travelPct = Math.min(100, (status.travel / 4.0) * 100);

            return (
              <div
                key={i}
                className="relative group flex flex-col items-center"
              >
                <button
                  type="button"
                  onClick={() => {
                    onSelectSimKey(i);
                    onOpenRemap(i);
                  }}
                  className={`relative w-[68px] h-[68px] sm:w-[76px] sm:h-[76px] rounded-xl flex flex-col items-center justify-between p-2 cursor-pointer transition-all duration-150 select-none overflow-hidden ${
                    isActuated
                      ? 'bg-gradient-to-br from-[#10b981] to-[#059669] text-white shadow-[0_0_16px_rgba(16,185,129,0.6)] translate-y-0.5 border-emerald-400'
                      : 'bg-[#222738] text-[#f3f4f6] hover:border-[#00f2fe] hover:-translate-y-0.5 border-[#2d3748] shadow-md'
                  } border ${
                    isSimTarget && !isActuated ? 'ring-2 ring-[#00f2fe]/80 ring-offset-2 ring-offset-[#11141d]' : ''
                  }`}
                >
                  {/* Background travel gauge fill */}
                  {!isActuated && travelPct > 0 && (
                    <div
                      className="absolute bottom-0 left-0 right-0 bg-[#00f2fe]/20 transition-all duration-75 pointer-events-none"
                      style={{ height: `${travelPct}%` }}
                    />
                  )}

                  {/* Top Key Info Row */}
                  <div className="w-full flex items-center justify-between text-[10px] text-[#9ca3af] pointer-events-none">
                    <span className={`font-mono ${isActuated ? 'text-emerald-100 font-bold' : ''}`}>
                      #{i}
                    </span>
                    {isSimTarget && (
                      <span className="w-1.5 h-1.5 rounded-full bg-[#00f2fe] animate-pulse" title="Target for Switch Simulator" />
                    )}
                  </div>

                  {/* Main Key Label */}
                  <span
                    className={`font-black tracking-wide text-base sm:text-lg pointer-events-none truncate max-w-full ${
                      isActuated ? 'text-white scale-105' : 'text-[#f3f4f6]'
                    }`}
                  >
                    {keyInfo.label}
                  </span>

                  {/* Bottom Travel / Code Readout */}
                  <div className="w-full flex items-center justify-between text-[9px] pointer-events-none">
                    <span className={`font-mono ${isActuated ? 'text-emerald-100' : 'text-[#9ca3af]'}`}>
                      {status.travel > 0 ? `${status.travel.toFixed(1)}mm` : `c:${keyInfo.code}`}
                    </span>
                    <Edit3 className={`w-2.5 h-2.5 opacity-0 group-hover:opacity-100 transition-opacity ${isActuated ? 'text-white' : 'text-[#00f2fe]'}`} />
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Guide Note */}
      <div className="flex items-center justify-between text-xs text-[#9ca3af] px-1">
        <span className="flex items-center gap-1.5">
          <KeyboardIcon className="w-4 h-4 text-[#00f2fe]" /> Click any key to remap label &amp; HID keycode.
        </span>
        <span className="text-[11px] text-[#00f2fe]">
          Selected for test: <strong className="font-mono font-bold text-white">Key #{selectedSimKey} ({currentLayerKeys[selectedSimKey]?.label || ''})</strong>
        </span>
      </div>
    </div>
  );
};
