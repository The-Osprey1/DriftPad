import React, { useState, useRef, useEffect } from 'react';
import {
  X,
  Paintbrush,
  Eraser,
  Sparkles,
  Copy,
  Check,
} from 'lucide-react';
import { OledCustomBitmap } from '../types/driftpad';

interface OledPixelEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentBitmap?: OledCustomBitmap | null;
  onSaveBitmap: (bitmap: OledCustomBitmap) => void;
}

const PRESET_GRAPHICS: { name: string; width: number; height: number; generate: () => number[] }[] = [
  {
    name: 'DriftPad Emblem',
    width: 32,
    height: 32,
    generate: () => {
      const arr = new Array(32 * 32).fill(0);
      const set = (x: number, y: number) => {
        if (x >= 0 && x < 32 && y >= 0 && y < 32) arr[y * 32 + x] = 1;
      };
      // Outer beveled frame
      for (let i = 2; i < 30; i++) {
        set(i, 2);
        set(i, 29);
        set(2, i);
        set(29, i);
      }
      // DP Monogram
      // D
      for (let y = 8; y <= 23; y++) {
        set(7, y);
        set(8, y);
      }
      for (let x = 8; x <= 14; x++) {
        set(x, 8);
        set(x, 23);
      }
      for (let y = 10; y <= 21; y++) {
        set(16, y);
      }
      set(15, 9);
      set(15, 22);

      // P
      for (let y = 8; y <= 23; y++) {
        set(19, y);
        set(20, y);
      }
      for (let x = 20; x <= 25; x++) {
        set(x, 8);
        set(x, 16);
      }
      for (let y = 10; y <= 14; y++) {
        set(26, y);
      }
      set(25, 9);
      set(25, 15);

      return arr;
    },
  },
  {
    name: 'Space Invader',
    width: 32,
    height: 32,
    generate: () => {
      const arr = new Array(32 * 32).fill(0);
      const sprite = [
        '  █     █  ',
        '   █   █   ',
        '  ███████  ',
        ' ██ ███ ██ ',
        '███████████',
        '█ ███████ █',
        '█ █     █ █',
        '   ██ ██   ',
      ];
      const offsetX = 10;
      const offsetY = 12;
      sprite.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
          if (row[x] === '█') {
            arr[(offsetY + y) * 32 + (offsetX + x)] = 1;
          }
        }
      });
      return arr;
    },
  },
  {
    name: 'Terminal Prompt',
    width: 32,
    height: 32,
    generate: () => {
      const arr = new Array(32 * 32).fill(0);
      const set = (x: number, y: number) => {
        if (x >= 0 && x < 32 && y >= 0 && y < 32) arr[y * 32 + x] = 1;
      };
      // Box
      for (let i = 1; i < 31; i++) {
        set(i, 1);
        set(i, 30);
        set(1, i);
        set(30, i);
      }
      // >_ prompt
      set(6, 10);
      set(7, 11);
      set(8, 12);
      set(7, 13);
      set(6, 14);

      set(11, 14);
      set(12, 14);
      set(13, 14);
      set(14, 14);

      // RP2040 line
      for (let x = 6; x < 26; x += 2) {
        set(x, 22);
      }
      return arr;
    },
  },
  {
    name: '8-Bit Heart',
    width: 32,
    height: 32,
    generate: () => {
      const arr = new Array(32 * 32).fill(0);
      const rows = [
        '   ██   ██   ',
        '  ████ ████  ',
        ' ███████████ ',
        ' ███████████ ',
        '  █████████  ',
        '   ███████   ',
        '    █████    ',
        '     ███     ',
        '      █      ',
      ];
      const offX = 9;
      const offY = 11;
      rows.forEach((r, y) => {
        for (let x = 0; x < r.length; x++) {
          if (r[x] === '█') {
            arr[(offY + y) * 32 + (offX + x)] = 1;
          }
        }
      });
      return arr;
    },
  },
];

