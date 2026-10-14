import React, { useState, useRef, useEffect } from 'react';
import { EncoderConfig, EncoderAction } from '../types/driftpad';
import { Disc3, RotateCw, RotateCcw, MousePointer } from 'lucide-react';
import { HoverExplain } from './HoverExplain';

interface RotaryEncoderDialProps {
  config: EncoderConfig;
  variant?: 'full' | 'dialOnly' | 'actionsOnly';
  onUpdateConfig: (newConfig: EncoderConfig) => void;
  onTriggerAction: (action: EncoderAction, direction: 'cw' | 'ccw' | 'click') => void;
}

const PRESET_ENCODER_CONFIGS: { name: string; config: EncoderConfig }[] = [
  {
    name: 'Timeline Frame Jog (Video)',
    config: {
      name: 'Timeline Frame Jog',
      cw: { label: 'Jog Right (+1 Frame)', actionType: 'scrub', code: 215, delta: 1, description: 'Right Arrow' },
      ccw: { label: 'Jog Left (-1 Frame)', actionType: 'scrub', code: 216, delta: -1, description: 'Left Arrow' },
      click: { label: 'Play / Pause', actionType: 'key', code: 32, description: 'Spacebar' }
    }
  },
  {
    name: 'Master Volume & Mute',
    config: {
      name: 'Volume & Mute',
      cw: { label: 'Volume Up (+2%)', actionType: 'volume', code: 218, delta: 1, description: 'Volume Up' },
      ccw: { label: 'Volume Down (-2%)', actionType: 'volume', code: 217, delta: -1, description: 'Volume Down' },
      click: { label: 'Mute / Unmute', actionType: 'key', code: 109, description: 'Mute Toggle' }
    }
  },
  {
    name: 'Canvas Zoom & Fit (Figma/CAD)',
    config: {
      name: 'Canvas Zoom & Fit',
      cw: { label: 'Zoom In 10%', actionType: 'zoom', delta: 1, description: 'Ctrl + Plus' },
      ccw: { label: 'Zoom Out 10%', actionType: 'zoom', delta: -1, description: 'Ctrl + Minus' },
      click: { label: 'Zoom to 100% / Fit', actionType: 'key', code: 48, modifiers: { shift: true }, description: 'Shift + 0' }
    }
  },
  {
    name: 'Tab Switching (Code)',
    config: {
      name: 'Editor Tab Navigation',
      cw: { label: 'Next Tab', actionType: 'combo', code: 179, modifiers: { ctrl: true }, description: 'Ctrl + Tab' },
      ccw: { label: 'Previous Tab', actionType: 'combo', code: 179, modifiers: { ctrl: true, shift: true }, description: 'Ctrl + Shift + Tab' },
      click: { label: 'Close Active Tab', actionType: 'combo', code: 119, modifiers: { ctrl: true }, description: 'Ctrl + W' }
    }
  },
  {
    name: 'Document Scroll & Top',
    config: {
      name: 'Scroll & Top',
      cw: { label: 'Page Down', actionType: 'scroll', code: 214, description: 'Page Down' },
      ccw: { label: 'Page Up', actionType: 'scroll', code: 211, description: 'Page Up' },
      click: { label: 'Jump to Top (Home)', actionType: 'key', code: 210, description: 'Home Key' }
    }
  }
];

