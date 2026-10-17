import React, { useState, useEffect, useRef } from 'react';
import { Sliders, Zap, Activity, Play, RotateCcw, ShieldAlert, LineChart } from 'lucide-react';
import { HoverExplain } from './HoverExplain';
import { soundService } from '../services/soundService';

interface RapidTriggerTuningProps {
  actuation: number;
  rtSens: number;
  rtEnabled: boolean;
  selectedSimKey: number;
  currentSimTravel: number;
  isSimPressed: boolean;
  customKeyActuation?: number;
  onActuationChange: (val: number) => void;
  onRtSensChange: (val: number) => void;
  onRtToggle: (enabled: boolean) => void;
  onSimTravelChange: (keyIdx: number, travelMm: number) => void;
  onSelectSimKey: (keyIdx: number) => void;
}

const PRODUCTIVITY_TUNING_PRESETS = [
  { name: 'Fluid Hotkeys', act: 1.20, sens: 0.20, rt: true, desc: 'Balanced response for code & hotkeys' },
  { name: 'Deliberate Entry', act: 1.80, sens: 0.35, rt: false, desc: 'Prevents accidental mis-strokes' },
  { name: 'Feather Scrub', act: 0.60, sens: 0.15, rt: true, desc: 'Instant response for timeline jog' },
  { name: 'Deep Safety', act: 2.50, sens: 0.40, rt: true, desc: 'Deep engagement for destructive actions' },
];