export const OledPixelEditorModal: React.FC<OledPixelEditorModalProps> = ({
  isOpen,
  onClose,
  currentBitmap,
  onSaveBitmap,
}) => {
  const [width] = useState(32);
  const [height] = useState(32);
  const [pixels, setPixels] = useState<number[]>(() => {
    if (currentBitmap && currentBitmap.data && currentBitmap.data.length === 32 * 32) {
      return [...currentBitmap.data];
    }
    return PRESET_GRAPHICS[0].generate();
  });
  const [tool, setTool] = useState<'pencil' | 'eraser'>('pencil');
  const [isDrawing, setIsDrawing] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [graphicName, setGraphicName] = useState<string>(
    currentBitmap?.name || 'DriftPad Custom Graphic'
  );

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  // Sync with currentBitmap if opened
  useEffect(() => {
    if (currentBitmap?.data && currentBitmap.data.length === width * height) {
      setPixels([...currentBitmap.data]);
      if (currentBitmap.name) setGraphicName(currentBitmap.name);
    }
  }, [currentBitmap, width, height]);

  // Render 1x & 4x preview
  useEffect(() => {
    if (!previewCanvasRef.current) return;
    const canvas = previewCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#04070a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const scale = canvas.width / width;
    ctx.fillStyle = '#ffffff';

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (pixels[y * width + x] === 1) {
          ctx.fillRect(x * scale, y * scale, scale, scale);
        }
      }
    }
  }, [pixels, width, height]);

  if (!isOpen) return null;

  const handlePixelInteract = (index: number) => {
    const val = tool === 'pencil' ? 1 : 0;
    setPixels((prev) => {
      if (prev[index] === val) return prev;
      const next = [...prev];
      next[index] = val;
      return next;
    });
  };

  const handleInvert = () => {
    setPixels((prev) => prev.map((p) => (p === 1 ? 0 : 1)));
  };

  const handleClear = () => {
    setPixels(new Array(width * height).fill(0));
  };

  const handleApplyPreset = (presetIdx: number) => {
    const p = PRESET_GRAPHICS[presetIdx];
    setPixels(p.generate());
    setGraphicName(p.name);
  };

  const generateCArray = (): string => {
    // Generate SSD1306 column-major or row-major byte array
    const bytes: string[] = [];
    for (let i = 0; i < pixels.length; i += 8) {
      let byteVal = 0;
      for (let b = 0; b < 8; b++) {
        if (pixels[i + b] === 1) {
          byteVal |= 1 << (7 - b);
        }
      }
      bytes.push(`0x${byteVal.toString(16).padStart(2, '0').toUpperCase()}`);
    }

    const rows: string[] = [];
    for (let r = 0; r < bytes.length; r += 12) {
      rows.push('  ' + bytes.slice(r, r + 12).join(', '));
    }

    return `// DriftPad 128x64 / 32x32 SSD1306 Monochrome White OLED Bitmap
// Size: ${width}x${height} pixels
const uint8_t PROGMEM custom_oled_bitmap[] = {
${rows.join(',\n')}
};`;
  };

  const handleCopyCode = () => {
    const code = generateCArray();
    navigator.clipboard.writeText(code).then(() => {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2500);
    });
  };

  const handleSaveAndApply = () => {
    onSaveBitmap({
      name: graphicName,
      width,
      height,
      data: pixels,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="bg-[#ffffff] border border-[#ded7ca] rounded-2xl shadow-2xl max-w-2xl w-full max-h-[92vh] flex flex-col overflow-hidden text-[#1b2930]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#f0ebdf] bg-[#faf8f5]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[#153641] flex items-center justify-center text-white shadow-xs">
              <Paintbrush className="w-4 h-4 text-[#e8f1ee]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-sm text-[#1b2930]">OLED Pixel Art & Logo Editor</h3>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#f0ebdf] text-[#5b8e85] font-bold">
                  32x32 Monochrome
                </span>
              </div>
              <p className="text-xs text-[#71828a]">
                Draw custom graphics for the single-color white SSD1306 screen
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#71828a] hover:text-[#1b2930] hover:bg-[#ede7da] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto flex-1 flex flex-col md:flex-row gap-6">
          {/* Left Canvas: Pixel Drawing Grid */}
          <div className="flex flex-col items-center">
            {/* Tool Bar */}
            <div className="flex items-center gap-1.5 mb-3 bg-[#f6f3ec] p-1 rounded-xl border border-[#ded7ca]">
              <button
                type="button"
                onClick={() => setTool('pencil')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                  tool === 'pencil'
                    ? 'bg-[#ffffff] text-[#153641] shadow-xs border border-[#ded7ca]'
                    : 'text-[#71828a] hover:text-[#1b2930]'
                }`}
              >
                <Paintbrush className="w-3.5 h-3.5 text-[#c86443]" />
                <span>Pencil (White)</span>
              </button>
              <button
                type="button"
                onClick={() => setTool('eraser')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                  tool === 'eraser'
                    ? 'bg-[#ffffff] text-[#153641] shadow-xs border border-[#ded7ca]'
                    : 'text-[#71828a] hover:text-[#1b2930]'
                }`}
              >
                <Eraser className="w-3.5 h-3.5 text-[#5b8e85]" />
                <span>Eraser</span>
              </button>
              <button
                type="button"
                onClick={handleInvert}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-[#71828a] hover:text-[#1b2930] hover:bg-[#ffffff] transition-colors"
                title="Invert Colors"
              >
                Invert
              </button>
              <button
                type="button"
                onClick={handleClear}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"
                title="Clear All Pixels"
              >
                Clear
              </button>
            </div>

            {/* Grid Container */}
            <div
              className="grid gap-[1px] bg-[#24323a] p-1 rounded-lg border-2 border-[#153641] shadow-inner select-none cursor-crosshair"
              style={{
                gridTemplateColumns: `repeat(${width}, 8px)`,
                gridTemplateRows: `repeat(${height}, 8px)`,
              }}
              onMouseDown={() => setIsDrawing(true)}
              onMouseUp={() => setIsDrawing(false)}
              onMouseLeave={() => setIsDrawing(false)}
            >
              {pixels.map((p, idx) => (
                <div
                  key={idx}
                  onMouseDown={() => handlePixelInteract(idx)}
                  onMouseEnter={() => {
                    if (isDrawing) handlePixelInteract(idx);
                  }}
                  className={`w-2 h-2 transition-colors duration-75 ${
                    p === 1 ? 'bg-[#ffffff]' : 'bg-[#04070a]'
                  }`}
                />
              ))}
            </div>

            <span className="text-[10px] text-[#71828a] mt-2 font-mono">
              Click & drag to draw · 32x32 Pixels (1024 dots)
            </span>
          </div>

          {/* Right Column: Live Previews & Microcontroller Code */}
          <div className="flex-1 flex flex-col gap-4">
            {/* Graphic Name Input */}
            <div>
              <label className="text-xs font-bold text-[#1b2930] block mb-1">Graphic Label</label>
              <input
                type="text"
                value={graphicName}
                onChange={(e) => setGraphicName(e.target.value)}
                maxLength={30}
                className="w-full px-3 py-1.5 text-xs bg-[#faf8f5] border border-[#ded7ca] rounded-xl font-medium focus:outline-hidden focus:border-[#c86443]"
              />
            </div>

            {/* Hardware Live Preview */}
            <div className="bg-[#faf8f5] p-3 rounded-xl border border-[#ded7ca]">
              <span className="text-[10px] font-bold text-[#71828a] uppercase tracking-wider block mb-2">
                Monochrome OLED Live Preview (1x & 2x)
              </span>
              <div className="flex items-center gap-4">
                <div className="p-2 rounded-lg bg-[#04070a] border border-[#24323a] inline-flex items-center justify-center">
                  <canvas ref={previewCanvasRef} width={64} height={64} className="rounded" />
                </div>
                <div className="flex flex-col text-xs text-[#5a6a72]">
                  <span className="font-bold text-[#1b2930]">{graphicName}</span>
                  <span className="text-[11px] font-mono mt-0.5">Hardware: SSD1306 Monochrome</span>
                  <span className="text-[10px] text-[#5b8e85] mt-1 font-semibold">
                    100% Crisp White on Deep Black
                  </span>
                </div>
              </div>
            </div>

            {/* Presets */}
            <div>
              <span className="text-[10px] font-bold text-[#71828a] uppercase tracking-wider block mb-1.5">
                Quick Presets
              </span>
              <div className="grid grid-cols-2 gap-1.5">
                {PRESET_GRAPHICS.map((p, idx) => (
                  <button
                    key={p.name}
                    type="button"
                    onClick={() => handleApplyPreset(idx)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-[#ffffff] hover:bg-[#faf7f2] border border-[#ded7ca] rounded-xl text-[#1b2930] font-medium transition-colors text-left"
                  >
                    <Sparkles className="w-3 h-3 text-[#c86443] shrink-0" />
                    <span className="truncate">{p.name}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Microcontroller Firmware C Code Export */}
            <div className="pt-2 border-t border-[#f0ebdf]">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-bold text-[#71828a] uppercase tracking-wider">
                  C Byte Array (Pico / QMK / Arduino)
                </span>
                <button
                  type="button"
                  onClick={handleCopyCode}
                  className="flex items-center gap-1 text-[11px] font-bold text-[#c86443] hover:text-[#b25536] transition-colors"
                >
                  {copiedCode ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-600" />
                      <span className="text-emerald-600">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Copy C Code</span>
                    </>
                  )}
                </button>
              </div>
              <div className="p-2 bg-[#04070a] rounded-xl border border-[#24323a] font-mono text-[10px] text-[#ffffff] max-h-24 overflow-y-auto">
                <pre>{generateCArray()}</pre>
              </div>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-[#f0ebdf] bg-[#faf8f5]">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-[#5a6a72] hover:bg-[#ede7da] transition-colors"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={handleSaveAndApply}
            className="px-4 py-2 rounded-xl text-xs font-bold bg-[#c86443] hover:bg-[#b25536] text-white shadow-xs transition-colors flex items-center gap-1.5"
          >
            <Check className="w-3.5 h-3.5" />
            <span>Apply to OLED Screen</span>
          </button>
        </div>
      </div>
    </div>
  );
};