export const RotaryEncoderDial: React.FC<RotaryEncoderDialProps> = ({
  config,
  variant = 'full',
  onUpdateConfig,
  onTriggerAction,
}) => {
  const [angle, setAngle] = useState<number>(0);
  const [stepCount, setStepCount] = useState<number>(0);
  const [lastAction, setLastAction] = useState<string>('Ready');
  const [isPressing, setIsPressing] = useState<boolean>(false);
  const isDraggingRef = useRef<boolean>(false);
  const lastXRef = useRef<number>(0);

  const dialRef = useRef<HTMLDivElement | null>(null);

  // Wheel listener over dial
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY > 0) {
      triggerCw();
    } else {
      triggerCcw();
    }
  };

  const triggerCw = () => {
    setAngle((prev) => (prev + 15) % 360);
    setStepCount((prev) => prev + 1);
    setLastAction(`CW -> ${config.cw.label}`);
    onTriggerAction(config.cw, 'cw');
  };

  const triggerCcw = () => {
    setAngle((prev) => (prev - 15 + 360) % 360);
    setStepCount((prev) => prev - 1);
    setLastAction(`CCW <- ${config.ccw.label}`);
    onTriggerAction(config.ccw, 'ccw');
  };

  const triggerClick = () => {
    setIsPressing(true);
    setLastAction(`CLICK -> ${config.click.label}`);
    onTriggerAction(config.click, 'click');
    setTimeout(() => setIsPressing(false), 200);
  };

  // Drag interaction
  const handleMouseDown = (e: React.MouseEvent) => {
    isDraggingRef.current = true;
    lastXRef.current = e.clientX;
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const deltaX = e.clientX - lastXRef.current;
      if (Math.abs(deltaX) > 10) {
        if (deltaX > 0) {
          triggerCw();
        } else {
          triggerCcw();
        }
        lastXRef.current = e.clientX;
      }
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [config]);

  const handleSelectPreset = (pConfig: EncoderConfig) => {
    onUpdateConfig(pConfig);
  };

  // Dial Visualizer Sub-component
  const dialVisualizer = (
    <div className="flex flex-col items-center justify-between p-3.5 bg-[#ede8df] rounded-2xl border border-[#d5ccc0] shadow-inner h-full">
      <div
        ref={dialRef}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        className="relative w-28 h-28 sm:w-32 sm:h-32 rounded-full bg-[#ffffff] border-2 border-[#d5ccc0] flex items-center justify-center cursor-ew-resize select-none active:scale-95 transition-transform shadow-md my-auto"
        title="Drag left/right or scroll mouse wheel to rotate dial"
      >
        {/* Outer Knurled Notches */}
        {Array.from({ length: 24 }).map((_, i) => (
          <div
            key={i}
            className="absolute w-1 h-2 bg-[#d5ccc0] rounded-full"
            style={{
              top: '4px',
              transformOrigin: 'bottom center',
              transform: `rotate(${i * 15}deg) translateY(0px)`,
            }}
          />
        ))}

        {/* Rotating Rotor */}
        <div
          className="relative w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-[#f5f2eb] border border-[#d5ccc0] flex items-center justify-center transition-transform duration-75 shadow-inner"
          style={{ transform: `rotate(${angle}deg)` }}
        >
          {/* Dial Indicator Pip */}
          <div className="absolute top-1.5 w-2 h-3.5 rounded-full bg-[#9e5b3d] shadow-sm" />
          <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-[#ffffff] border border-[#e5dfd5] flex items-center justify-center text-[10px] font-mono font-bold text-[#84949b]">
            {Math.round(angle)}°
          </div>
        </div>
      </div>

      <div className="mt-2.5 flex flex-col items-center gap-1.5 w-full">
        <button
          onClick={triggerClick}
          className={`w-full py-1.5 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all shadow-xs ${
            isPressing
              ? 'bg-[#9e5b3d] text-white scale-95 shadow-inner'
              : 'bg-[#ffffff] hover:bg-[#faf8f5] text-[#1c282e] border border-[#d5ccc0]'
          }`}
        >
          <MousePointer className="w-3.5 h-3.5 text-[#9e5b3d]" />
          <span>Press Knob (Click)</span>
        </button>

        <div className="text-[10px] font-mono text-[#57676e] truncate max-w-full text-center">
          {lastAction}
        </div>
      </div>
    </div>
  );

  // If dialOnly is requested (for physical chassis top-deck)
  if (variant === 'dialOnly') {
    return (
      <div className="flex flex-col gap-2.5 bg-[#ffffff] border border-[#e5dfd5] rounded-2xl p-3.5 sm:p-4 shadow-sm h-full">
        <div className="flex justify-between items-center border-b border-[#e5dfd5] pb-2">
          <div className="flex items-center gap-1.5">
            <Disc3 className="w-3.5 h-3.5 text-[#9e5b3d]" />
            <span className="text-xs font-bold text-[#1c282e]">Rotary Dial</span>
            <HoverExplain
              title="Rotary Encoder"
              badge="Hardware Knob"
              explanation="24 detents per turn. Drag left/right or scroll mouse wheel to rotate; click to push."
            />
          </div>
          <span className="text-[10px] font-mono text-[#57676e] tabular-nums">
            {stepCount} steps
          </span>
        </div>
        {dialVisualizer}
      </div>
    );
  }

  // Full or Actions-Only Configuration View
  return (
    <div className="flex flex-col gap-3.5 bg-[#faf8f5] border border-[#e5dfd5] rounded-xl p-4">
      <div className="flex justify-between items-center border-b border-[#e5dfd5] pb-2.5">
        <div className="flex items-center gap-2">
          <Disc3 className="w-3.5 h-3.5 text-[#9e5b3d]" />
          <span className="text-xs font-bold text-[#1c282e]">
            Hardware Rotary Encoder
          </span>
          <HoverExplain
            title="Rotary Encoder"
            badge="Hardware Dial"
            explanation="The metal rotary knob has 24 tactile detents per turn. It supports separate actions for turning clockwise (CW), counter-clockwise (CCW), and pressing straight down (Click)."
            tip="Drag left/right on the dial, or use your mouse scroll wheel over it to test."
          />
        </div>
        <span className="text-xs font-mono text-[#57676e] tabular-nums">
          Steps: <strong className="text-[#1c282e]">{stepCount}</strong>
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
        {/* Left: Interactive Rotary Dial Visualizer (5 cols) */}
        {variant !== 'actionsOnly' && (
          <div className="md:col-span-5 h-full">
            {dialVisualizer}
          </div>
        )}

        {/* Right: Actions Configuration & Presets */}
        <div className={variant === 'actionsOnly' ? 'col-span-12 flex flex-col gap-3' : 'md:col-span-7 flex flex-col gap-3'}>
          {/* Quick Preset Selector */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-bold text-[#57676e]">Dial Presets:</span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {PRESET_ENCODER_CONFIGS.map((p) => {
                const isSelected = config.name === p.config.name;
                return (
                  <button
                    key={p.name}
                    onClick={() => handleSelectPreset(p.config)}
                    className={`p-2 rounded-xl text-left text-xs border transition-colors shadow-xs ${
                      isSelected
                        ? 'bg-[#9e5b3d]/15 text-[#1c282e] border-[#9e5b3d] font-bold'
                        : 'bg-[#ffffff] text-[#1c282e] border-[#e5dfd5] hover:border-[#9e5b3d]/50'
                    }`}
                  >
                    <div className="truncate font-semibold">{p.name}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Action Slots Display */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {/* Clockwise Action */}
            <div className="bg-[#ffffff] p-2.5 rounded-xl border border-[#e5dfd5] flex flex-col justify-between shadow-xs">
              <div>
                <div className="flex items-center gap-1 text-[10px] font-bold text-[#9e5b3d] mb-1">
                  <RotateCw className="w-3 h-3" /> Right (CW)
                </div>
                <div className="text-xs font-bold text-[#1c282e] leading-tight">
                  {config.cw.label}
                </div>
                <div className="text-[10px] text-[#57676e] mt-0.5">
                  {config.cw.description}
                </div>
              </div>
              <button
                onClick={triggerCw}
                className="mt-2 py-1 px-2 bg-[#faf8f5] hover:bg-[#f2ece2] text-[10px] font-semibold text-[#1c282e] rounded-lg border border-[#e5dfd5] transition-colors"
              >
                Test CW
              </button>
            </div>

            {/* Counter-Clockwise Action */}
            <div className="bg-[#ffffff] p-2.5 rounded-xl border border-[#e5dfd5] flex flex-col justify-between shadow-xs">
              <div>
                <div className="flex items-center gap-1 text-[10px] font-bold text-[#71938c] mb-1">
                  <RotateCcw className="w-3 h-3" /> Left (CCW)
                </div>
                <div className="text-xs font-bold text-[#1c282e] leading-tight">
                  {config.ccw.label}
                </div>
                <div className="text-[10px] text-[#57676e] mt-0.5">
                  {config.ccw.description}
                </div>
              </div>
              <button
                onClick={triggerCcw}
                className="mt-2 py-1 px-2 bg-[#faf8f5] hover:bg-[#f2ece2] text-[10px] font-semibold text-[#1c282e] rounded-lg border border-[#e5dfd5] transition-colors"
              >
                Test CCW
              </button>
            </div>

            {/* Push Click Action */}
            <div className="bg-[#ffffff] p-2.5 rounded-xl border border-[#e5dfd5] flex flex-col justify-between shadow-xs">
              <div>
                <div className="flex items-center gap-1 text-[10px] font-bold text-[#1e3f48] mb-1">
                  <MousePointer className="w-3 h-3 text-[#1e3f48]" /> Push (Click)
                </div>
                <div className="text-xs font-bold text-[#1c282e] leading-tight">
                  {config.click.label}
                </div>
                <div className="text-[10px] text-[#57676e] mt-0.5">
                  {config.click.description}
                </div>
              </div>
              <button
                onClick={triggerClick}
                className="mt-2 py-1 px-2 bg-[#faf8f5] hover:bg-[#f2ece2] text-[10px] font-semibold text-[#1e3f48] rounded-lg border border-[#e5dfd5] transition-colors"
              >
                Test Click
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
