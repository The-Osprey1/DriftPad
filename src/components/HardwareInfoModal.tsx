import React from 'react';
import { X, Cpu, CircuitBoard, Layers, ShieldCheck } from 'lucide-react';

interface HardwareInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const HardwareInfoModal: React.FC<HardwareInfoModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="bg-[#ffffff] border border-[#e5dfd5] rounded-2xl w-full max-w-2xl max-h-[90vh] shadow-2xl flex flex-col overflow-hidden text-[#1c282e]">
        {/* Header */}
        <div className="flex justify-between items-center p-4 border-b border-[#e5dfd5] bg-[#faf8f5]">
          <div className="flex items-center gap-2">
            <CircuitBoard className="w-5 h-5 text-[#9e5b3d]" />
            <h3 className="text-base font-bold text-[#1c282e]">DriftPad RP2040 Hardware Specification</h3>
          </div>
          <button
            onClick={onClose}
            className="text-[#84949b] hover:text-[#1c282e] p-1 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-6 text-sm text-[#1c282e]">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-[#faf8f5] p-3.5 rounded-xl border border-[#e5dfd5]">
              <div className="flex items-center gap-2 text-[#9e5b3d] font-bold mb-1.5">
                <Cpu className="w-4 h-4" /> Microcontroller
              </div>
              <p className="text-xs text-[#57676e]">
                Raspberry Pi Pico (RP2040 Dual ARM Cortex-M0+ @ 133MHz). Core 0 handles Hall-effect DSP &amp; USB HID at 1kHz. Core 1 manages the SSD1306 128×64 OLED at ~30 FPS lock-free.
              </p>
            </div>

            <div className="bg-[#faf8f5] p-3.5 rounded-xl border border-[#e5dfd5]">
              <div className="flex items-center gap-2 text-[#15803d] font-bold mb-1.5">
                <ShieldCheck className="w-4 h-4" /> Analog Sensing
              </div>
              <p className="text-xs text-[#57676e]">
                16 linear Hall-effect sensors (AH49E / SS49E) scanned through CD74HC4067 16-channel analog multiplexer (GP14..17) into RP2040 ADC0 (GP26).
              </p>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-[#9e5b3d] mb-2 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5" /> GPIO Pinout Architecture
            </h4>
            <div className="bg-[#faf8f5] rounded-xl border border-[#e5dfd5] overflow-hidden text-xs font-mono shadow-xs">
              <table className="w-full text-left">
                <thead className="bg-[#ede8df] text-[#1c282e] border-b border-[#e5dfd5]">
                  <tr>
                    <th className="p-2.5 font-bold">Component</th>
                    <th className="p-2.5 font-bold">GPIO Pins</th>
                    <th className="p-2.5 font-bold">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#e5dfd5]">
                  <tr>
                    <td className="p-2.5 font-bold text-[#1c282e]">ADC0</td>
                    <td className="p-2.5 text-[#9e5b3d] font-bold">GP26</td>
                    <td className="p-2.5 text-[#57676e]">Multiplexer Common Signal (0-3.3V)</td>
                  </tr>
                  <tr>
                    <td className="p-2.5 font-bold text-[#1c282e]">CD74HC4067 MUX</td>
                    <td className="p-2.5 text-[#9e5b3d] font-bold">GP14, GP15, GP16, GP17</td>
                    <td className="p-2.5 text-[#57676e]">Address Select Lines S0..S3</td>
                  </tr>
                  <tr>
                    <td className="p-2.5 font-bold text-[#1c282e]">SSD1306 OLED</td>
                    <td className="p-2.5 text-[#71938c] font-bold">GP0 (SDA), GP1 (SCL)</td>
                    <td className="p-2.5 text-[#57676e]">I2C0 Bus @ 400kHz (Addr: 0x3C)</td>
                  </tr>
                  <tr>
                    <td className="p-2.5 font-bold text-[#1c282e]">Rotary Encoder</td>
                    <td className="p-2.5 text-[#71938c] font-bold">GP20 (A), GP21 (B), GP4 (SW)</td>
                    <td className="p-2.5 text-[#57676e]">Quadrature menu input &amp; push-to-click</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-[#9e5b3d] mb-2">
              Hall-Effect Rapid Trigger DSP Derivation
            </h4>
            <div className="bg-[#faf8f5] p-3.5 rounded-xl border border-[#e5dfd5] text-xs text-[#57676e] space-y-2">
              <p>
                <strong>Velocity-Adaptive Low-Pass Filter:</strong> Filters baseline noise at rest while key is stationary, and minimizes latency during fast strokes.
              </p>
              <p>
                <strong>Dynamic Continuous Rapid Trigger:</strong> Once a key actuates past the actuation point, the sensor continuously tracks the travel peak. As soon as the stem ascends by the Rapid Trigger sensitivity, the key immediately resets and sends a HID release packet!
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[#e5dfd5] bg-[#faf8f5] flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-[#9e5b3d] hover:bg-[#8b4e34] text-white rounded-xl text-xs font-bold transition-colors shadow-xs"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