export const RapidTriggerTuning: React.FC<RapidTriggerTuningProps> = ({
  actuation,
  rtSens,
  rtEnabled,
  selectedSimKey,
  currentSimTravel,
  isSimPressed,
  customKeyActuation,
  onActuationChange,
  onRtSensChange,
  onRtToggle,
  onSimTravelChange,
  onSelectSimKey,
}) => {
  const [animating, setAnimating] = useState<boolean>(false);
  const animIntervalRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const historyRef = useRef<{ travel: number; pressed: boolean }[]>([]);

  const effectiveActuation = customKeyActuation !== undefined ? customKeyActuation : actuation;
  const actPct = (effectiveActuation / 4.0) * 100;
  const travelPct = Math.min(100, Math.max(0, (currentSimTravel / 4.0) * 100));

  // Live Oscilloscope Waveform Stream
  useEffect(() => {
    let animId: number;

    const renderOscilloscope = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const w = canvas.width;
      const h = canvas.height;

      // Append current point to history
      historyRef.current.push({ travel: currentSimTravel, pressed: isSimPressed });
      if (historyRef.current.length > w) {
        historyRef.current.shift();
      }

      ctx.clearRect(0, 0, w, h);

      // Background grid
      ctx.fillStyle = '#f5efe6';
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = '#e6ddce';
      ctx.lineWidth = 1;

      // 1mm, 2mm, 3mm grid lines
      for (let mm = 1; mm <= 3; mm++) {
        const y = (mm / 4.0) * h;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Actuation threshold line (Terracotta)
      const actY = (effectiveActuation / 4.0) * h;
      ctx.strokeStyle = '#c86443';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(0, actY);
      ctx.lineTo(w, actY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label on right edge
      ctx.fillStyle = '#c86443';
      ctx.font = 'bold 8px monospace';
      ctx.fillText(`${effectiveActuation.toFixed(1)}mm ACT`, w - 55, Math.max(9, actY - 3));

      // Waveform line
      const pts = historyRef.current;
      if (pts.length > 1) {
        ctx.beginPath();
        const startX = w - pts.length;
        pts.forEach((p, idx) => {
          const x = startX + idx;
          const y = (p.travel / 4.0) * h;
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });

        ctx.strokeStyle = isSimPressed ? '#c86443' : '#5b8e85';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Shaded area under curve
        ctx.lineTo(w, 0);
        ctx.lineTo(startX, 0);
        ctx.fillStyle = isSimPressed ? 'rgba(200, 100, 67, 0.12)' : 'rgba(91, 142, 133, 0.10)';
        ctx.fill();

        // Current head dot
        const headY = (currentSimTravel / 4.0) * h;
        ctx.fillStyle = isSimPressed ? '#c86443' : '#153641';
        ctx.beginPath();
        ctx.arc(w - 2, headY, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      animId = requestAnimationFrame(renderOscilloscope);
    };

    animId = requestAnimationFrame(renderOscilloscope);

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [currentSimTravel, isSimPressed, effectiveActuation]);

  useEffect(() => {
    return () => {
      if (animIntervalRef.current) clearInterval(animIntervalRef.current);
    };
  }, []);

  const runAnimation = (steps: number[], intervalMs: number = 40) => {
    if (animIntervalRef.current) clearInterval(animIntervalRef.current);
    setAnimating(true);
    let stepIdx = 0;
    animIntervalRef.current = window.setInterval(() => {
      if (stepIdx < steps.length) {
        const val = steps[stepIdx];
        onSimTravelChange(selectedSimKey, val);
        if (val >= effectiveActuation && stepIdx === 3) {
          soundService.playSwitchDown(val, val >= 3.8);
        }
        stepIdx++;
      } else {
        if (animIntervalRef.current) clearInterval(animIntervalRef.current);
        animIntervalRef.current = null;
        setAnimating(false);
      }
    }, intervalMs);
  };

  const handleQuickTap = () => {
    const target = effectiveActuation + 0.6;
    const steps: number[] = [0.0, target * 0.3, target * 0.7, target, target * 1.1, target * 0.8, target * 0.4, 0.0];
    runAnimation(steps, 40);
  };

  const handleRtJiggle = () => {
    const base = Math.max(effectiveActuation + 0.4, 2.0);
    const downToMid = [0.5, 1.2, base];
    const jiggles = [
      base - (rtSens + 0.05),
      base + 0.1,
      base - (rtSens + 0.05),
      base + 0.1,
      base - (rtSens + 0.05),
      base + 0.1,
      0.8, 0.0
    ];
    runAnimation([...downToMid, ...jiggles], 70);
  };

  const handleBottomOut = () => {
    const steps = [0.5, 1.2, 2.0, 3.0, 3.8, 4.0];
    runAnimation(steps, 45);
  };

  const handleResetTravel = () => {
    if (animIntervalRef.current) clearInterval(animIntervalRef.current);
    setAnimating(false);
    onSimTravelChange(selectedSimKey, 0.0);
  };

  return (
    <div className="flex flex-col gap-3.5">
      {/* Presets Grid */}
      <div className="flex flex-col gap-2 bg-[#faf8f5] p-3.5 rounded-xl border border-[#e5dfd5]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-bold text-[#1c282e]">Tuning Presets</span>
            <HoverExplain
              title="DSP Tuning Presets"
              badge="Profiles"
              explanation="Pre-calibrated sensitivity profiles matching different use cases: Deliberate Entry for numerical spreadsheets, Fluid Hotkeys for fast macros, and Feather Scrub for dial/scrub actions."
            />
          </div>
          <span className="text-[10px] text-[#84949b] font-mono">16 Hall Sensors</span>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          {PRODUCTIVITY_TUNING_PRESETS.map((p) => {
            const isMatch =
              Math.abs(actuation - p.act) < 0.05 &&
              Math.abs(rtSens - p.sens) < 0.05 &&
              rtEnabled === p.rt;
            return (
              <button
                key={p.name}
                onClick={() => {
                  onActuationChange(p.act);
                  onRtSensChange(p.sens);
                  onRtToggle(p.rt);
                }}
                className={`p-2.5 rounded-xl border text-left transition-colors shadow-xs ${
                  isMatch
                    ? 'bg-[#c86443]/10 text-[#1b2930] border-[#c86443] font-bold'
                    : 'bg-[#ffffff] text-[#1b2930] border-[#ded7ca] hover:border-[#c86443]/40'
                }`}
              >
                <div className="text-xs font-bold">{p.name}</div>
                <div className="text-[10px] text-[#5a6a72] font-mono mt-0.5 tabular-nums">
                  Act {p.act.toFixed(2)}mm · RT {p.rt ? `${p.sens.toFixed(2)}mm` : 'OFF'}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Global Actuation Slider */}
      <div className="flex flex-col gap-2 bg-[#faf8f5] p-3.5 rounded-xl border border-[#ded7ca]">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-1.5">
            <Sliders className="w-3.5 h-3.5 text-[#c86443]" />
            <span className="text-xs font-bold text-[#1b2930]">Actuation Point</span>
            <HoverExplain
              title="Actuation Point"
              badge="Hardware Travel"
              explanation="The initial distance the key switch must be pressed down before sending a keystroke. Lower numbers (0.1mm-1.0mm) respond with ultra-light touch; higher numbers (2.0mm-3.8mm) require deliberate intent."
              tip="If you experience accidental mis-types, increase actuation to 1.5mm - 2.0mm."
            />
          </div>
          <span className="font-mono text-xs font-bold text-[#c86443] bg-[#ffffff] px-2.5 py-0.5 rounded-lg border border-[#ded7ca] tabular-nums shadow-xs">
            {actuation.toFixed(2)} mm
          </span>
        </div>

        <input
          type="range"
          min="0.10"
          max="3.80"
          step="0.05"
          value={actuation}
          onChange={(e) => onActuationChange(parseFloat(e.target.value))}
          className="w-full accent-[#c86443] cursor-pointer h-2 bg-[#ded7ca] rounded-lg"
        />

        <div className="flex justify-between items-center text-[10px] text-[#71828a] font-mono tabular-nums">
          <span>0.10 mm (Hair Trigger)</span>
          <span>3.80 mm (Deep Stroke)</span>
        </div>
      </div>

      {/* Rapid Trigger Sensitivity */}
      <div className="flex flex-col gap-2 bg-[#faf8f5] p-3.5 rounded-xl border border-[#ded7ca]">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-[#5b8e85]" />
            <span className="text-xs font-bold text-[#1b2930]">Rapid Trigger Sensitivity</span>
            <HoverExplain
              title="Rapid Trigger Sensitivity"
              badge="Dynamic Reset"
              explanation="The micro-distance the key must lift up before instantly deactivating. Once lifted by this amount (e.g. 0.25mm), the switch resets immediately, allowing rapid repeated presses without returning to the top."
              tip="Set to 0.15mm - 0.25mm for fast double-taps on calculator or numpad entries."
            />
          </div>
          <span className="font-mono text-xs font-bold text-[#153641] bg-[#ffffff] px-2.5 py-0.5 rounded-lg border border-[#ded7ca] tabular-nums shadow-xs">
            {rtSens.toFixed(2)} mm
          </span>
        </div>

        <input
          type="range"
          min="0.10"
          max="2.00"
          step="0.05"
          value={rtSens}
          onChange={(e) => onRtSensChange(parseFloat(e.target.value))}
          className="w-full accent-[#5b8e85] cursor-pointer h-2 bg-[#ded7ca] rounded-lg"
        />

        <div className="flex justify-between items-center text-[10px] text-[#71828a] font-mono tabular-nums">
          <span>0.10 mm (Instant Reset)</span>
          <span>2.00 mm (Soft Cushion)</span>
        </div>
      </div>

      {/* Rapid Trigger Enable Switch */}
      <div className="flex items-center justify-between p-3.5 bg-[#faf8f5] rounded-xl border border-[#ded7ca]">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-[#1b2930]">Rapid Trigger DSP</span>
            <HoverExplain
              title="Rapid Trigger Mode"
              badge="DSP Filter"
              explanation="When active, the RP2040 DSP tracks the exact velocity and turnaround point of the magnet inside the key switch at 8,000 samples/sec, resetting keystrokes dynamically on release."
            />
            <span
              className={`text-[10px] font-mono font-bold ${
                rtEnabled ? 'text-[#15803d]' : 'text-[#71828a]'
              }`}
            >
              · {rtEnabled ? 'Active' : 'Off'}
            </span>
          </div>
          <span className="text-[11px] text-[#5a6a72] mt-0.5">
            Dynamic reset as soon as key begins upward travel
          </span>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={rtEnabled}
            onChange={(e) => onRtToggle(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-10 h-5 bg-[#ded7ca] peer-focus:outline-hidden rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#5b8e85]"></div>
        </label>
      </div>

      {/* Key Stem Travel Simulator Sandbox */}
      <div className="flex flex-col gap-3 p-3.5 bg-[#faf8f5] rounded-xl border border-[#ded7ca]">
        <div className="flex justify-between items-center flex-wrap gap-2">
          <div className="flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-[#c86443]" />
            <span className="text-xs font-bold text-[#1b2930]">Live Stem Cross-Section</span>
            <HoverExplain
              title="Stem Travel Visualizer"
              badge="Simulation"
              explanation="Simulates the physical depression of the key switch stem into the PCB. The vertical line marks the actuation threshold. Watch it turn terracotta when registered."
            />
          </div>

          <div className="flex items-center gap-2">
            <select
              value={selectedSimKey}
              onChange={(e) => onSelectSimKey(parseInt(e.target.value, 10))}
              className="bg-[#ffffff] text-[#1b2930] border border-[#ded7ca] rounded-lg px-2.5 py-0.5 text-xs font-mono font-semibold focus:outline-hidden focus:border-[#c86443]"
            >
              {Array.from({ length: 16 }).map((_, i) => (
                <option key={i} value={i}>
                  Key #{i}
                </option>
              ))}
            </select>
            <span
              className={`text-[10px] font-mono font-bold ${
                isSimPressed ? 'text-[#c86443]' : 'text-[#71828a]'
              }`}
            >
              · {isSimPressed ? 'Actuated' : 'Rest'}
            </span>
          </div>
        </div>

        {customKeyActuation !== undefined && (
          <div className="flex items-center gap-1.5 text-xs text-[#b45309] bg-amber-500/10 p-2 rounded-lg border border-amber-500/20 font-mono">
            <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
            <span>
              Override: <strong>{customKeyActuation.toFixed(2)} mm</strong>
            </span>
          </div>
        )}

        {/* Stem Cross-Section Graphic */}
        <div className="relative h-11 bg-[#ebe5d9] rounded-xl border border-[#ded7ca] overflow-hidden flex items-center px-3 shadow-inner">
          {/* Active travel fill */}
          <div
            className={`absolute top-0 bottom-0 left-0 transition-all duration-75 ${
              isSimPressed ? 'bg-[#c86443]/40' : 'bg-[#5b8e85]/35'
            }`}
            style={{ width: `${travelPct}%` }}
          />

          {/* Actuation point marker line */}
          <div
            className="absolute top-0 bottom-0 w-1 bg-[#c86443] z-10"
            style={{ left: `${actPct}%` }}
          />

          <div className="relative z-20 w-full flex justify-between items-center font-mono text-[11px] tabular-nums">
            <span className="text-[#71828a]">0.0mm (Rest)</span>
            <span className="text-[#1b2930] font-bold bg-[#ffffff] px-2.5 py-0.5 rounded-lg border border-[#ded7ca] shadow-xs">
              {currentSimTravel.toFixed(2)} mm
            </span>
            <span className="text-[#71828a]">4.0mm (Bottom)</span>
          </div>
        </div>

        {/* Live Displacement Oscilloscope Waveform */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[10px] text-[#71828a] font-mono px-0.5">
            <span className="flex items-center gap-1 font-semibold text-[#153641]">
              <LineChart className="w-3 h-3 text-[#5b8e85]" />
              <span>Real-Time Travel Waveform</span>
            </span>
            <span className="tabular-nums">3s Window · 60 FPS</span>
          </div>
          <div className="relative rounded-xl border border-[#ded7ca] overflow-hidden shadow-inner bg-[#f5efe6]">
            <canvas
              ref={canvasRef}
              width={340}
              height={70}
              className="w-full h-[70px] block"
            />
          </div>
        </div>

        {/* Travel Manual Slider */}
        <input
          type="range"
          min="0.00"
          max="4.00"
          step="0.02"
          value={currentSimTravel}
          disabled={animating}
          onChange={(e) => onSimTravelChange(selectedSimKey, parseFloat(e.target.value))}
          className="w-full accent-[#c86443] cursor-pointer h-2 bg-[#ded7ca] rounded-lg"
        />

        {/* Action buttons */}
        <div className="flex items-center gap-1.5 pt-1 border-t border-[#f0ebdf]">
          <button
            onClick={handleQuickTap}
            disabled={animating}
            className="flex-1 py-1.5 px-2 bg-[#ffffff] hover:bg-[#faf8f5] text-[#1b2930] rounded-xl text-xs font-semibold flex items-center justify-center gap-1 border border-[#ded7ca] transition-colors shadow-xs"
          >
            <Play className="w-3 h-3 text-[#c86443]" /> Quick Tap
          </button>
          <button
            onClick={handleRtJiggle}
            disabled={animating}
            className="flex-1 py-1.5 px-2 bg-[#ffffff] hover:bg-[#faf8f5] text-[#1b2930] rounded-xl text-xs font-semibold flex items-center justify-center gap-1 border border-[#ded7ca] transition-colors shadow-xs"
          >
            <Zap className="w-3 h-3 text-[#5b8e85]" /> Flutter Tap
          </button>
          <button
            onClick={handleBottomOut}
            disabled={animating}
            className="flex-1 py-1.5 px-2 bg-[#ffffff] hover:bg-[#faf8f5] text-[#1b2930] rounded-xl text-xs font-semibold flex items-center justify-center gap-1 border border-[#ded7ca] transition-colors shadow-xs"
          >
            Bottom Out
          </button>
          <button
            onClick={handleResetTravel}
            className="py-1.5 px-2.5 bg-[#ffffff] hover:bg-[#faf8f5] text-[#5a6a72] hover:text-[#1b2930] rounded-xl text-xs flex items-center justify-center border border-[#ded7ca] transition-colors shadow-xs"
            title="Reset to 0mm"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
