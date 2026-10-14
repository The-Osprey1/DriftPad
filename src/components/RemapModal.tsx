import React, { useState, useEffect } from 'react';
import {
  COMMON_KEYCODES,
  PRODUCTIVITY_SHORTCUT_PRESETS,
  ModifierFlags,
  LayerKey,
} from '../types/driftpad';
import {
  X,
  Check,
  Keyboard as KeyboardIcon,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { HoverExplain } from './HoverExplain';

interface RemapModalProps {
  isOpen: boolean;
  keyIdx: number;
  currentKey: LayerKey;
  workspaceName?: string;
  onClose: () => void;
  onSave: (keyIdx: number, updatedKey: LayerKey) => void;
}

export const RemapModal: React.FC<RemapModalProps> = ({
  isOpen,
  keyIdx,
  currentKey,
  workspaceName = 'Active Workspace',
  onClose,
  onSave,
}) => {
  const [label, setLabel] = useState<string>('');
  const [code, setCode] = useState<number>(0);
  const [description, setDescription] = useState<string>('');
  const [modifiers, setModifiers] = useState<ModifierFlags>({});
  const [customActuationEnabled, setCustomActuationEnabled] = useState<boolean>(false);
  const [customActuationMm, setCustomActuationMm] = useState<number>(1.20);
  const [activeCategory, setActiveCategory] = useState<string>('All');

  useEffect(() => {
    if (isOpen && currentKey) {
      setLabel(currentKey.label || 'KEY');
      setCode(currentKey.code || 0);
      setDescription(currentKey.description || '');
      setModifiers(currentKey.modifiers || {});
      if (currentKey.customActuation !== undefined) {
        setCustomActuationEnabled(true);
        setCustomActuationMm(currentKey.customActuation);
      } else {
        setCustomActuationEnabled(false);
        setCustomActuationMm(1.20);
      }
    }
  }, [isOpen, currentKey]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalLabel = label.trim().toUpperCase() || 'KEY';
    const updated: LayerKey = {
      idx: keyIdx,
      code,
      label: finalLabel.slice(0, 4),
      description: description.trim() || undefined,
      modifiers:
        modifiers.ctrl || modifiers.alt || modifiers.shift || modifiers.meta
          ? modifiers
          : undefined,
      customActuation: customActuationEnabled ? customActuationMm : undefined,
    };

    onSave(keyIdx, updated);
    onClose();
  };

  const handleApplyShortcut = (preset: (typeof PRODUCTIVITY_SHORTCUT_PRESETS)[0]) => {
    setLabel(preset.disp);
    setCode(preset.code);
    setModifiers(preset.modifiers);
    setDescription(preset.label);
  };

  const categories = ['All', 'Numbers', 'Letters', 'Navigation', 'Control', 'Symbols', 'Function/Macro'];
  const filteredKeycodes =
    activeCategory === 'All'
      ? COMMON_KEYCODES
      : COMMON_KEYCODES.filter((k) => k.category === activeCategory);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="remap-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-150 overflow-y-auto"
    >
      <div className="bg-[#ffffff] border border-[#e5dfd5] rounded-2xl w-full max-w-xl shadow-2xl overflow-hidden flex flex-col my-auto max-h-[95vh]">
        {/* Header */}
        <div className="flex justify-between items-center p-4 border-b border-[#e5dfd5] bg-[#faf8f5]">
          <div className="flex items-center gap-2">
            <KeyboardIcon className="w-5 h-5 text-[#9e5b3d]" />
            <h3 id="remap-modal-title" className="text-base font-bold text-[#1c282e]">
              Remap Key #{keyIdx} <span className="text-[#84949b] font-normal text-xs sm:text-sm">· {workspaceName}</span>
            </h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close modal"
            className="text-[#84949b] hover:text-[#1c282e] p-1 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9e5b3d]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Form Body */}
        <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4 overflow-y-auto text-[#1c282e]">
          {/* Quick Productivity Shortcuts Row */}
          <div className="flex flex-col gap-1.5 bg-[#faf8f5] p-3 rounded-xl border border-[#e5dfd5]">
            <span className="text-xs font-bold text-[#9e5b3d] flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" /> Quick Productivity Shortcuts
            </span>
            <div className="flex gap-1.5 overflow-x-auto pb-1 text-[11px] scrollbar-thin">
              {PRODUCTIVITY_SHORTCUT_PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.label}
                  onClick={() => handleApplyShortcut(p)}
                  className="bg-[#ffffff] hover:bg-[#faf8f5] text-[#1c282e] hover:text-[#9e5b3d] px-2.5 py-1 rounded-lg border border-[#e5dfd5] font-mono shrink-0 transition-colors shadow-xs"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Key Identity & Modifiers Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-bold text-[#57676e]">Display Label (Max 4 chars)</label>
              <input
                type="text"
                maxLength={4}
                value={label}
                onChange={(e) => setLabel(e.target.value.toUpperCase())}
                placeholder="ESC"
                className="bg-[#ffffff] border border-[#e5dfd5] rounded-xl px-3 py-2 text-sm font-mono font-bold text-[#1c282e] focus:outline-none focus:border-[#9e5b3d] shadow-xs"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-bold text-[#57676e]">HID Keycode (decimal)</label>
              <input
                type="number"
                value={code}
                onChange={(e) => setCode(parseInt(e.target.value, 10) || 0)}
                className="bg-[#ffffff] border border-[#e5dfd5] rounded-xl px-3 py-2 text-sm font-mono text-[#1c282e] focus:outline-none focus:border-[#9e5b3d] shadow-xs"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-bold text-[#57676e]">Description / Subtitle</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Save Workbook or Git Commit"
              className="bg-[#ffffff] border border-[#e5dfd5] rounded-xl px-3 py-2 text-xs text-[#1c282e] focus:outline-none focus:border-[#9e5b3d] shadow-xs"
            />
          </div>

          {/* Modifier Flags */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-[#57676e]">Modifier Keys:</span>
              <HoverExplain
                title="Modifier Keys"
                badge="Combos"
                explanation="Automatically applies modifier keys (Ctrl, Alt, Shift, Cmd/Win) when pressing this pad switch, turning single keys into instant multi-key combos."
              />
            </div>
            <div className="grid grid-cols-4 gap-2 text-xs font-bold font-mono">
              {(['ctrl', 'alt', 'shift', 'meta'] as (keyof ModifierFlags)[]).map((mod) => (
                <button
                  type="button"
                  key={mod}
                  onClick={() =>
                    setModifiers((prev) => ({
                      ...prev,
                      [mod]: !prev[mod],
                    }))
                  }
                  className={`py-2 rounded-xl border transition-colors shadow-xs ${
                    modifiers[mod]
                      ? 'bg-[#9e5b3d] text-white border-[#82442a]'
                      : 'bg-[#ffffff] text-[#57676e] border-[#e5dfd5] hover:text-[#1c282e]'
                  }`}
                >
                  {mod === 'meta' ? 'CMD / WIN' : mod.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Per-Key Custom Actuation Override */}
          <div className="bg-[#faf8f5] p-3 rounded-xl border border-[#e5dfd5] flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-[#1c282e]">
                <input
                  type="checkbox"
                  checked={customActuationEnabled}
                  onChange={(e) => setCustomActuationEnabled(e.target.checked)}
                  className="rounded text-[#9e5b3d] focus:ring-[#9e5b3d]"
                />
                <ShieldAlert className="w-4 h-4 text-[#b45309]" />
                <span>Custom Safety Actuation Depth</span>
              </label>
              <HoverExplain
                title="Safety Actuation"
                badge="Safety"
                explanation="Assigns a deeper physical press requirement (e.g. 3.5mm) specifically to this key, requiring an intentional bottom-out stroke before triggering."
              />
            </div>

            {customActuationEnabled && (
              <div className="flex flex-col gap-2 mt-1 pt-2 border-t border-[#e5dfd5]">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-[#57676e]">Override Actuation:</span>
                  <span className="font-bold text-[#b45309]">{customActuationMm.toFixed(2)} mm</span>
                </div>
                <input
                  type="range"
                  min="0.20"
                  max="3.80"
                  step="0.05"
                  value={customActuationMm}
                  onChange={(e) => setCustomActuationMm(parseFloat(e.target.value))}
                  className="w-full accent-[#b45309]"
                />
                <div className="flex gap-2 text-[11px] text-[#57676e]">
                  <button
                    type="button"
                    onClick={() => setCustomActuationMm(1.20)}
                    className="hover:text-[#9e5b3d] underline"
                  >
                    1.20mm (Standard)
                  </button>
                  <button
                    type="button"
                    onClick={() => setCustomActuationMm(3.50)}
                    className="hover:text-[#b45309] underline font-bold"
                  >
                    3.50mm (Safety Deep Press)
                  </button>
                </div>
                <span className="text-[10px] text-[#84949b]">
                  Ideal for destructive actions like &quot;Kill Server&quot;, &quot;Delete Row&quot;, or &quot;Format Drive&quot; to prevent accidental triggers.
                </span>
              </div>
            )}
          </div>

          {/* Keycode Selection List */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-bold text-[#57676e]">Select Character / Keycode:</span>
            <div className="flex gap-1 overflow-x-auto pb-1 text-[11px] scrollbar-none">
              {categories.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => setActiveCategory(c)}
                  className={`px-2.5 py-1 rounded-lg border transition-colors shrink-0 shadow-xs font-semibold ${
                    activeCategory === c
                      ? 'bg-[#1e3f48] text-white border-[#1e3f48]'
                      : 'bg-[#ffffff] text-[#57676e] border-[#e5dfd5] hover:text-[#1c282e]'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>

            <div className="max-h-32 overflow-y-auto grid grid-cols-4 sm:grid-cols-6 gap-1 p-2 bg-[#faf8f5] rounded-xl border border-[#e5dfd5] scrollbar-thin">
              {filteredKeycodes.map((k) => (
                <button
                  type="button"
                  key={`${k.label}-${k.code}`}
                  onClick={() => {
                    setLabel(k.label);
                    setCode(k.code);
                    if (!description) setDescription(k.label);
                  }}
                  className={`py-1 px-1.5 rounded-lg text-xs font-mono border transition-all flex flex-col items-center ${
                    code === k.code && label === k.label
                      ? 'bg-[#9e5b3d]/15 text-[#9e5b3d] border-[#9e5b3d] font-bold'
                      : 'bg-[#ffffff] text-[#1c282e] border-[#e5dfd5] hover:border-[#9e5b3d]/50'
                  }`}
                >
                  <span className="font-bold truncate max-w-full">{k.label}</span>
                  <span className="text-[9px] text-[#84949b]">{k.code}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2.5 pt-3 border-t border-[#e5dfd5]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-[#ffffff] hover:bg-[#faf8f5] text-[#57676e] rounded-xl text-xs font-semibold border border-[#e5dfd5] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 bg-[#9e5b3d] hover:bg-[#8b4e34] text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all shadow-sm"
            >
              <Check className="w-4 h-4" /> Save Remap
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
