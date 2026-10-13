import React, { useState, useEffect } from 'react';
import { COMMON_KEYCODES } from '../types/driftpad';
import { X, Check, Keyboard as KeyboardIcon } from 'lucide-react';

interface RemapModalProps {
  isOpen: boolean;
  activeLayer: number;
  keyIdx: number;
  currentLabel: string;
  currentCode: number;
  onClose: () => void;
  onSave: (layer: number, keyIdx: number, code: number, label: string) => void;
}

export const RemapModal: React.FC<RemapModalProps> = ({
  isOpen,
  activeLayer,
  keyIdx,
  currentLabel,
  currentCode,
  onClose,
  onSave,
}) => {
  const [label, setLabel] = useState<string>('');
  const [code, setCode] = useState<number>(0);
  const [activeCategory, setActiveCategory] = useState<string>('All');

  useEffect(() => {
    if (isOpen) {
      setLabel(currentLabel);
      setCode(currentCode);
    }
  }, [isOpen, currentLabel, currentCode]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalLabel = label.trim().toUpperCase() || 'KEY';
    onSave(activeLayer, keyIdx, code, finalLabel.slice(0, 4));
    onClose();
  };

  const categories = ['All', 'Numbers', 'Letters', 'Navigation', 'Control', 'Function/Macro'];
  const filteredKeycodes =
    activeCategory === 'All'
      ? COMMON_KEYCODES
      : COMMON_KEYCODES.filter((k) => k.category === activeCategory);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="bg-[#181c27] border border-[#2d3748] rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center p-4 border-b border-[#2d3748] bg-[#11141d]">
          <div className="flex items-center gap-2">
            <KeyboardIcon className="w-5 h-5 text-[#00f2fe]" />
            <h3 className="text-base font-bold text-white">Remap Key #{keyIdx}</h3>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">
          <div className="text-xs text-[#9ca3af]">
            Configuring <strong className="text-white">Key #{keyIdx}</strong> on{' '}
            <strong className="text-[#00f2fe]">Layer {activeLayer}</strong>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Label Input */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-gray-300">
                Display Label <span className="text-gray-500">(max 4 chars)</span>
              </label>
              <input
                type="text"
                maxLength={4}
                value={label}
                onChange={(e) => setLabel(e.target.value.toUpperCase())}
                placeholder="e.g. WASD, ESC"
                className="bg-[#222738] border border-[#2d3748] text-white px-3 py-2 rounded-lg font-mono text-sm uppercase focus:outline-none focus:border-[#00f2fe]"
              />
            </div>

            {/* Keycode Input */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-gray-300">
                HID Keycode <span className="text-gray-500">(0-255)</span>
              </label>
              <input
                type="number"
                min={0}
                max={255}
                value={code}
                onChange={(e) => setCode(parseInt(e.target.value, 10) || 0)}
                className="bg-[#222738] border border-[#2d3748] text-white px-3 py-2 rounded-lg font-mono text-sm focus:outline-none focus:border-[#00f2fe]"
              />
            </div>
          </div>

          {/* Quick Preset Selector */}
          <div className="flex flex-col gap-2 mt-2">
            <span className="text-xs font-semibold text-gray-400">Quick Key Selection:</span>
            {/* Category tabs */}
            <div className="flex gap-1 overflow-x-auto pb-1 text-[11px] scrollbar-none">
              {categories.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => setActiveCategory(c)}
                  className={`px-2 py-0.5 rounded border transition-colors shrink-0 ${
                    activeCategory === c
                      ? 'bg-[#00f2fe] text-black border-[#00f2fe] font-bold'
                      : 'bg-[#222738] text-gray-400 border-[#2d3748] hover:text-white'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>

            {/* Quick Key Buttons Grid */}
            <div className="max-h-36 overflow-y-auto grid grid-cols-4 gap-1.5 p-2 bg-[#11141d] rounded-lg border border-[#2d3748] scrollbar-thin">
              {filteredKeycodes.map((k) => (
                <button
                  type="button"
                  key={`${k.label}-${k.code}`}
                  onClick={() => {
                    setLabel(k.label);
                    setCode(k.code);
                  }}
                  className={`py-1.5 px-2 rounded text-xs font-mono border transition-all flex flex-col items-center ${
                    code === k.code && label === k.label
                      ? 'bg-[#00f2fe]/20 text-[#00f2fe] border-[#00f2fe]'
                      : 'bg-[#181c27] text-gray-300 border-[#2d3748] hover:border-gray-500'
                  }`}
                >
                  <span className="font-bold">{k.label}</span>
                  <span className="text-[9px] text-gray-500">{k.code}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex justify-end gap-2.5 pt-3 border-t border-[#2d3748]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-[#222738] hover:bg-[#2d3748] text-gray-300 rounded-lg text-xs font-semibold transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] hover:shadow-[0_0_12px_rgba(0,242,254,0.5)] text-black rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all"
            >
              <Check className="w-4 h-4" /> Apply Remap
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
