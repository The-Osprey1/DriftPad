import React from 'react';
import { ConnectionMode } from '../services/serialService';
import {
  Usb,
  Cpu,
  Save,
  RotateCcw,
  Sparkles,
  Info,
  Shield,
  DownloadCloud,
} from 'lucide-react';

interface HeaderProps {
  connectionMode: ConnectionMode;
  hidEnabled: boolean;
  onConnectToggle: () => void;
  onToggleVirtualMode: () => void;
  onToggleHid: () => void;
  onSaveFlash: () => void;
  onFactoryReset: () => void;
  onCalibrate: () => void;
  onScreensaver: () => void;
  onBootsel: () => void;
  onOpenHardwareInfo: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  connectionMode,
  hidEnabled,
  onConnectToggle,
  onToggleVirtualMode,
  onToggleHid,
  onSaveFlash,
  onFactoryReset,
  onCalibrate,
  onScreensaver,
  onBootsel,
  onOpenHardwareInfo,
}) => {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 p-4 sm:px-6 bg-[#181c27] border border-[#2d3748] rounded-2xl shadow-lg">
      {/* Brand & Identity */}
      <div className="flex items-center gap-3">
        <div className="bg-gradient-to-br from-[#00f2fe] to-[#7928ca] text-black font-black text-xs px-2.5 py-1 rounded-md tracking-wider shadow-[0_0_12px_rgba(0,242,254,0.35)]">
          HE
        </div>
        <div>
          <h1 className="text-lg sm:text-xl font-black tracking-tight text-white flex items-center gap-2">
            DriftPad
            <span className="text-xs font-mono font-medium text-[#00f2fe] bg-[#00f2fe]/10 px-2 py-0.5 rounded border border-[#00f2fe]/20">
              Rapid Trigger Configurator
            </span>
          </h1>
          <p className="text-[11px] text-[#9ca3af] hidden sm:block">
            RP2040 Hall-Effect Analog Sensing &amp; WebSerial Protocol Suite
          </p>
        </div>
      </div>

      {/* Actions and Status */}
      <div className="flex flex-wrap items-center gap-2.5">
        {/* Connection Status Indicator */}
        <div className="flex items-center gap-2 px-3 py-1.5 bg-[#11141d] rounded-lg border border-[#2d3748]">
          <div
            className={`w-2.5 h-2.5 rounded-full ${
              connectionMode === 'hardware'
                ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]'
                : connectionMode === 'virtual'
                ? 'bg-[#00f2fe] shadow-[0_0_8px_#00f2fe]'
                : 'bg-red-500 shadow-[0_0_8px_#ef4444]'
            }`}
          />
          <span className="text-xs font-semibold text-gray-300">
            {connectionMode === 'hardware'
              ? 'USB Hardware'
              : connectionMode === 'virtual'
              ? 'Digital Twin DSP'
              : 'Disconnected'}
          </span>
        </div>

        {/* Connect WebSerial Button */}
        <button
          onClick={onConnectToggle}
          className={`px-3.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all ${
            connectionMode === 'hardware'
              ? 'bg-[#222738] text-red-400 hover:bg-red-500/20 border border-red-500/30'
              : 'bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black hover:shadow-[0_0_14px_rgba(0,242,254,0.5)]'
          }`}
        >
          <Usb className="w-3.5 h-3.5" />
          <span>{connectionMode === 'hardware' ? 'Disconnect USB' : 'Connect DriftPad'}</span>
        </button>

        {/* Virtual Mode Switch */}
        <button
          onClick={onToggleVirtualMode}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition-all ${
            connectionMode === 'virtual'
              ? 'bg-[#00f2fe]/20 text-[#00f2fe] border-[#00f2fe]'
              : 'bg-[#222738] text-gray-300 border-[#2d3748] hover:text-white'
          }`}
          title="Run Hall-Effect DSP and Rapid Trigger simulator in browser"
        >
          <Cpu className="w-3.5 h-3.5" />
          <span>Virtual DSP</span>
        </button>

        {/* Toggle HID Output */}
        <button
          onClick={onToggleHid}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition-all ${
            hidEnabled
              ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
              : 'bg-[#222738] text-gray-300 border-[#2d3748] hover:text-white'
          }`}
          title="Toggle USB Keyboard typing output"
        >
          <Shield className="w-3.5 h-3.5" />
          <span>{hidEnabled ? 'HID Active' : 'HID Off'}</span>
        </button>

        {/* Screensaver button */}
        <button
          onClick={onScreensaver}
          className="px-3 py-1.5 bg-[#222738] hover:bg-[#2d3748] text-gray-300 hover:text-white rounded-lg text-xs font-medium flex items-center gap-1.5 border border-[#2d3748] transition-colors"
          title="Trigger OLED Screensaver"
        >
          <Sparkles className="w-3.5 h-3.5 text-[#00f2fe]" />
          <span className="hidden md:inline">Screensaver</span>
        </button>

        {/* Save to Flash */}
        <button
          onClick={onSaveFlash}
          className="px-3 py-1.5 bg-[#222738] hover:bg-[#2d3748] text-[#00f2fe] rounded-lg text-xs font-semibold flex items-center gap-1.5 border border-[#2d3748] hover:border-[#00f2fe] transition-colors"
          title="Commit settings to RP2040 Flash memory"
        >
          <Save className="w-3.5 h-3.5" />
          <span>Save</span>
        </button>

        {/* Calibrate */}
        <button
          onClick={onCalibrate}
          className="px-2.5 py-1.5 bg-[#222738] hover:bg-[#2d3748] text-gray-300 hover:text-white rounded-lg text-xs font-medium border border-[#2d3748] transition-colors hidden lg:flex items-center gap-1"
          title="Calibrate Hall Rest Baselines"
        >
          <span>Calibrate</span>
        </button>

        {/* Bootloader */}
        <button
          onClick={onBootsel}
          className="px-2.5 py-1.5 bg-[#222738] hover:bg-[#2d3748] text-gray-300 hover:text-white rounded-lg text-xs font-medium border border-[#2d3748] transition-colors hidden xl:flex items-center gap-1"
          title="Reboot into RP2040 USB Bootloader"
        >
          <DownloadCloud className="w-3.5 h-3.5" />
          <span>Bootloader</span>
        </button>

        {/* Factory Reset */}
        <button
          onClick={onFactoryReset}
          className="px-2.5 py-1.5 bg-[#222738] hover:bg-red-500/20 text-red-400 rounded-lg text-xs font-medium border border-red-500/30 transition-colors"
          title="Restore factory default keymaps & settings"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>

        {/* Hardware Docs Modal */}
        <button
          onClick={onOpenHardwareInfo}
          className="p-1.5 bg-[#222738] hover:bg-[#2d3748] text-gray-400 hover:text-white rounded-lg border border-[#2d3748] transition-colors"
          title="Hardware info & GPIO mapping"
        >
          <Info className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
