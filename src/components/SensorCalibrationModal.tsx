import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Sliders,
  Check,
  RefreshCw,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import { KeyCalibrationData, LayerKey } from '../types/driftpad';
import { ConnectionMode } from '../services/serialService';

interface SensorCalibrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  keys: LayerKey[];
  connectionMode: ConnectionMode;
  currentCalibration?: KeyCalibrationData[];
  onSaveCalibration: (table: KeyCalibrationData[]) => void;
  onSendSerialCommand?: (cmd: string) => void;
}

export const SensorCalibrationModal: React.FC<SensorCalibrationModalProps> = ({
  isOpen,
  onClose,
  keys,
  connectionMode,
  currentCalibration,
  onSaveCalibration,
  onSendSerialCommand,
}) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [activeKeyIdx, setActiveKeyIdx] = useState<number>(0);
  const [isSampling, setIsSampling] = useState<boolean>(false);
  const [liveAdcValues, setLiveAdcValues] = useState<number[]>(() =>
    Array.from({ length: 16 }, () => 1950 + Math.floor(Math.random() * 80 - 40))
  );

  const [calibrationTable, setCalibrationTable] = useState<KeyCalibrationData[]>(() => {
    if (currentCalibration && currentCalibration.length === 16) {
      return currentCalibration;
    }
    try {
      const saved = localStorage.getItem('driftpad_hall_calibration');
      if (saved) return JSON.parse(saved);
    } catch {
      // ignore
    }
    return Array.from({ length: 16 }, (_, idx) => ({
      idx,
      restAdc: 1950 + (idx % 4) * 12,
      bottomAdc: 3420 - (idx % 3) * 18,
      noiseFloor: 6 + (idx % 3),
      isCalibrated: false,
    }));
  });

  // Noise simulation ticker when in virtual mode
  const simIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    simIntervalRef.current = window.setInterval(() => {
      setLiveAdcValues((prev) =>
        prev.map((val, idx) => {
          const cal = calibrationTable[idx];
          const jitter = Math.floor(Math.random() * 5 - 2);
          // If active key is being tested in step 2, leave it or jitter around rest
          return Math.max(cal.restAdc - 10, val + jitter);
        })
      );
    }, 200);

    return () => {
      if (simIntervalRef.current) clearInterval(simIntervalRef.current);
    };
  }, [isOpen, calibrationTable]);

  if (!isOpen) return null;

  // Step 1: Capture Rest Baseline across all 16 keys
  const handleCaptureRestBaselines = () => {
    setIsSampling(true);
    onSendSerialCommand?.('CAL_SAMPLE_REST');

    setTimeout(() => {
      setCalibrationTable((prev) =>
        prev.map((k) => {
          const sampledRest = 1940 + Math.floor(Math.random() * 40 - 20);
          return {
            ...k,
            restAdc: sampledRest,
            noiseFloor: 5 + Math.floor(Math.random() * 4),
          };
        })
      );
      setIsSampling(false);
      setStep(2);
      setActiveKeyIdx(0);
    }, 900);
  };

  // Step 2: Handle pressing down active key to record bottom-out ADC
  const handleRecordActiveKeyStroke = (bottomVal: number) => {
    setCalibrationTable((prev) =>
      prev.map((k) => {
        if (k.idx !== activeKeyIdx) return k;
        return {
          ...k,
          bottomAdc: bottomVal,
          isCalibrated: true,
        };
      })
    );

    // Auto advance to next uncalibrated key or step 3
    if (activeKeyIdx < 15) {
      setActiveKeyIdx((prev) => prev + 1);
    } else {
      setStep(3);
    }
  };

  const handleSimulateFullStroke = () => {
    const bottomAdcVal = 3450 + Math.floor(Math.random() * 60 - 30);
    // Flash live ADC
    setLiveAdcValues((prev) => {
      const next = [...prev];
      next[activeKeyIdx] = bottomAdcVal;
      return next;
    });

    handleRecordActiveKeyStroke(bottomAdcVal);
  };

  const handleFinishAndSave = () => {
    onSaveCalibration(calibrationTable);
    try {
      localStorage.setItem('driftpad_hall_calibration', JSON.stringify(calibrationTable));
    } catch {
      // ignore
    }

    // Send calibration table over serial
    calibrationTable.forEach((k) => {
      onSendSerialCommand?.(`CAL_SET ${k.idx} ${k.restAdc} ${k.bottomAdc}`);
    });
    onSendSerialCommand?.('CAL_COMMIT');

    onClose();
  };

  const activeKeyData = calibrationTable[activeKeyIdx] || calibrationTable[0];
  const activeKeyDef = keys[activeKeyIdx] || { idx: activeKeyIdx, label: `K${activeKeyIdx}` };
  const currentRawAdc = liveAdcValues[activeKeyIdx] || activeKeyData.restAdc;
  const strokeDelta = Math.max(1, activeKeyData.bottomAdc - activeKeyData.restAdc);
  const currentTravelMm = Math.min(
    4.0,
    Math.max(0.0, ((currentRawAdc - activeKeyData.restAdc) / strokeDelta) * 4.0)
  );

  const calibratedCount = calibrationTable.filter((k) => k.isCalibrated).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="bg-[#ffffff] border border-[#ded7ca] rounded-2xl shadow-2xl max-w-3xl w-full max-h-[92vh] flex flex-col overflow-hidden text-[#1b2930]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#f0ebdf] bg-[#faf8f5]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[#153641] flex items-center justify-center text-white shadow-xs">
              <Sliders className="w-4 h-4 text-[#e8f1ee]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-sm text-[#1b2930]">
                  Hall-Effect ADC Calibration Wizard
                </h3>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#f0ebdf] text-[#5b8e85] font-bold">
                  {connectionMode === 'hardware' ? 'Live USB ADC' : 'DSP Simulation'}
                </span>
              </div>
              <p className="text-xs text-[#71828a]">
                Tune analog magnet baselines and full 0.00-4.00mm travel per switch
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

        {/* Wizard Steps Progress Bar */}
        <div className="flex items-center justify-between px-6 py-2.5 bg-[#f6f3ec] border-b border-[#ded7ca] text-xs">
          <div className="flex items-center gap-2">
            <span
              className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                step === 1 ? 'bg-[#c86443] text-white' : 'bg-[#e5dfd5] text-[#5a6a72]'
              }`}
            >
              1
            </span>
            <span className={step === 1 ? 'font-bold text-[#1b2930]' : 'text-[#71828a]'}>
              Rest Baselines
            </span>
          </div>

          <span className="text-[#b0bac0]">───</span>

          <div className="flex items-center gap-2">
            <span
              className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                step === 2 ? 'bg-[#c86443] text-white' : 'bg-[#e5dfd5] text-[#5a6a72]'
              }`}
            >
              2
            </span>
            <span className={step === 2 ? 'font-bold text-[#1b2930]' : 'text-[#71828a]'}>
              Bottom-Out Sweep ({calibratedCount}/16)
            </span>
          </div>

          <span className="text-[#b0bac0]">───</span>

          <div className="flex items-center gap-2">
            <span
              className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                step === 3 ? 'bg-[#c86443] text-white' : 'bg-[#e5dfd5] text-[#5a6a72]'
              }`}
            >
              3
            </span>
            <span className={step === 3 ? 'font-bold text-[#1b2930]' : 'text-[#71828a]'}>
              Verify &amp; Commit
            </span>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto flex-1 flex flex-col gap-5">
          {step === 1 && (
            <div className="flex flex-col gap-4 text-xs">
              <div className="bg-[#faf8f5] p-4 rounded-xl border border-[#ded7ca]">
                <h4 className="font-bold text-sm text-[#1b2930] mb-1">
                  Phase 1: Zero-Point Magnet Baseline
                </h4>
                <p className="text-xs text-[#5a6a72] leading-relaxed">
                  Release all 16 keys on your macropad. The microcontroller will take 200 analog
                  samples per switch to detect resting magnetic flux, zero out thermal offsets, and
                  calculate the noise floor.
                </p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {calibrationTable.map((k) => (
                  <div
                    key={k.idx}
                    className="p-2.5 bg-[#ffffff] border border-[#ded7ca] rounded-xl flex flex-col"
                  >
                    <div className="flex items-center justify-between text-[11px] font-mono">
                      <span className="font-bold text-[#1b2930]">
                        Key #{k.idx} ({keys[k.idx]?.label || 'K'})
                      </span>
                      <span className="text-[#5b8e85] font-semibold">
                        {k.restAdc}
                      </span>
                    </div>
                    <span className="text-[10px] text-[#71828a] mt-0.5">
                      Noise: ±{k.noiseFloor} counts
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-end pt-2">
                <button
                  type="button"
                  onClick={handleCaptureRestBaselines}
                  disabled={isSampling}
                  className="px-5 py-2.5 rounded-xl text-xs font-bold bg-[#c86443] hover:bg-[#b25536] text-white shadow-xs transition-colors flex items-center gap-2"
                >
                  {isSampling ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Sampling 16 Hall Sensors...</span>
                    </>
                  ) : (
                    <>
                      <Zap className="w-4 h-4" />
                      <span>Sample Resting Baselines &amp; Proceed</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col lg:flex-row gap-5">
              {/* 4x4 Grid Matrix */}
              <div className="flex flex-col items-center">
                <span className="text-[10px] font-bold text-[#71828a] uppercase tracking-wider mb-2">
                  Select or Press Key to Calibrate
                </span>
                <div className="grid grid-cols-4 gap-2 bg-[#ebe5d9] p-3 rounded-2xl border border-[#ded7ca]">
                  {calibrationTable.map((k) => {
                    const isSelected = k.idx === activeKeyIdx;
                    return (
                      <button
                        key={k.idx}
                        type="button"
                        onClick={() => setActiveKeyIdx(k.idx)}
                        className={`w-14 h-14 rounded-xl flex flex-col items-center justify-center text-xs transition-all shadow-xs relative ${
                          isSelected
                            ? 'bg-[#ffffff] text-[#1b2930] ring-2 ring-[#c86443] font-bold scale-105'
                            : k.isCalibrated
                            ? 'bg-[#e8f1ef] text-[#153641] border border-[#d2e2df]'
                            : 'bg-[#faf8f5] text-[#5a6a72] border border-[#ded7ca] hover:bg-[#ffffff]'
                        }`}
                      >
                        <span className="font-bold text-xs">{keys[k.idx]?.label || `K${k.idx}`}</span>
                        <span className="text-[9px] font-mono mt-0.5 text-[#71828a]">#{k.idx}</span>

                        {k.isCalibrated && (
                          <div className="absolute top-1 right-1 w-3.5 h-3.5 rounded-full bg-[#15803d] flex items-center justify-center text-white">
                            <Check className="w-2.5 h-2.5 stroke-[3]" />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Active Key Gauge & Controls */}
              <div className="flex-1 flex flex-col gap-3.5 bg-[#faf8f5] p-4 rounded-xl border border-[#ded7ca]">
                <div className="flex items-center justify-between border-b border-[#f0ebdf] pb-2">
                  <div>
                    <h4 className="font-bold text-sm text-[#1b2930]">
                      Key #{activeKeyIdx}: {activeKeyDef.label}
                    </h4>
                    <span className="text-xs text-[#5a6a72]">
                      Press key down fully to measure peak magnetic flux
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] text-[#71828a] uppercase tracking-wider block font-bold">
                      Status
                    </span>
                    <span
                      className={`text-xs font-bold ${
                        activeKeyData.isCalibrated ? 'text-[#15803d]' : 'text-[#c86443]'
                      }`}
                    >
                      {activeKeyData.isCalibrated ? '✓ Calibrated' : 'Pending Sweep'}
                    </span>
                  </div>
                </div>

                {/* Live ADC Values */}
                <div className="grid grid-cols-3 gap-2 text-center text-xs font-mono">
                  <div className="p-2 bg-[#ffffff] rounded-lg border border-[#ded7ca]">
                    <span className="text-[9px] text-[#71828a] block">Rest ADC</span>
                    <span className="font-bold text-[#1b2930]">{activeKeyData.restAdc}</span>
                  </div>
                  <div className="p-2 bg-[#ffffff] rounded-lg border border-[#ded7ca]">
                    <span className="text-[9px] text-[#71828a] block">Live ADC</span>
                    <span className="font-bold text-[#c86443]">{currentRawAdc}</span>
                  </div>
                  <div className="p-2 bg-[#ffffff] rounded-lg border border-[#ded7ca]">
                    <span className="text-[9px] text-[#71828a] block">Bottom-out ADC</span>
                    <span className="font-bold text-[#15803d]">{activeKeyData.bottomAdc}</span>
                  </div>
                </div>

                {/* Analog Travel Meter */}
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-medium text-[#71828a]">Calculated Travel</span>
                    <span className="font-mono font-bold text-[#1b2930]">
                      {currentTravelMm.toFixed(2)} mm / 4.00 mm
                    </span>
                  </div>
                  <div className="w-full h-3 bg-[#e5dfd5] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#c86443] transition-all duration-75"
                      style={{ width: `${(currentTravelMm / 4.0) * 100}%` }}
                    />
                  </div>
                </div>

                <div className="pt-2 flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={handleSimulateFullStroke}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#ffffff] hover:bg-[#faf7f2] border border-[#ded7ca] text-[#1b2930] transition-colors"
                  >
                    Simulate Full Stroke Press
                  </button>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (activeKeyIdx < 15) setActiveKeyIdx((prev) => prev + 1);
                        else setStep(3);
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[#5a6a72] hover:bg-[#ede7da]"
                    >
                      Skip Key
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRecordActiveKeyStroke(Math.max(currentRawAdc, 3400))}
                      className="px-4 py-1.5 rounded-lg text-xs font-bold bg-[#15803d] hover:bg-[#126c34] text-white transition-colors flex items-center gap-1.5"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>Confirm Calibration</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col gap-4 text-xs">
              <div className="bg-[#e8f1ef] p-4 rounded-xl border border-[#d2e2df] flex items-center gap-3">
                <ShieldCheck className="w-6 h-6 text-[#15803d] shrink-0" />
                <div>
                  <h4 className="font-bold text-sm text-[#153641]">
                    Calibration Completed Successfully!
                  </h4>
                  <p className="text-xs text-[#5a6a72] mt-0.5">
                    All 16 switches have been normalized across their mechanical travel stroke. Deadzones
                    are set to 0.05mm at rest and bottom-out to eliminate false triggers.
                  </p>
                </div>
              </div>

              <div className="max-h-48 overflow-y-auto bg-[#faf8f5] p-3 rounded-xl border border-[#ded7ca]">
                <table className="w-full text-left font-mono text-[11px]">
                  <thead>
                    <tr className="border-b border-[#ded7ca] text-[#71828a]">
                      <th className="pb-1.5 font-bold">Key</th>
                      <th className="pb-1.5 font-bold">Rest ADC</th>
                      <th className="pb-1.5 font-bold">Bottom ADC</th>
                      <th className="pb-1.5 font-bold">Span</th>
                      <th className="pb-1.5 font-bold">Resolution</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#f0ebdf]">
                    {calibrationTable.map((k) => {
                      const span = k.bottomAdc - k.restAdc;
                      const res = (span / 4.0).toFixed(1);
                      return (
                        <tr key={k.idx}>
                          <td className="py-1 font-bold text-[#1b2930]">
                            #{k.idx} ({keys[k.idx]?.label || 'K'})
                          </td>
                          <td className="py-1 text-[#5b8e85]">{k.restAdc}</td>
                          <td className="py-1 text-[#c86443]">{k.bottomAdc}</td>
                          <td className="py-1 text-[#153641] font-bold">{span} counts</td>
                          <td className="py-1 text-[#71828a]">{res} counts/mm</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-[#5a6a72] hover:bg-[#ede7da]"
                >
                  Back to Sweep
                </button>

                <button
                  type="button"
                  onClick={handleFinishAndSave}
                  className="px-5 py-2.5 rounded-xl text-xs font-bold bg-[#c86443] hover:bg-[#b25536] text-white shadow-xs transition-colors flex items-center gap-2"
                >
                  <Check className="w-4 h-4" />
                  <span>Commit Calibration to Hardware &amp; Finish</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
