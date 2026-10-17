import React, { useState, useRef, useEffect } from 'react';
import { ProductivityProfile } from '../types/driftpad';
import { ConnectionMode } from '../services/serialService';
import {
  Usb,
  ChevronDown,
  Code2,
  Film,
  Box,
  FileSpreadsheet,
  Layers as LayersIcon,
  Briefcase,
  Download,
  Upload,
  Copy,
  Plus,
  Zap,
  Check,
  Sparkles,
  RotateCcw,
  Terminal,
  Info,
  Sliders,
  CircuitBoard,
} from 'lucide-react';
import { HoverExplain } from './HoverExplain';

interface HeaderProps {
  connectionMode: ConnectionMode;
  hidEnabled?: boolean;
  profiles: ProductivityProfile[];
  activeProfileId: string;
  syncStatus?: 'synced' | 'saving';
  onSelectProfile: (profileId: string) => void;
  onExportProfiles: () => void;
  onImportProfiles: (file: File) => void;
  onCreateCustomProfile: () => void;
  onDuplicateProfile: (profileId: string) => void;
  onConnectToggle: () => void;
  onToggleVirtualMode: () => void;
  onOpenFlashFirmware?: () => void;
  onResetDefaults?: () => void;
  onOpenSerialConsole?: () => void;
  onOpenHardwareInfo?: () => void;
  onOpenCalibration?: () => void;
  onOpenPinoutConfig?: () => void;
}

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  finance: <FileSpreadsheet className="w-4 h-4 text-[#c86443]" />,
  developer: <Code2 className="w-4 h-4 text-[#153641]" />,
  video: <Film className="w-4 h-4 text-[#5b8e85]" />,
  '3d_cad': <Box className="w-4 h-4 text-[#b45309]" />,
  design: <LayersIcon className="w-4 h-4 text-[#c86443]" />,
  custom: <Sparkles className="w-4 h-4 text-[#5b8e85]" />,
};

