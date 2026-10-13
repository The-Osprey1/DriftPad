import React, { useState, useEffect, useRef } from 'react';
import { Sliders, Zap, Activity, Play, RotateCcw } from 'lucide-react';

interface RapidTriggerTuningProps {
  actuation: number;
  rtSens: number;
  rtEnabled: boolean;
  selectedSimKey: number;
  currentSimTravel: number;
  isSimPressed: boolean;
  onActuationChange: (val: number) => void;
  onRtSensChange: (val: number) => void;
  onRtToggle: (enabled: boolean) => void;
  onSimTravelChange: (keyIdx: number, travelMm: number) => void;
  onSelectSimKey: (keyIdx: number) => void;
}

export const RapidTriggerTuning: React.FC<RapidTriggerTuningProps> = ({
  actuation,
  rtSens,
  rtEnabled,
  selectedSimKey,
  currentSimTravel,
  isSimPressed,
  onActuationChange,
  onRtSensChange,
  onRtToggle,
  onSimTravelChange,
  onSelectSimKey,
}) => {
  const [animating, setAnimating] = useState<boolean>(false);
  const animIntervalRef = useRef<number | null>(null);

  // Percentage for track positions (0 to 4.0mm)
  const actPct = (actuation / 4.0) * 100;
  const travelPct = Math.min(100, Math.max(0, (currentSimTravel / 4.0) * 100));

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
        onSimTravelChange(selectedSimKey, steps[stepIdx]);
        stepIdx++;
      } else {
        if (animIntervalRef.current) clearInterval(animIntervalRef.current);
        animIntervalRef.current = null;
        setAnimating(false);
      }
    }, intervalMs);
  };

  // Test pattern 1: Quick Tap
  const handleQuickTap = () => {
    const steps: number[] = [
      0.0, 0.4, 0.9, 1.5, 2.1, 2.6, 2.2, 1.6, 0.8, 0.2, 0.0
    ];
    runAnimation(steps, 35);
  };

  // Test pattern 2: Rapid Trigger Jiggle / Flutter
  // Shows that at 2.5mm depth, raising by only rtSens causes release, and dropping by rtSens re-actuates!
  const handleRtJiggle = () => {
    const downToMid = [0.5, 1.2, 2.0, 2.6];
    const jiggles = [
      2.6 - (rtSens + 0.05), // Release!
      2.6 + 0.1,             // Re-actuate!
      2.6 - (rtSens + 0.05), // Release!
      2.6 + 0.1,             // Re-actuate!
      2.6 - (rtSens + 0.05), // Release!
      2.6 + 0.1,             // Re-actuate!
      1.5, 0.5, 0.0          // Return to top
    ];
    runAnimation([...downToMid, ...jiggles], 80);
  };

  // Test pattern 3: Deep Bottom Out
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
    <div className="flex flex-col gap-5">
      {/* Actuation Point Slider */}
      <div className="flex flex-col gap-2 bg-[#181c27] p-4 rounded-xl border border-[#2d3748]">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-[#00f2fe]" />
            <span className="text-sm font-bold text-[#f3f4f6]">Actuation Point</span>
          </div>
          <span className="font-mono text-base font-bold text-[#00f2fe] bg-[#0f1117] px-2.5 py-0.5 rounded border border-[#2d3748]">
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
          className="w-full accent-[#00f2fe] cursor-pointer h-2 bg-[#222738] rounded-lg"
        />

        <div className="flex justify-between items-center text-[11px] text-[#9ca3af]">
          <span>0.10 mm (Hair Trigger)</span>
          <div className="flex gap-1.5">
            {[0.4, 1.2, 2.0].map((preset) => (
              <button
                key={preset}
                onClick={() => onActuationChange(preset)}
                className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                  Math.abs(actuation - preset) < 0.01
                    ? 'bg-[#00f2fe]/20 text-[#00f2fe] border-[#00f2fe]'
                    : 'bg-[#222738] text-[#9ca3af] border-[#2d3748] hover:text-white'
                }`}
              >
                {preset.toFixed(1)}mm
              </button>
            ))}
          </div>
          <span>3.80 mm (Deep)</span>
        </div>
      </div>

      {/* Rapid Trigger Sensitivity Slider */}
      <div className="flex flex-col gap-2 bg-[#181c27] p-4 rounded-xl border border-[#2d3748]">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-[#00f2fe]" />
            <span className="text-sm font-bold text-[#f3f4f6]">Rapid Trigger Sensitivity</span>
          </div>
          <span className="font-mono text-base font-bold text-[#00f2fe] bg-[#0f1117] px-2.5 py-0.5 rounded border border-[#2d3748]">
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
          className="w-full accent-[#00f2fe] cursor-pointer h-2 bg-[#222738] rounded-lg"
        />

        <div className="flex justify-between items-center text-[11px] text-[#9ca3af]">
          <span>0.10 mm (Pro Twitch)</span>
          <div className="flex gap-1.5">
            {[0.15, 0.2, 0.5].map((preset) => (
              <button
                key={preset}
                onClick={() => onRtSensChange(preset)}
                className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                  Math.abs(rtSens - preset) < 0.01
                    ? 'bg-[#00f2fe]/20 text-[#00f2fe] border-[#00f2fe]'
                    : 'bg-[#222738] text-[#9ca3af] border-[#2d3748] hover:text-white'
                }`}
              >
                {preset.toFixed(2)}mm
              </button>
            ))}
          </div>
          <span>2.00 mm (Soft)</span>
        </div>
      </div>

      {/* Rapid Trigger Enable Toggle */}
      <div className="flex items-center justify-between p-4 bg-[#181c27] rounded-xl border border-[#2d3748]">
        <div className="flex flex-col">
          <span className="text-sm font-bold text-[#f3f4f6] flex items-center gap-2">
            Rapid Trigger Mode
            {rtEnabled ? (
              <span className="text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full font-bold">
                ACTIVE
              </span>
            ) : (
              <span className="text-[10px] bg-gray-500/20 text-gray-400 border border-gray-500/30 px-2 py-0.5 rounded-full font-bold">
                DISABLED
              </span>
            )}
          </span>
          <span className="text-xs text-[#9ca3af] mt-0.5">
            Instant reset &amp; re-actuation anywhere along stem travel without fixed return point.
          </span>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={rtEnabled}
            onChange={(e) => onRtToggle(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-12 h-6 bg-[#222738] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[3px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#00f2fe] shadow-inner"></div>
        </label>
      </div>

      {/* Software Switch Stem Simulator Sandbox */}
      <div className="flex flex-col gap-3.5 p-4 bg-[#11141d] rounded-xl border border-[#2d3748] shadow-inner">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#00f2fe]" />
            <span className="text-sm font-bold text-[#f3f4f6]">Switch Stem Simulator</span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-[#9ca3af]">Target Key:</span>
            <select
              value={selectedSimKey}
              onChange={(e) => onSelectSimKey(parseInt(e.target.value, 10))}
              className="bg-[#181c27] text-white border border-[#2d3748] rounded px-2 py-0.5 text-xs font-mono focus:outline-none focus:border-[#00f2fe]"
            >
              {Array.from({ length: 16 }).map((_, i) => (
                <option key={i} value={i}>
                  Key #{i}
                </option>
              ))}
            </select>
            <span
              className={`text-xs px-2 py-0.5 rounded font-mono font-bold ${
                isSimPressed
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : 'bg-gray-800 text-gray-400 border border-gray-700'
              }`}
            >
              {isSimPressed ? 'PRESSED' : 'RELEASED'}
            </span>
          </div>
        </div>

        {/* Stem Cross-Section Graphic */}
        <div className="relative h-14 bg-[#181c27] rounded-lg border border-[#2d3748] overflow-hidden flex items-center px-3">
          {/* Stem bar moving right */}
          <div
            className={`absolute top-0 bottom-0 left-0 transition-all duration-75 ${
              isSimPressed
                ? 'bg-gradient-to-r from-emerald-600 to-emerald-400 opacity-90'
                : 'bg-gradient-to-r from-blue-600 to-[#00f2fe] opacity-80'
            }`}
            style={{ width: `${travelPct}%` }}
          />

          {/* Actuation point marker line */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-[#f59e0b] shadow-[0_0_8px_#f59e0b] z-10"
            style={{ left: `${actPct}%` }}
          />

          {/* Labels inside cutaway */}
          <div className="relative z-20 w-full flex justify-between items-center font-mono text-xs font-bold drop-shadow">
            <span className="text-white/80">0.0 mm</span>
            <span className="text-white font-bold bg-black/60 px-2 py-0.5 rounded border border-white/20">
              Travel: {currentSimTravel.toFixed(2)} mm
            </span>
            <span className="text-white/80">4.0 mm</span>
          </div>
        </div>

        {/* Travel Manual Slider */}
        <div className="flex flex-col gap-1">
          <input
            type="range"
            min="0.00"
            max="4.00"
            step="0.02"
            value={currentSimTravel}
            disabled={animating}
            onChange={(e) => onSimTravelChange(selectedSimKey, parseFloat(e.target.value))}
            className="w-full accent-[#00f2fe] cursor-pointer h-2 bg-[#222738] rounded-lg"
          />
          <div className="flex justify-between text-[10px] text-[#9ca3af]">
            <span>0.0mm (Rest)</span>
            <span className="text-[#f59e0b] font-medium">▲ Actuation ({actuation.toFixed(2)}mm)</span>
            <span>4.0mm (Bottom Out)</span>
          </div>
        </div>

        {/* Automated Simulation Presets */}
        <div className="flex flex-wrap gap-2 pt-1 border-t border-[#2d3748]">
          <button
            onClick={handleQuickTap}
            disabled={animating}
            className="flex-1 py-1.5 px-2 bg-[#222738] hover:bg-[#2d3748] text-white rounded text-xs font-medium flex items-center justify-center gap-1 border border-[#2d3748] transition-colors"
          >
            <Play className="w-3 h-3 text-[#00f2fe]" /> Quick Tap
          </button>
          <button
            onClick={handleRtJiggle}
            disabled={animating}
            className="flex-1 py-1.5 px-2 bg-[#222738] hover:bg-[#2d3748] text-white rounded text-xs font-medium flex items-center justify-center gap-1 border border-[#2d3748] transition-colors"
          >
            <Zap className="w-3 h-3 text-emerald-400" /> RT Flutter
          </button>
          <button
            onClick={handleBottomOut}
            disabled={animating}
            className="flex-1 py-1.5 px-2 bg-[#222738] hover:bg-[#2d3748] text-white rounded text-xs font-medium flex items-center justify-center gap-1 border border-[#2d3748] transition-colors"
          >
            Bottom Out
          </button>
          <button
            onClick={handleResetTravel}
            className="py-1.5 px-2.5 bg-[#222738] hover:bg-[#2d3748] text-[#9ca3af] hover:text-white rounded text-xs flex items-center justify-center border border-[#2d3748] transition-colors"
            title="Release to Rest"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
};
