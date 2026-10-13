import React from 'react';
import { X, Cpu, CircuitBoard, Layers, ShieldCheck } from 'lucide-react';

interface HardwareInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const HardwareInfoModal: React.FC<HardwareInfoModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="bg-[#181c27] border border-[#2d3748] rounded-2xl w-full max-w-2xl max-h-[90vh] shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex justify-between items-center p-4 border-b border-[#2d3748] bg-[#11141d]">
          <div className="flex items-center gap-2">
            <CircuitBoard className="w-5 h-5 text-[#00f2fe]" />
            <h3 className="text-base font-bold text-white">DriftPad RP2040 Hardware Specification</h3>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-6 text-sm text-gray-300">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-[#11141d] p-3.5 rounded-xl border border-[#2d3748]">
              <div className="flex items-center gap-2 text-[#00f2fe] font-bold mb-1.5">
                <Cpu className="w-4 h-4" /> Microcontroller
              </div>
              <p className="text-xs text-gray-400">
                Raspberry Pi Pico (RP2040 Dual ARM Cortex-M0+ @ 133MHz). Core 0 handles Hall-effect DSP &amp; USB HID at 1kHz. Core 1 manages the SSD1306 128×64 OLED at ~30 FPS lock-free.
              </p>
            </div>

            <div className="bg-[#11141d] p-3.5 rounded-xl border border-[#2d3748]">
              <div className="flex items-center gap-2 text-emerald-400 font-bold mb-1.5">
                <ShieldCheck className="w-4 h-4" /> Analog Sensing
              </div>
              <p className="text-xs text-gray-400">
                16 linear Hall-effect sensors (AH49E / SS49E) scanned through CD74HC4067 16-channel analog multiplexer (GP14..17) into RP2040 ADC0 (GP26).
              </p>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-[#00f2fe] mb-2 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5" /> GPIO Pinout Architecture
            </h4>
            <div className="bg-[#090b10] rounded-xl border border-[#2d3748] overflow-hidden text-xs font-mono">
              <table className="w-full text-left">
                <thead className="bg-[#181c27] text-gray-400 border-b border-[#2d3748]">
                  <tr>
                    <th className="p-2.5">Component</th>
                    <th className="p-2.5">GPIO Pins</th>
                    <th className="p-2.5">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2d3748]">
                  <tr>
                    <td className="p-2.5 font-bold text-white">ADC0</td>
                    <td className="p-2.5 text-[#00f2fe]">GP26</td>
                    <td className="p-2.5 text-gray-400">Multiplexer Common Signal (0-3.3V)</td>
                  </tr>
                  <tr>
                    <td className="p-2.5 font-bold text-white">CD74HC4067 MUX</td>
                    <td className="p-2.5 text-[#00f2fe]">GP14, GP15, GP16, GP17</td>
                    <td className="p-2.5 text-gray-400">Address Select Lines S0..S3</td>
                  </tr>
                  <tr>
                    <td className="p-2.5 font-bold text-white">SSD1306 OLED</td>
                    <td className="p-2.5 text-[#00f2fe]">GP0 (SDA), GP1 (SCL)</td>
                    <td className="p-2.5 text-gray-400">I2C0 Bus @ 400kHz (Addr: 0x3C)</td>
                  </tr>
                  <tr>
                    <td className="p-2.5 font-bold text-white">Rotary Encoder</td>
                    <td className="p-2.5 text-[#00f2fe]">GP20 (A), GP21 (B), GP4 (SW)</td>
                    <td className="p-2.5 text-gray-400">Quadrature menu input &amp; push-to-click</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-[#00f2fe] mb-2">
              Hall-Effect Rapid Trigger DSP Derivation
            </h4>
            <div className="bg-[#11141d] p-3.5 rounded-xl border border-[#2d3748] text-xs text-gray-400 space-y-2">
              <p>
                <strong>Velocity-Adaptive Low-Pass Filter:</strong> Filters baseline noise at rest while key is stationary, and minimizes latency during fast strokes.
              </p>
              <p>
                <strong>Dynamic Continuous Rapid Trigger:</strong> Once a key actuates past the actuation point (default 1.20mm), the sensor continuously tracks the travel peak. As soon as the stem ascends by the Rapid Trigger sensitivity (default 0.20mm), the key immediately resets and sends a HID release packet — without requiring return to the fixed top threshold!
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[#2d3748] bg-[#11141d] flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-[#222738] hover:bg-[#2d3748] text-white rounded-lg text-xs font-bold transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