export const Header: React.FC<HeaderProps> = ({
  connectionMode,
  profiles,
  activeProfileId,
  syncStatus = 'synced',
  onSelectProfile,
  onExportProfiles,
  onImportProfiles,
  onCreateCustomProfile,
  onDuplicateProfile,
  onConnectToggle,
  onToggleVirtualMode,
  onOpenFlashFirmware,
  onResetDefaults,
  onOpenSerialConsole,
  onOpenHardwareInfo,
  onOpenCalibration,
  onOpenPinoutConfig,
}) => {
  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeProfile = profiles.find((p) => p.id === activeProfileId) || profiles[0];

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onImportProfiles(file);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <header className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 sm:px-6 py-3 bg-[#ffffff] border border-[#ded7ca] rounded-2xl shadow-xs">
      {/* Left Column: Brand & Auto-Sync State */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-[#153641] flex items-center justify-center font-mono font-black text-white text-sm shadow-xs border border-[#0f262e] relative">
            <span>DP</span>
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[#c86443] ring-2 ring-white" />
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="font-black text-base tracking-tight text-[#1b2930] leading-none">
                DriftPad
              </span>
              <span className="text-[10px] font-mono font-bold px-1.5 py-0.2 rounded bg-[#e8f1ef] text-[#153641] border border-[#d2e2df] leading-none">
                RP2040
              </span>
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="text-[10px] text-[#71828a] font-medium leading-none">
                Hall-Effect Studio
              </span>
              <span className="text-[10px] text-[#b0bac0]">·</span>
              {/* Subtle Auto-Save Status */}
              <div className="inline-flex items-center gap-1 text-[10px] text-[#5b8e85] font-medium leading-none">
                {syncStatus === 'saving' ? (
                  <span className="text-[#c86443] animate-pulse">Saving...</span>
                ) : (
                  <>
                    <Check className="w-2.5 h-2.5 stroke-[2.5]" />
                    <span>Auto-saved</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Center Column: Workspace Selector & Consolidated Menu */}
      <div ref={profileRef} className="relative flex items-center justify-center">
        <div className="inline-flex items-center p-0.5 bg-[#f6f3ec] rounded-xl border border-[#ded7ca] shadow-xs">
          <button
            type="button"
            onClick={() => setProfileDropdownOpen((prev) => !prev)}
            className="flex items-center gap-2.5 px-3.5 py-1.5 rounded-lg bg-[#ffffff] hover:bg-[#faf7f2] text-[#1b2930] border border-[#ded7ca] text-xs font-semibold transition-all shadow-xs"
            aria-label="Switch Workspace Profile"
          >
            <div className="p-1 rounded-md bg-[#f6f3ec]">
              {CATEGORY_ICONS[activeProfile.category] || <Briefcase className="w-3.5 h-3.5" />}
            </div>
            <div className="flex flex-col text-left">
              <span className="text-[9px] font-bold uppercase tracking-wider text-[#71828a] leading-none">
                Workspace
              </span>
              <span className="font-bold text-xs text-[#1b2930] max-w-[140px] sm:max-w-[190px] truncate leading-tight">
                {activeProfile.name}
              </span>
            </div>
            <ChevronDown
              className={`w-3.5 h-3.5 text-[#71828a] transition-transform duration-150 ${
                profileDropdownOpen ? 'rotate-180 text-[#c86443]' : ''
              }`}
            />
          </button>

          <HoverExplain
            title="Workspaces"
            badge="Profiles"
            explanation="Each workspace stores all 16 key bindings, rotary encoder controls, and Rapid Trigger sensitivity. Switch anytime or use the menu to create, duplicate, import, and export configurations."
            tip="Auto-saves automatically in real time to your browser."
            className="ml-1 mr-1"
          />
        </div>

        {/* Consolidated Workspace Dropdown Menu */}
        {profileDropdownOpen && (
          <div className="absolute left-1/2 -translate-x-1/2 top-full mt-2 w-84 bg-[#ffffff] border border-[#ded7ca] rounded-2xl shadow-xl py-2 z-50 flex flex-col text-xs animate-in fade-in duration-100">
            <div className="px-3.5 py-1.5 text-[10px] font-bold text-[#71828a] uppercase tracking-wider border-b border-[#f0ebdf]">
              Workspaces ({profiles.length})
            </div>

            <div className="max-h-56 overflow-y-auto px-1.5 py-1 space-y-0.5">
              {profiles.map((p) => {
                const isSelected = p.id === activeProfileId;
                return (
                  <button
                    key={p.id}
                    onClick={() => {
                      onSelectProfile(p.id);
                      setProfileDropdownOpen(false);
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-left transition-colors ${
                      isSelected
                        ? 'bg-[#c86443]/10 text-[#c86443] font-bold'
                        : 'text-[#1b2930] hover:bg-[#f7f4ee] hover:text-[#153641]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 truncate">
                      <div className={`p-1 rounded-lg ${isSelected ? 'bg-[#c86443]/15' : 'bg-[#f6f3ec]'}`}>
                        {CATEGORY_ICONS[p.category] || <Briefcase className="w-3.5 h-3.5" />}
                      </div>
                      <div className="flex flex-col truncate">
                        <span className="truncate font-semibold">{p.name}</span>
                        <span className="text-[10px] text-[#71828a] truncate font-normal">
                          {p.description}
                        </span>
                      </div>
                    </div>
                    {isSelected && (
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#c86443] text-white shrink-0 ml-2">
                        ACTIVE
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Consolidated Workspace Actions */}
            <div className="pt-1.5 mt-1 border-t border-[#f0ebdf] px-2 flex flex-col gap-0.5">
              <div className="px-2 py-0.5 text-[9px] font-bold text-[#94a3b8] uppercase tracking-wider">
                Manage Profile
              </div>
              <button
                onClick={() => {
                  onCreateCustomProfile();
                  setProfileDropdownOpen(false);
                }}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[#1b2930] hover:bg-[#f7f4ee] font-medium"
              >
                <Plus className="w-3.5 h-3.5 text-[#15803d]" />
                <span>New Blank Workspace</span>
              </button>
              <button
                onClick={() => {
                  onDuplicateProfile(activeProfileId);
                  setProfileDropdownOpen(false);
                }}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[#1b2930] hover:bg-[#f7f4ee] font-medium"
              >
                <Copy className="w-3.5 h-3.5 text-[#5b8e85]" />
                <span>Duplicate Active Workspace</span>
              </button>
              {onResetDefaults && (
                <button
                  onClick={() => {
                    onResetDefaults();
                    setProfileDropdownOpen(false);
                  }}
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[#1b2930] hover:bg-amber-50 hover:text-amber-800 font-medium"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-amber-600" />
                  <span>Reset All to Factory Defaults</span>
                </button>
              )}
            </div>

            {/* Import / Export & Hardware Diagnostics */}
            <div className="pt-1.5 mt-1 border-t border-[#f0ebdf] px-2 flex flex-col gap-0.5">
              <div className="px-2 py-0.5 text-[9px] font-bold text-[#94a3b8] uppercase tracking-wider">
                Backup & Tools
              </div>
              <div className="grid grid-cols-2 gap-1">
                <button
                  onClick={() => {
                    onExportProfiles();
                    setProfileDropdownOpen(false);
                  }}
                  className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-[#5a6a72] hover:bg-[#f7f4ee] hover:text-[#1b2930] border border-[#e5dfd5]"
                >
                  <Download className="w-3.5 h-3.5 text-[#5b8e85]" />
                  <span>Export JSON</span>
                </button>
                <button
                  onClick={() => {
                    fileInputRef.current?.click();
                    setProfileDropdownOpen(false);
                  }}
                  className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-[#5a6a72] hover:bg-[#f7f4ee] hover:text-[#1b2930] border border-[#e5dfd5]"
                >
                  <Upload className="w-3.5 h-3.5 text-[#b45309]" />
                  <span>Import JSON</span>
                </button>
              </div>

              {onOpenCalibration && (
                <button
                  onClick={() => {
                    onOpenCalibration();
                    setProfileDropdownOpen(false);
                  }}
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[#1b2930] hover:bg-[#f7f4ee] font-medium"
                >
                  <Sliders className="w-3.5 h-3.5 text-[#c86443]" />
                  <span>Calibrate Hall Sensors</span>
                </button>
              )}

              {onOpenPinoutConfig && (
                <button
                  onClick={() => {
                    onOpenPinoutConfig();
                    setProfileDropdownOpen(false);
                  }}
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[#1b2930] hover:bg-[#f7f4ee] font-medium"
                >
                  <CircuitBoard className="w-3.5 h-3.5 text-[#5b8e85]" />
                  <span>GPIO Pinout &amp; C++ Firmware</span>
                </button>
              )}

              {onOpenSerialConsole && (
                <button
                  onClick={() => {
                    onOpenSerialConsole();
                    setProfileDropdownOpen(false);
                  }}
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[#1b2930] hover:bg-[#f7f4ee] font-medium"
                >
                  <Terminal className="w-3.5 h-3.5 text-[#153641]" />
                  <span>Open USB Serial Console</span>
                </button>
              )}

              {onOpenHardwareInfo && (
                <button
                  onClick={() => {
                    onOpenHardwareInfo();
                    setProfileDropdownOpen(false);
                  }}
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[#1b2930] hover:bg-[#f7f4ee] font-medium"
                >
                  <Info className="w-3.5 h-3.5 text-[#71828a]" />
                  <span>Hardware Pinout &amp; Specs</span>
                </button>
              )}
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {/* Right Column: Clean Hardware Dock (Flash, Status, Connect) */}
      <div className="flex items-center gap-2.5 justify-end">
        {/* Flash Firmware Action */}
        {onOpenFlashFirmware && (
          <button
            onClick={onOpenFlashFirmware}
            className="px-3.5 py-1.5 bg-[#ede7da] hover:bg-[#e2dacb] text-[#1b2930] rounded-xl text-xs font-semibold flex items-center gap-1.5 border border-[#d5cbb8] transition-colors shadow-xs group"
            title="Automatically flash the RP2040 pad with latest firmware"
          >
            <Zap className="w-3.5 h-3.5 text-[#c86443] fill-[#c86443] group-hover:scale-110 transition-transform" />
            <span className="font-bold">Flash Firmware</span>
          </button>
        )}

        {/* Hardware Status / Simulator Toggle Pill */}
        <button
          onClick={onToggleVirtualMode}
          className={`px-3 py-1.5 rounded-xl text-xs font-mono font-medium flex items-center gap-1.5 border transition-colors ${
            connectionMode === 'hardware'
              ? 'bg-[#15803d]/10 text-[#15803d] border-[#15803d]/30'
              : connectionMode === 'virtual'
              ? 'bg-[#5b8e85]/15 text-[#153641] border-[#5b8e85]/35'
              : 'bg-red-500/10 text-red-600 border-red-500/30'
          }`}
          title="Click to toggle Virtual Simulator mode"
        >
          <span
            className={`w-2 h-2 rounded-full ${
              connectionMode === 'hardware'
                ? 'bg-[#15803d] animate-pulse'
                : connectionMode === 'virtual'
                ? 'bg-[#5b8e85]'
                : 'bg-red-500'
            }`}
          />
          <span className="text-[11px] font-semibold">
            {connectionMode === 'hardware'
              ? 'USB Hardware'
              : connectionMode === 'virtual'
              ? 'Digital Twin'
              : 'Offline'}
          </span>
        </button>

        {/* Primary USB Connect / Disconnect Button */}
        <button
          onClick={onConnectToggle}
          className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-xs ${
            connectionMode === 'hardware'
              ? 'bg-[#faf7f2] hover:bg-red-50 text-red-600 border border-red-200'
              : 'bg-[#c86443] hover:bg-[#b25536] text-white'
          }`}
        >
          <Usb className="w-3.5 h-3.5" />
          <span>{connectionMode === 'hardware' ? 'Disconnect' : 'Connect USB'}</span>
        </button>
      </div>
    </header>
  );
};
