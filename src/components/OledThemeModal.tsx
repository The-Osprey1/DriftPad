import React, { useState, useEffect, useRef } from 'react';
import {
  OledThemeConfig,
  OLED_THEME_PRESETS,
  DEFAULT_OLED_THEME,
} from '../types/driftpad';
import {
  Palette,
  X,
  RotateCcw,
  Check,
  Sparkles,
  Sliders,
  Briefcase,
  Monitor,
  Eye,
} from 'lucide-react';

interface OledThemeModalProps {
  isOpen: boolean;
  profileName: string;
  currentTheme?: OledThemeConfig;
  onClose: () => void;
  onSaveTheme: (theme: OledThemeConfig) => void;
}

export const OledThemeModal: React.FC<OledThemeModalProps> = ({
  isOpen,
  profileName,
  currentTheme,
  onClose,
  onSaveTheme,
}) => {
  const [theme, setTheme] = useState<OledThemeConfig>(() => currentTheme || DEFAULT_OLED_THEME);
  const [previewTab, setPreviewTab] = useState<'productivity' | 'cockpit' | 'screensaver'>('productivity');
  const [simTravel, setSimTravel] = useState<number>(1.85);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const animTicksRef = useRef<number>(0);

  // Sync when currentTheme changes or modal opens
  useEffect(() => {
    if (isOpen) {
      setTheme(currentTheme ? { ...currentTheme } : { ...DEFAULT_OLED_THEME });
    }
  }, [isOpen, currentTheme]);

  // Handle ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Render live preview canvas
  useEffect(() => {
    if (!isOpen) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = 128;
    const H = 64;

    const render = () => {
      animTicksRef.current += 1;
      const ticks = animTicksRef.current;

      const bg = theme.background || '#05080f';
      const text = theme.textColor || '#00f2fe';
      const graph = theme.graphColor || '#00f2fe';
      const dim = theme.dimColor || '#0f4c5c';
      const accent = theme.accentColor || '#f59e0b';

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      if (previewTab === 'productivity') {
        // --- Productivity layout ---
        ctx.fillStyle = text;
        ctx.font = 'bold 7px monospace';
        ctx.fillText(profileName.slice(0, 14).toUpperCase(), 2, 8);

        // Layer badge
        ctx.fillStyle = text;
        ctx.fillRect(88, 1, 38, 9);
        ctx.fillStyle = bg;
        ctx.fillText('LAYER 0', 92, 8);
        ctx.fillStyle = text;

        // Divider
        ctx.strokeStyle = dim;
        ctx.beginPath();
        ctx.moveTo(0, 12);
        ctx.lineTo(W, 12);
        ctx.stroke();

        // Key box
        const isActuated = simTravel >= 1.20;
        if (isActuated) {
          ctx.fillStyle = text;
          ctx.fillRect(3, 15, 34, 34);
          ctx.fillStyle = bg;
        } else {
          ctx.strokeStyle = text;
          ctx.strokeRect(3, 15, 34, 34);
          ctx.fillStyle = text;
        }
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('PULL', 20, 32);
        ctx.font = '6px monospace';
        ctx.fillText('#1', 20, 44);
        ctx.textAlign = 'left';

        // Dial & Travel
        ctx.fillStyle = text;
        ctx.font = '6px monospace';
        ctx.fillText('DIAL: FILE TABS', 42, 22);

        ctx.font = 'bold 7px monospace';
        ctx.fillStyle = isActuated ? graph : text;
        ctx.fillText(`${simTravel.toFixed(2)}mm`, 42, 33);

        ctx.font = '6px monospace';
        ctx.fillStyle = isActuated ? graph : dim;
        ctx.fillText(isActuated ? 'ACTUATED' : 'REST/IDLE', 86, 33);

        // Track
        const trackX = 42;
        const trackY = 37;
        const trackW = 82;
        const trackH = 8;
        ctx.strokeStyle = dim;
        ctx.strokeRect(trackX, trackY, trackW, trackH);

        const fillW = Math.max(0, Math.min(trackW, (simTravel / 4.0) * trackW));
        ctx.fillStyle = isActuated ? graph : text;
        ctx.fillRect(trackX + 1, trackY + 1, fillW, trackH - 2);

        // Actuation threshold line
        const actX = trackX + (1.20 / 4.0) * trackW;
        ctx.strokeStyle = accent;
        ctx.beginPath();
        ctx.moveTo(actX, trackY - 1);
        ctx.lineTo(actX, trackY + trackH + 1);
        ctx.stroke();

        // Bottom divider & status
        ctx.strokeStyle = dim;
        ctx.beginPath();
        ctx.moveTo(0, 52);
        ctx.lineTo(W, 52);
        ctx.stroke();

        ctx.fillStyle = text;
        ctx.font = '6px monospace';
        ctx.fillText('ACT:1.20mm · RT:0.20mm', 2, 61);
      } else if (previewTab === 'cockpit') {
        // --- Cockpit HUD layout ---
        ctx.fillStyle = text;
        ctx.font = 'bold 7px monospace';
        ctx.fillText('L0:TOOLS', 2, 8);

        ctx.fillStyle = text;
        ctx.fillRect(48, 1, 32, 9);
        ctx.fillStyle = bg;
        ctx.fillText('RT ON', 52, 8);
        ctx.fillStyle = text;

        ctx.font = '6px monospace';
        ctx.fillText('ACT:1.20', 84, 8);

        ctx.strokeStyle = dim;
        ctx.beginPath();
        ctx.moveTo(0, 12);
        ctx.lineTo(W, 12);
        ctx.stroke();

        // Key box
        const isActuated = simTravel >= 1.20;
        if (isActuated) {
          ctx.fillStyle = text;
          ctx.fillRect(3, 15, 34, 34);
          ctx.fillStyle = bg;
        } else {
          ctx.strokeStyle = text;
          ctx.strokeRect(3, 15, 34, 34);
          ctx.fillStyle = text;
        }
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('ESC', 20, 32);
        ctx.font = '6px monospace';
        ctx.fillText('#0', 20, 44);
        ctx.textAlign = 'left';

        // Readout
        ctx.fillStyle = text;
        ctx.font = 'bold 8px monospace';
        ctx.fillText(`${simTravel.toFixed(2)} mm`, 44, 23);

        const trackX = 44;
        const trackY = 27;
        const trackW = 80;
        const trackH = 10;
        ctx.strokeStyle = dim;
        ctx.strokeRect(trackX, trackY, trackW, trackH);

        const fillW = Math.max(0, Math.min(trackW, (simTravel / 4.0) * trackW));
        ctx.fillStyle = isActuated ? graph : text;
        ctx.fillRect(trackX + 1, trackY + 1, fillW, trackH - 2);

        const actX = trackX + (1.20 / 4.0) * trackW;
        ctx.strokeStyle = accent;
        ctx.beginPath();
        ctx.moveTo(actX, trackY - 2);
        ctx.lineTo(actX, trackY + trackH + 2);
        ctx.stroke();

        // Divider
        ctx.strokeStyle = dim;
        ctx.beginPath();
        ctx.moveTo(0, 52);
        ctx.lineTo(W, 52);
        ctx.stroke();

        ctx.fillStyle = text;
        ctx.font = '6px monospace';
        ctx.fillText('DRIFTPAD HE // 8kHz', 3, 61);

        // 4x4 mini dots
        for (let r = 0; r < 4; r++) {
          for (let col = 0; col < 4; col++) {
            const dotX = 108 + col * 4;
            const dotY = 54 + r * 2;
            if (r === 0 && col === 0 && isActuated) {
              ctx.fillStyle = graph;
              ctx.fillRect(dotX, dotY, 3, 2);
            } else if (r === 0 && col === 0) {
              ctx.fillStyle = text;
              ctx.fillRect(dotX, dotY, 2, 1);
            } else {
              ctx.fillStyle = dim;
              ctx.fillRect(dotX, dotY, 1, 1);
            }
          }
        }
      } else {
        // --- Screensaver / Waveform layout ---
        ctx.strokeStyle = graph;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x < W; x++) {
          const y =
            32 +
            Math.sin(x * 0.08 + ticks * 0.08) * 14 +
            Math.sin(x * 0.16 - ticks * 0.12) * 6;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Top info
        ctx.fillStyle = text;
        ctx.font = 'bold 7px monospace';
        ctx.fillText('HALL OSCILLOSCOPE', 4, 10);

        // Grid dots
        ctx.fillStyle = dim;
        for (let gx = 10; gx < W; gx += 20) {
          for (let gy = 16; gy < H - 8; gy += 12) {
            ctx.fillRect(gx, gy, 1, 1);
          }
        }

        // Bottom status
        ctx.fillStyle = text;
        ctx.font = '6px monospace';
        ctx.fillText('FREQ: 115.2kHz · SNR 94dB', 4, 60);
      }

      animFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isOpen, theme, previewTab, simTravel, profileName]);

  if (!isOpen) return null;

  const handleApplyPreset = (presetTheme: OledThemeConfig) => {
    setTheme({ ...presetTheme });
  };

  const handleReset = () => {
    setTheme(currentTheme ? { ...currentTheme } : { ...DEFAULT_OLED_THEME });
  };

  const handleColorChange = (key: keyof OledThemeConfig, value: string) => {
    setTheme((prev) => ({ ...prev, [key]: value }));
  };

  // Color options swatches for quick clicking
  const quickSwatches: Record<keyof OledThemeConfig, string[]> = {
    background: ['#05080f', '#000000', '#0a0d14', '#0d0900', '#000f04', '#0c040d', '#021410', '#080512'],
    textColor: ['#00f2fe', '#ffffff', '#ffb000', '#00ff66', '#ff2a85', '#2dd4bf', '#ff5722', '#a855f7'],
    graphColor: ['#00f2fe', '#10b981', '#38bdf8', '#ff9900', '#00e65c', '#34d399', '#ff9800', '#c084fc'],
    dimColor: ['#0f4c5c', '#1e2638', '#334155', '#4d3300', '#00471b', '#4d1235', '#0d382f', '#3b1d61'],
    accentColor: ['#f59e0b', '#38bdf8', '#ff4d4d', '#ffee00', '#facc15', '#fbbf24', '#ffeb3b', '#06b6d4'],
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-xs">
      <div className="bg-[#121722] border border-[#1e2638] rounded-2xl w-full max-w-3xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#1e2638] bg-[#0d1017]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#00f2fe]/10 border border-[#00f2fe]/30 flex items-center justify-center text-[#00f2fe]">
              <Palette className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                OLED Display Visual Theme
              </h3>
              <p className="text-xs text-slate-400">
                Workspace Profile:{' '}
                <span className="text-[#00f2fe] font-medium">{profileName}</span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-[#1a2233] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 flex flex-col gap-5">
          {/* Top Section: Live Screen Preview with Controls */}
          <div className="bg-[#0b0e14] border border-[#1e2638] rounded-xl p-4 flex flex-col md:flex-row items-center gap-5 justify-between">
            {/* Live Canvas Box */}
            <div className="flex flex-col items-center gap-2">
              <div className="relative p-2.5 rounded-lg border border-[#1e2638] bg-[#030508] shadow-inner">
                <canvas
                  ref={canvasRef}
                  width={128}
                  height={64}
                  className="w-[256px] h-[128px] sm:w-[280px] sm:h-[140px] rounded"
                  style={{
                    imageRendering: 'pixelated',
                    backgroundColor: theme.background,
                  }}
                />
                <div className="absolute top-4 right-4 flex items-center gap-1 bg-black/60 px-1.5 py-0.5 rounded text-[10px] text-slate-400 font-mono">
                  <Monitor className="w-2.5 h-2.5 text-[#00f2fe]" /> 128×64
                </div>
              </div>

              {/* View layout selector */}
              <div className="flex bg-[#121722] p-0.5 rounded-lg border border-[#1e2638] text-[11px]">
                <button
                  onClick={() => setPreviewTab('productivity')}
                  className={`px-2.5 py-1 rounded-md font-medium transition-colors flex items-center gap-1 ${
                    previewTab === 'productivity'
                      ? 'bg-[#1e2638] text-white shadow-xs'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Briefcase className="w-3 h-3" /> Productivity
                </button>
                <button
                  onClick={() => setPreviewTab('cockpit')}
                  className={`px-2.5 py-1 rounded-md font-medium transition-colors flex items-center gap-1 ${
                    previewTab === 'cockpit'
                      ? 'bg-[#1e2638] text-white shadow-xs'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Sliders className="w-3 h-3" /> Cockpit HUD
                </button>
                <button
                  onClick={() => setPreviewTab('screensaver')}
                  className={`px-2.5 py-1 rounded-md font-medium transition-colors flex items-center gap-1 ${
                    previewTab === 'screensaver'
                      ? 'bg-[#1e2638] text-white shadow-xs'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Sparkles className="w-3 h-3" /> Waveform
                </button>
              </div>
            </div>

            {/* Live Interactive Controls for Preview */}
            <div className="flex-1 w-full flex flex-col gap-3">
              <div className="bg-[#121722] p-3 rounded-lg border border-[#1e2638] flex flex-col gap-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-300 font-medium flex items-center gap-1.5">
                    <Eye className="w-3.5 h-3.5 text-[#00f2fe]" />
                    Simulated Key Press Travel
                  </span>
                  <span className="text-[#00f2fe] font-mono tabular-nums font-semibold">
                    {simTravel.toFixed(2)} mm
                  </span>
                </div>
                <input
                  type="range"
                  min="0.00"
                  max="4.00"
                  step="0.05"
                  value={simTravel}
                  onChange={(e) => setSimTravel(parseFloat(e.target.value))}
                  className="w-full accent-[#00f2fe] cursor-pointer h-1.5 bg-[#1e2638] rounded-lg"
                />
                <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                  <span>0.00mm (Idle)</span>
                  <span className="text-amber-400">1.20mm (Actuation)</span>
                  <span>4.00mm (Bottom Out)</span>
                </div>
              </div>

              {/* Theme Color Chips Summary */}
              <div className="bg-[#121722] p-3 rounded-lg border border-[#1e2638] flex flex-col gap-2">
                <span className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider">
                  Active Palette Spectrum
                </span>
                <div className="grid grid-cols-5 gap-2">
                  <div className="flex flex-col items-center gap-1">
                    <span
                      className="w-7 h-7 rounded-lg border border-white/20 shadow-xs"
                      style={{ backgroundColor: theme.background }}
                    />
                    <span className="text-[9px] text-slate-400">Background</span>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <span
                      className="w-7 h-7 rounded-lg border border-white/20 shadow-xs"
                      style={{ backgroundColor: theme.textColor }}
                    />
                    <span className="text-[9px] text-slate-400">Text &amp; UI</span>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <span
                      className="w-7 h-7 rounded-lg border border-white/20 shadow-xs"
                      style={{ backgroundColor: theme.graphColor }}
                    />
                    <span className="text-[9px] text-slate-400">Graphs</span>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <span
                      className="w-7 h-7 rounded-lg border border-white/20 shadow-xs"
                      style={{ backgroundColor: theme.dimColor }}
                    />
                    <span className="text-[9px] text-slate-400">Dividers</span>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <span
                      className="w-7 h-7 rounded-lg border border-white/20 shadow-xs"
                      style={{ backgroundColor: theme.accentColor }}
                    />
                    <span className="text-[9px] text-slate-400">Accent</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Hardware Theme Presets Section */}
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Hardware Display Presets
              </span>
              <span className="text-[11px] text-slate-500">
                1-click calibrated profiles
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {OLED_THEME_PRESETS.map((preset) => {
                const isSelected =
                  theme.background === preset.theme.background &&
                  theme.textColor === preset.theme.textColor &&
                  theme.graphColor === preset.theme.graphColor;
                return (
                  <button
                    key={preset.id}
                    onClick={() => handleApplyPreset(preset.theme)}
                    className={`flex flex-col gap-1.5 p-2.5 rounded-xl border text-left transition-all ${
                      isSelected
                        ? 'bg-[#182030] border-[#00f2fe] ring-1 ring-[#00f2fe]/40'
                        : 'bg-[#10141d] border-[#1e2638] hover:bg-[#141a26] hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-white truncate">
                        {preset.name}
                      </span>
                      {isSelected && (
                        <Check className="w-3.5 h-3.5 text-[#00f2fe]" />
                      )}
                    </div>

                    <div className="flex items-center gap-1">
                      <span
                        className="w-3.5 h-3.5 rounded-full border border-black/40"
                        style={{ backgroundColor: preset.theme.background }}
                      />
                      <span
                        className="w-3.5 h-3.5 rounded-full border border-black/40"
                        style={{ backgroundColor: preset.theme.textColor }}
                      />
                      <span
                        className="w-3.5 h-3.5 rounded-full border border-black/40"
                        style={{ backgroundColor: preset.theme.graphColor }}
                      />
                      <span
                        className="w-3.5 h-3.5 rounded-full border border-black/40"
                        style={{ backgroundColor: preset.theme.accentColor }}
                      />
                    </div>

                    <p className="text-[10px] text-slate-400 line-clamp-1">
                      {preset.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Granular Color Channels Customizer */}
          <div className="flex flex-col gap-3">
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Fine-Tuning Color Channels
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Background Color */}
              <div className="bg-[#10141d] border border-[#1e2638] rounded-xl p-3 flex flex-col gap-2">
                <div className="flex justify-between items-center">
                  <div>
                    <label className="text-xs font-medium text-white block">
                      Canvas Background
                    </label>
                    <span className="text-[10px] text-slate-400">
                      OLED substrate tone
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="color"
                      value={theme.background}
                      onChange={(e) => handleColorChange('background', e.target.value)}
                      className="w-7 h-7 rounded cursor-pointer border border-[#2d3748] bg-transparent p-0"
                    />
                    <input
                      type="text"
                      value={theme.background}
                      onChange={(e) => handleColorChange('background', e.target.value)}
                      className="w-20 px-2 py-1 bg-[#182030] border border-[#2d3748] rounded text-[11px] font-mono text-slate-200 text-center uppercase focus:outline-none focus:border-[#00f2fe]"
                    />
                  </div>
                </div>
                <div className="flex gap-1.5 pt-1">
                  {quickSwatches.background.map((hex) => (
                    <button
                      key={hex}
                      onClick={() => handleColorChange('background', hex)}
                      className={`w-4 h-4 rounded-full border transition-transform ${
                        theme.background.toLowerCase() === hex.toLowerCase()
                          ? 'scale-125 border-white'
                          : 'border-slate-700 hover:scale-110'
                      }`}
                      style={{ backgroundColor: hex }}
                      title={hex}
                    />
                  ))}
                </div>
              </div>

              {/* Text & Primary Color */}
              <div className="bg-[#10141d] border border-[#1e2638] rounded-xl p-3 flex flex-col gap-2">
                <div className="flex justify-between items-center">
                  <div>
                    <label className="text-xs font-medium text-white block">
                      Text &amp; UI Foreground
                    </label>
                    <span className="text-[10px] text-slate-400">
                      Labels, keys &amp; telemetry
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="color"
                      value={theme.textColor}
                      onChange={(e) => handleColorChange('textColor', e.target.value)}
                      className="w-7 h-7 rounded cursor-pointer border border-[#2d3748] bg-transparent p-0"
                    />
                    <input
                      type="text"
                      value={theme.textColor}
                      onChange={(e) => handleColorChange('textColor', e.target.value)}
                      className="w-20 px-2 py-1 bg-[#182030] border border-[#2d3748] rounded text-[11px] font-mono text-slate-200 text-center uppercase focus:outline-none focus:border-[#00f2fe]"
                    />
                  </div>
                </div>
                <div className="flex gap-1.5 pt-1">
                  {quickSwatches.textColor.map((hex) => (
                    <button
                      key={hex}
                      onClick={() => handleColorChange('textColor', hex)}
                      className={`w-4 h-4 rounded-full border transition-transform ${
                        theme.textColor.toLowerCase() === hex.toLowerCase()
                          ? 'scale-125 border-white'
                          : 'border-slate-700 hover:scale-110'
                      }`}
                      style={{ backgroundColor: hex }}
                      title={hex}
                    />
                  ))}
                </div>
              </div>

              {/* Graphs & Meters */}
              <div className="bg-[#10141d] border border-[#1e2638] rounded-xl p-3 flex flex-col gap-2">
                <div className="flex justify-between items-center">
                  <div>
                    <label className="text-xs font-medium text-white block">
                      Graphs &amp; Dynamic Meters
                    </label>
                    <span className="text-[10px] text-slate-400">
                      Travel bar, waves &amp; pressed states
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="color"
                      value={theme.graphColor}
                      onChange={(e) => handleColorChange('graphColor', e.target.value)}
                      className="w-7 h-7 rounded cursor-pointer border border-[#2d3748] bg-transparent p-0"
                    />
                    <input
                      type="text"
                      value={theme.graphColor}
                      onChange={(e) => handleColorChange('graphColor', e.target.value)}
                      className="w-20 px-2 py-1 bg-[#182030] border border-[#2d3748] rounded text-[11px] font-mono text-slate-200 text-center uppercase focus:outline-none focus:border-[#00f2fe]"
                    />
                  </div>
                </div>
                <div className="flex gap-1.5 pt-1">
                  {quickSwatches.graphColor.map((hex) => (
                    <button
                      key={hex}
                      onClick={() => handleColorChange('graphColor', hex)}
                      className={`w-4 h-4 rounded-full border transition-transform ${
                        theme.graphColor.toLowerCase() === hex.toLowerCase()
                          ? 'scale-125 border-white'
                          : 'border-slate-700 hover:scale-110'
                      }`}
                      style={{ backgroundColor: hex }}
                      title={hex}
                    />
                  ))}
                </div>
              </div>

              {/* Actuation Marker & Accent */}
              <div className="bg-[#10141d] border border-[#1e2638] rounded-xl p-3 flex flex-col gap-2">
                <div className="flex justify-between items-center">
                  <div>
                    <label className="text-xs font-medium text-white block">
                      Actuation Marker &amp; Accent
                    </label>
                    <span className="text-[10px] text-slate-400">
                      Trigger line indicator &amp; warnings
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="color"
                      value={theme.accentColor}
                      onChange={(e) => handleColorChange('accentColor', e.target.value)}
                      className="w-7 h-7 rounded cursor-pointer border border-[#2d3748] bg-transparent p-0"
                    />
                    <input
                      type="text"
                      value={theme.accentColor}
                      onChange={(e) => handleColorChange('accentColor', e.target.value)}
                      className="w-20 px-2 py-1 bg-[#182030] border border-[#2d3748] rounded text-[11px] font-mono text-slate-200 text-center uppercase focus:outline-none focus:border-[#00f2fe]"
                    />
                  </div>
                </div>
                <div className="flex gap-1.5 pt-1">
                  {quickSwatches.accentColor.map((hex) => (
                    <button
                      key={hex}
                      onClick={() => handleColorChange('accentColor', hex)}
                      className={`w-4 h-4 rounded-full border transition-transform ${
                        theme.accentColor.toLowerCase() === hex.toLowerCase()
                          ? 'scale-125 border-white'
                          : 'border-slate-700 hover:scale-110'
                      }`}
                      style={{ backgroundColor: hex }}
                      title={hex}
                    />
                  ))}
                </div>
              </div>

              {/* Dividers & Dim Grids */}
              <div className="bg-[#10141d] border border-[#1e2638] rounded-xl p-3 flex flex-col gap-2 sm:col-span-2">
                <div className="flex justify-between items-center">
                  <div>
                    <label className="text-xs font-medium text-white block">
                      Subtle Dividers &amp; Inactive Grids
                    </label>
                    <span className="text-[10px] text-slate-400">
                      Partition lines, inactive keycaps &amp; border tracks
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="color"
                      value={theme.dimColor}
                      onChange={(e) => handleColorChange('dimColor', e.target.value)}
                      className="w-7 h-7 rounded cursor-pointer border border-[#2d3748] bg-transparent p-0"
                    />
                    <input
                      type="text"
                      value={theme.dimColor}
                      onChange={(e) => handleColorChange('dimColor', e.target.value)}
                      className="w-20 px-2 py-1 bg-[#182030] border border-[#2d3748] rounded text-[11px] font-mono text-slate-200 text-center uppercase focus:outline-none focus:border-[#00f2fe]"
                    />
                  </div>
                </div>
                <div className="flex gap-1.5 pt-1">
                  {quickSwatches.dimColor.map((hex) => (
                    <button
                      key={hex}
                      onClick={() => handleColorChange('dimColor', hex)}
                      className={`w-4 h-4 rounded-full border transition-transform ${
                        theme.dimColor.toLowerCase() === hex.toLowerCase()
                          ? 'scale-125 border-white'
                          : 'border-slate-700 hover:scale-110'
                      }`}
                      style={{ backgroundColor: hex }}
                      title={hex}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3.5 border-t border-[#1e2638] bg-[#0d1017]">
          <button
            onClick={handleReset}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-white hover:bg-[#182030] border border-transparent hover:border-[#2d3748] transition-colors flex items-center gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Colors</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-slate-300 hover:text-white bg-[#182030] hover:bg-[#202b40] border border-[#242e42] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onSaveTheme(theme)}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold text-black bg-[#00f2fe] hover:bg-[#38bdf8] shadow-xs flex items-center gap-1.5 transition-colors"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Save to Profile</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
