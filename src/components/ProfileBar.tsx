import React, { useRef } from 'react';
import {
  ProductivityProfile,
} from '../types/driftpad';
import {
  Briefcase,
  Code2,
  Film,
  Box,
  FileSpreadsheet,
  Palette,
  Download,
  Upload,
  Plus,
  Trash2,
  Copy,
} from 'lucide-react';

interface ProfileBarProps {
  profiles: ProductivityProfile[];
  activeProfileId: string;
  onSelectProfile: (profileId: string) => void;
  onExportProfiles: () => void;
  onImportProfiles: (file: File) => void;
  onCreateCustomProfile: () => void;
  onDuplicateProfile: (profileId: string) => void;
  onDeleteProfile: (profileId: string) => void;
}

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  finance: <FileSpreadsheet className="w-3.5 h-3.5 text-[#9e5b3d]" />,
  developer: <Code2 className="w-3.5 h-3.5 text-[#1e3f48]" />,
  video: <Film className="w-3.5 h-3.5 text-[#71938c]" />,
  '3d_cad': <Box className="w-3.5 h-3.5 text-[#b45309]" />,
  design: <Palette className="w-3.5 h-3.5 text-[#9e5b3d]" />,
  custom: <Briefcase className="w-3.5 h-3.5 text-[#71938c]" />,
};

export const ProfileBar: React.FC<ProfileBarProps> = ({
  profiles,
  activeProfileId,
  onSelectProfile,
  onExportProfiles,
  onImportProfiles,
  onCreateCustomProfile,
  onDuplicateProfile,
  onDeleteProfile,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeProfile = profiles.find((p) => p.id === activeProfileId) || profiles[0];

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onImportProfiles(file);
      e.target.value = '';
    }
  };

  return (
    <div className="bg-[#ffffff] border border-[#e5dfd5] rounded-2xl p-4 shadow-sm flex flex-col gap-3">
      {/* Top Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e5dfd5] pb-3">
        <div className="flex items-center gap-2">
          <Briefcase className="w-4 h-4 text-[#9e5b3d]" />
          <span className="text-xs font-bold uppercase tracking-wider text-[#9e5b3d]">
            Productivity Workspace Profiles
          </span>
          <span className="text-xs text-[#57676e] hidden sm:inline">
            · Tailored Macropad &amp; Dial Mappings
          </span>
        </div>

        {/* Action Buttons: Export / Import / Duplicate / New */}
        <div className="flex items-center gap-2">
          <button
            onClick={onExportProfiles}
            className="px-2.5 py-1 bg-[#222738] hover:bg-[#2d3748] text-gray-300 hover:text-[#00f2fe] rounded-lg text-xs font-medium border border-[#2d3748] flex items-center gap-1.5 transition-colors"
            title="Download complete profile backup (.json)"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Backup</span>
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-2.5 py-1 bg-[#222738] hover:bg-[#2d3748] text-gray-300 hover:text-emerald-400 rounded-lg text-xs font-medium border border-[#2d3748] flex items-center gap-1.5 transition-colors"
            title="Import profiles from JSON file"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Import</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            onChange={handleFileChange}
            className="hidden"
          />

          <button
            onClick={() => onDuplicateProfile(activeProfileId)}
            className="px-2.5 py-1 bg-[#222738] hover:bg-[#2d3748] text-gray-300 hover:text-white rounded-lg text-xs font-medium border border-[#2d3748] flex items-center gap-1 transition-colors"
            title="Duplicate active profile"
          >
            <Copy className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Duplicate</span>
          </button>

          <button
            onClick={onCreateCustomProfile}
            className="px-2.5 py-1 bg-[#00f2fe]/10 hover:bg-[#00f2fe]/20 text-[#00f2fe] rounded-lg text-xs font-bold border border-[#00f2fe]/30 flex items-center gap-1 transition-colors"
            title="Create blank custom profile"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Profile</span>
          </button>
        </div>
      </div>

      {/* Profiles Tabs Carousel */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
        {profiles.map((p) => {
          const isActive = p.id === activeProfileId;
          const isCustom = p.isCustom;

          return (
            <div
              key={p.id}
              className={`flex items-center rounded-xl border transition-all shrink-0 ${
                isActive
                  ? 'bg-[#222738] border-[#00f2fe] shadow-[0_0_12px_rgba(0,242,254,0.2)]'
                  : 'bg-[#11141d] border-[#2d3748] hover:border-gray-500'
              }`}
            >
              <button
                onClick={() => onSelectProfile(p.id)}
                className="flex items-center gap-2 px-3 py-2 text-xs text-left"
              >
                {CATEGORY_ICONS[p.category] || CATEGORY_ICONS.custom}
                <div>
                  <div
                    className={`font-bold leading-tight ${
                      isActive ? 'text-[#00f2fe]' : 'text-gray-200'
                    }`}
                  >
                    {p.name}
                  </div>
                  <div className="text-[10px] text-gray-500 font-mono">
                    {p.category.toUpperCase()}
                  </div>
                </div>
              </button>

              {isCustom && profiles.length > 1 && (
                <button
                  onClick={() => onDeleteProfile(p.id)}
                  className="p-1.5 mr-1 text-gray-500 hover:text-red-400 transition-colors"
                  title="Delete this custom profile"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Active Profile Info Banner */}
      {activeProfile && (
        <div className="flex flex-wrap items-center justify-between text-xs text-gray-400 bg-[#11141d] px-3.5 py-2 rounded-xl border border-[#2d3748]">
          <span className="flex items-center gap-2">
            <strong className="text-white">{activeProfile.name}:</strong>
            <span>{activeProfile.description}</span>
          </span>
          <span className="text-[11px] font-mono text-[#00f2fe] bg-[#00f2fe]/10 px-2 py-0.5 rounded border border-[#00f2fe]/20 mt-1 sm:mt-0">
            Dial: {activeProfile.encoder.name}
          </span>
        </div>
      )}
    </div>
  );
};
