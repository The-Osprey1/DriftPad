import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  DeviceConfig,
  KeyStatus,
  LogEntry,
  INITIAL_DEVICE_CONFIG,
  SerialCommandReply,
  ProductivityProfile,
  PRODUCTIVITY_PROFILES,
  LayerKey,
  EncoderConfig,
  EncoderAction,
  OledThemeConfig,
  DEFAULT_OLED_THEME,
} from './types/driftpad';
import { SerialService, ConnectionMode } from './services/serialService';
import { DriftPadDspEngine } from './engine/dspEngine';
import { Header } from './components/Header';
import { KeyMatrix } from './components/KeyMatrix';
import { SelectedKeyInspector } from './components/SelectedKeyInspector';
import { RotaryEncoderDial } from './components/RotaryEncoderDial';
import { RapidTriggerTuning } from './components/RapidTriggerTuning';
import { OledCanvas } from './components/OledCanvas';
import { SerialConsole } from './components/SerialConsole';
import { RemapModal } from './components/RemapModal';
import { HardwareInfoModal } from './components/HardwareInfoModal';
import { OledThemeModal } from './components/OledThemeModal';
import { FlashFirmwareModal } from './components/FlashFirmwareModal';
import {
  Sliders,
  Disc3,
  Terminal,
  Wrench,
  Check,
  RotateCcw,
  DownloadCloud,
  Shield,
  Info,
  Sparkles,
  Save,
} from 'lucide-react';

export const App: React.FC = () => {
  // Services
  const serialServiceRef = useRef<SerialService>(new SerialService());
  const dspEngineRef = useRef<DriftPadDspEngine | null>(null);

  // Connection & Config State
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('virtual');
  const [deviceConfig, setDeviceConfig] = useState<DeviceConfig>(INITIAL_DEVICE_CONFIG);
  const [keysStatus, setKeysStatus] = useState<KeyStatus[]>([]);
  const [selectedSimKey, setSelectedSimKey] = useState<number>(0);
  const [currentSimTravel, setCurrentSimTravel] = useState<number>(0.0);
  const [hidEnabled, setHidEnabled] = useState<boolean>(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // Right Deck Tab: 'tuning' | 'encoder' | 'console' | 'tools'
  const [deckTab, setDeckTab] = useState<'tuning' | 'encoder' | 'console' | 'tools'>('tuning');

  // Productivity Profiles
  const [profiles, setProfiles] = useState<ProductivityProfile[]>(() => {
    const saved = localStorage.getItem('driftpad_profiles');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const hasNumpad = parsed.some((p: ProductivityProfile) => p.id === 'number-pad');
          if (hasNumpad) return parsed;
          return [PRODUCTIVITY_PROFILES[0], ...parsed];
        }
      } catch {
        // use default
      }
    }
    return PRODUCTIVITY_PROFILES;
  });

  const [activeProfileId, setActiveProfileId] = useState<string>(() => {
    const saved = localStorage.getItem('driftpad_active_profile_id');
    if (saved && saved !== 'developer-git') return saved;
    return 'number-pad';
  });

  // OLED & Screensaver states
  const [isSleeping, setIsSleeping] = useState<boolean>(false);
  const [screensaverActive, setScreensaverActive] = useState<boolean>(false);
  const [forcedAnim, setForcedAnim] = useState<number>(-1);

  // Modals
  const [remapModalOpen, setRemapModalOpen] = useState<boolean>(false);
  const [remapKeyIdx, setRemapKeyIdx] = useState<number>(0);
  const [hardwareInfoOpen, setHardwareInfoOpen] = useState<boolean>(false);
  const [oledThemeModalOpen, setOledThemeModalOpen] = useState<boolean>(false);
  const [flashModalOpen, setFlashModalOpen] = useState<boolean>(false);

  // Heatmap Usage Statistics per Profile
  const [heatmapCounts, setHeatmapCounts] = useState<Record<string, Record<number, number>>>(() => {
    const saved = localStorage.getItem('driftpad_heatmap_counts');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        // use defaults
      }
    }
    return {
      'number-pad': {
        14: 210, // 0
        15: 240, // ENT
        1: 145, // 7
        2: 155, // 8
        3: 138, // 9
        5: 162, // 4
        6: 170, // 5
        7: 146, // 6
        9: 165, // 1
        10: 172, // 2
        11: 154, // 3
        13: 118, // +
        12: 95, // -
        8: 88, // *
        4: 82, // /
        0: 70, // ESC
      },
      'developer-git': {
        12: 142, 0: 110, 4: 89, 15: 95, 5: 72, 11: 65, 8: 61, 1: 54, 3: 52, 2: 48, 9: 38, 6: 34, 7: 29, 10: 25, 13: 20, 14: 4,
      },
      'video-editing': {
        7: 180, 1: 125, 2: 92, 4: 85, 5: 83, 12: 78, 13: 74, 6: 41, 0: 60, 8: 35, 10: 38, 9: 30, 11: 28, 14: 22, 15: 16, 3: 18,
      },
      '3d-cad-blender': {
        4: 165, 5: 150, 6: 132, 7: 118, 0: 102, 8: 95, 11: 74, 10: 62, 9: 55, 1: 45, 2: 40, 3: 42, 12: 38, 13: 25, 14: 12, 15: 18,
      },
      'finance-sheets': {
        15: 195, 4: 140, 8: 115, 14: 98, 1: 88, 2: 84, 3: 82, 5: 78, 6: 76, 7: 74, 9: 72, 10: 70, 11: 68, 12: 55, 13: 42, 0: 48,
      },
      'design-multitask': {
        0: 145, 1: 120, 4: 110, 14: 95, 3: 85, 2: 75, 8: 65, 9: 60, 15: 52, 12: 45, 13: 35, 7: 38, 5: 32, 6: 25, 10: 20, 11: 18,
      },
    };
  });

  // Notification Banner
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const recordKeyPress = useCallback(
    (keyIdx: number) => {
      setHeatmapCounts((prev) => {
        const currentProfileCounts = prev[activeProfileId] || {};
        const newCount = (currentProfileCounts[keyIdx] || 0) + 1;
        const next = {
          ...prev,
          [activeProfileId]: {
            ...currentProfileCounts,
            [keyIdx]: newCount,
          },
        };
        try {
          localStorage.setItem('driftpad_heatmap_counts', JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });
    },
    [activeProfileId]
  );

  const handleResetHeatmap = useCallback(() => {
    setHeatmapCounts((prev) => {
      const next = { ...prev, [activeProfileId]: {} };
      try {
        localStorage.setItem('driftpad_heatmap_counts', JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
    showToast('Heatmap counters reset for this profile');
  }, [activeProfileId]);

  const addLog = useCallback(
    (direction: 'TX' | 'RX' | 'INFO' | 'ERR', text: string) => {
      const now = new Date();
      const timeStr = now.toTimeString().split(' ')[0];
      setLogs((prev) => [
        ...prev.slice(-150),
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: timeStr,
          direction,
          text,
        },
      ]);
    },
    []
  );

  const handleIncomingLine = useCallback(
    (line: string) => {
      try {
        const data: SerialCommandReply = JSON.parse(line);

        if (data.type === 'config') {
          setDeviceConfig((prev) => ({
            ...prev,
            actuation: data.actuation ?? prev.actuation,
            rt_sens: data.rt_sens ?? prev.rt_sens,
            rt_enabled: data.rt_enabled ?? prev.rt_enabled,
            active_layer: data.active_layer ?? prev.active_layer,
            layers: data.layers ?? prev.layers,
          }));
        } else if (data.type === 'status') {
          if (data.keys) {
            setKeysStatus(data.keys);
          }
          if (data.active_layer !== undefined) {
            setDeviceConfig((prev) => ({ ...prev, active_layer: data.active_layer! }));
          }
        } else if (data.type === 'sim_event') {
          if (data.key !== undefined) {
            const numTravel =
              typeof data.travel === 'string' ? parseFloat(data.travel) : data.travel ?? 0;
            setKeysStatus((prev) => {
              const next = [...prev];
              if (next[data.key!]) {
                next[data.key!] = {
                  ...next[data.key!],
                  travel: numTravel,
                  pressed: !!data.pressed,
                };
              }
              return next;
            });
            if (data.key === selectedSimKey) {
              setCurrentSimTravel(numTravel);
            }
            if (data.pressed) {
              recordKeyPress(data.key);
            }
          }
        } else if (data.status === 'ok') {
          if (data.screensaver !== undefined) setScreensaverActive(data.screensaver);
          if (data.sleep !== undefined) setIsSleeping(data.sleep);
          if (data.wake !== undefined) setIsSleeping(!data.wake);
          if (data.anim !== undefined) setForcedAnim(data.anim);
          if (data.hid_output !== undefined) setHidEnabled(data.hid_output);
        }
      } catch {
        // Text telemetry
      }
    },
    [selectedSimKey, recordKeyPress]
  );

  const sendSerialCommand = useCallback(
    (cmd: string) => {
      const trimmed = cmd.trim();
      if (!trimmed) return;

      if (connectionMode === 'hardware' && serialServiceRef.current.isConnected()) {
        serialServiceRef.current.sendCommand(trimmed);
      } else {
        addLog('TX', trimmed);
        if (dspEngineRef.current) {
          const resp = dspEngineRef.current.processCommand(trimmed);
          if (resp) {
            handleIncomingLine(resp);
          }
        }
      }
    },
    [connectionMode, addLog, handleIncomingLine]
  );

  // Initialize engine and profile
  useEffect(() => {
    const engine = new DriftPadDspEngine((line) => {
      addLog('RX', line);
      handleIncomingLine(line);
    });
    dspEngineRef.current = engine;

    const initialProfile = profiles.find((p) => p.id === activeProfileId) || profiles[0];
    const initialConfig: DeviceConfig = {
      actuation: initialProfile.tuning.actuation,
      rt_sens: initialProfile.tuning.rt_sens,
      rt_enabled: initialProfile.tuning.rt_enabled,
      active_layer: 0,
      activeProfileId: initialProfile.id,
      layers: JSON.parse(JSON.stringify(initialProfile.layers)),
      encoder: JSON.parse(JSON.stringify(initialProfile.encoder)),
    };

    engine.setConfig(initialConfig);
    setDeviceConfig(initialConfig);
    setKeysStatus(engine.getKeysStatus());

    addLog('INFO', `DriftPad Studio loaded: [${initialProfile.name}]`);

    const serial = serialServiceRef.current;
    serial.setCallbacks({
      onLineReceived: (line) => handleIncomingLine(line),
      onLineSent: () => {},
      onStatusChange: (mode) => setConnectionMode(mode),
      onLog: (dir, text) => addLog(dir, text),
    });

    return () => {
      serial.disconnect();
    };
  }, [addLog, handleIncomingLine]);

  const saveProfilesToStorage = (updatedProfiles: ProductivityProfile[]) => {
    setProfiles(updatedProfiles);
    try {
      localStorage.setItem('driftpad_profiles', JSON.stringify(updatedProfiles));
    } catch {
      // ignore
    }
  };

  const handleSelectProfile = (profileId: string) => {
    const target = profiles.find((p) => p.id === profileId);
    if (!target) return;

    setActiveProfileId(profileId);
    try {
      localStorage.setItem('driftpad_active_profile_id', profileId);
    } catch {
      // ignore
    }

    const nextConfig: DeviceConfig = {
      actuation: target.tuning.actuation,
      rt_sens: target.tuning.rt_sens,
      rt_enabled: target.tuning.rt_enabled,
      active_layer: 0,
      activeProfileId: target.id,
      layers: JSON.parse(JSON.stringify(target.layers)),
      encoder: JSON.parse(JSON.stringify(target.encoder)),
    };

    setDeviceConfig(nextConfig);
    if (dspEngineRef.current) {
      dspEngineRef.current.setConfig(nextConfig);
      setKeysStatus(dspEngineRef.current.getKeysStatus());
    }

    sendSerialCommand(`SET_ACTUATION ${target.tuning.actuation.toFixed(2)}`);
    sendSerialCommand(`SET_RT_SENS ${target.tuning.rt_sens.toFixed(2)}`);
    sendSerialCommand(`SET_RT_ENABLE ${target.tuning.rt_enabled ? 1 : 0}`);
    sendSerialCommand('SET_LAYER 0');

    addLog('INFO', `Switched to profile: ${target.name}`);
    showToast(`Loaded profile: ${target.name}`);
  };

  const handleExportProfiles = () => {
    const backupData = {
      driftpad_version: '2.0',
      exported_at: new Date().toISOString(),
      active_profile_id: activeProfileId,
      profiles,
    };
    const jsonStr = JSON.stringify(backupData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `driftpad-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    addLog('INFO', 'Profiles exported successfully.');
    showToast('Backup exported to JSON');
  };

  const handleImportProfiles = (file: File) => {
    // Limit import size to 500KB to prevent DoS via large JSON payloads
    if (file.size > 500 * 1024) {
      alert('File size exceeds maximum allowed limit of 500KB.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const parsed = JSON.parse(text);

        // Validate imported profiles schema
        const isValid =
          parsed &&
          Array.isArray(parsed.profiles) &&
          parsed.profiles.length > 0 &&
          parsed.profiles.every(
            (p: Partial<ProductivityProfile>) =>
              p &&
              typeof p.id === 'string' &&
              typeof p.name === 'string' &&
              typeof p.category === 'string' &&
              typeof p.tuning === 'object' &&
              p.tuning !== null &&
              Array.isArray(p.layers)
          );

        if (isValid) {
          saveProfilesToStorage(parsed.profiles);
          const hasTarget = parsed.profiles.some(
            (p: ProductivityProfile) => p.id === parsed.active_profile_id
          );
          if (parsed.active_profile_id && hasTarget) {
            handleSelectProfile(parsed.active_profile_id);
          } else {
            handleSelectProfile(parsed.profiles[0].id);
          }
          addLog('INFO', `Imported ${parsed.profiles.length} profiles.`);
          showToast(`Imported ${parsed.profiles.length} profiles`);
        } else {
          alert('Invalid profile backup file format or schema.');
        }
      } catch (err) {
        alert(`Failed to parse JSON: ${String(err)}`);
      }
    };
    reader.readAsText(file);
  };

  const handleDuplicateProfile = (profileId: string) => {
    const target = profiles.find((p) => p.id === profileId);
    if (!target) return;

    const duplicated: ProductivityProfile = {
      ...JSON.parse(JSON.stringify(target)),
      id: `custom-${Date.now()}`,
      name: `${target.name} (Copy)`,
      isCustom: true,
    };

    const next = [...profiles, duplicated];
    saveProfilesToStorage(next);
    handleSelectProfile(duplicated.id);
    showToast(`Duplicated: ${duplicated.name}`);
  };

  const handleCreateCustomProfile = () => {
    const newProfile: ProductivityProfile = {
      id: `custom-${Date.now()}`,
      name: 'Custom Workflow',
      category: 'custom',
      description: 'Personalized macropad layers and dial actions.',
      tuning: { actuation: 1.20, rt_sens: 0.20, rt_enabled: true },
      encoder: {
        name: 'Custom Encoder Dial',
        cw: { label: 'Action CW', actionType: 'key', code: 215, description: 'Right Arrow' },
        ccw: { label: 'Action CCW', actionType: 'key', code: 216, description: 'Left Arrow' },
        click: { label: 'Action Click', actionType: 'key', code: 176, description: 'Enter' },
      },
      layers: Array.from({ length: 3 }, () =>
        Array.from({ length: 16 }, (_, idx) => ({
          idx,
          code: 97 + (idx % 26),
          label: `K${idx}`,
          description: `Key #${idx}`,
        }))
      ),
      isCustom: true,
    };

    const next = [...profiles, newProfile];
    saveProfilesToStorage(next);
    handleSelectProfile(newProfile.id);
    showToast('Created new Custom Profile');
  };

  const handleUpdateEncoderConfig = (newEncoder: EncoderConfig) => {
    setDeviceConfig((prev) => ({ ...prev, encoder: newEncoder }));

    const updated = profiles.map((p) => {
      if (p.id === activeProfileId) {
        return { ...p, encoder: newEncoder };
      }
      return p;
    });
    saveProfilesToStorage(updated);
    addLog('INFO', `Rotary encoder updated: [${newEncoder.name}]`);
    showToast(`Rotary Dial: ${newEncoder.name}`);
  };

  const handleSaveOledTheme = (newTheme: OledThemeConfig) => {
    const updated = profiles.map((p) => {
      if (p.id === activeProfileId) {
        return { ...p, oledTheme: newTheme };
      }
      return p;
    });
    saveProfilesToStorage(updated);
    setOledThemeModalOpen(false);
    addLog('INFO', `Customized OLED display theme for [${activeProfile.name}]`);
    showToast(`OLED theme saved to "${activeProfile.name}"`);
  };

  const handleTriggerEncoderAction = (action: EncoderAction, direction: 'cw' | 'ccw' | 'click') => {
    addLog('TX', `ENCODER [${direction.toUpperCase()}]: ${action.label}`);
    showToast(`Encoder: ${action.label}`);

    if (action.code) {
      sendSerialCommand(`SIM 0 1.50`);
      setTimeout(() => sendSerialCommand(`SIM 0 0.00`), 60);
    }
  };

  const handleSaveRemapKey = (keyIdx: number, updatedKey: LayerKey) => {
    setDeviceConfig((prev) => {
      const nextLayers = prev.layers.map((lArr, lIdx) => {
        if (lIdx !== 0) return lArr;
        const newKeys = [...lArr];
        newKeys[keyIdx] = updatedKey;
        return newKeys;
      });
      return { ...prev, layers: nextLayers };
    });

    if (dspEngineRef.current) {
      dspEngineRef.current.updateKey(0, keyIdx, updatedKey);
      setKeysStatus(dspEngineRef.current.getKeysStatus());
    }

    const updatedProfiles = profiles.map((p) => {
      if (p.id === activeProfileId) {
        const newLayers = p.layers.map((lArr, lIdx) => {
          if (lIdx !== 0) return lArr;
          const newKeys = [...lArr];
          newKeys[keyIdx] = updatedKey;
          return newKeys;
        });
        return { ...p, layers: newLayers };
      }
      return p;
    });
    saveProfilesToStorage(updatedProfiles);

    sendSerialCommand(`SET_KEY 0 ${keyIdx} ${updatedKey.code} ${updatedKey.label}`);
    addLog('INFO', `Remapped Key #${keyIdx} -> [${updatedKey.label}]`);
    showToast(`Remapped Key #${keyIdx}: ${updatedKey.label}`);
  };

  const handleConnectToggle = async () => {
    if (connectionMode === 'hardware') {
      await serialServiceRef.current.disconnect();
      setConnectionMode('virtual');
      addLog('INFO', 'Switched to Digital Twin DSP mode.');
      showToast('Disconnected from hardware USB');
    } else {
      const ok = await serialServiceRef.current.connectHardware();
      if (ok) {
        setConnectionMode('hardware');
        showToast('Connected to DriftPad USB');
      }
    }
  };

  const handleToggleVirtualMode = () => {
    if (connectionMode === 'hardware') {
      serialServiceRef.current.disconnect();
    }
    const next = connectionMode === 'virtual' ? 'disconnected' : 'virtual';
    setConnectionMode(next);
    addLog('INFO', `Switched mode to ${next}`);
    showToast(`Mode: ${next}`);
  };

  const handleActuationChange = (val: number) => {
    const clamped = Number(Math.max(0.1, Math.min(3.8, val)).toFixed(2));
    setDeviceConfig((prev) => ({ ...prev, actuation: clamped }));
    sendSerialCommand(`SET_ACTUATION ${clamped.toFixed(2)}`);

    const updated = profiles.map((p) => {
      if (p.id === activeProfileId) {
        return { ...p, tuning: { ...p.tuning, actuation: clamped } };
      }
      return p;
    });
    saveProfilesToStorage(updated);
  };

  const handleRtSensChange = (val: number) => {
    const clamped = Number(Math.max(0.1, Math.min(2.0, val)).toFixed(2));
    setDeviceConfig((prev) => ({ ...prev, rt_sens: clamped }));
    sendSerialCommand(`SET_RT_SENS ${clamped.toFixed(2)}`);

    const updated = profiles.map((p) => {
      if (p.id === activeProfileId) {
        return { ...p, tuning: { ...p.tuning, rt_sens: clamped } };
      }
      return p;
    });
    saveProfilesToStorage(updated);
  };

  const handleRtToggle = (enabled: boolean) => {
    setDeviceConfig((prev) => ({ ...prev, rt_enabled: enabled }));
    sendSerialCommand(`SET_RT_ENABLE ${enabled ? 1 : 0}`);

    const updated = profiles.map((p) => {
      if (p.id === activeProfileId) {
        return { ...p, tuning: { ...p.tuning, rt_enabled: enabled } };
      }
      return p;
    });
    saveProfilesToStorage(updated);
  };

  const handleSimTravelChange = (keyIdx: number, travelMm: number) => {
    const clamped = Math.max(0, Math.min(4.0, travelMm));
    setCurrentSimTravel(clamped);

    if (dspEngineRef.current) {
      const res = dspEngineRef.current.injectTravel(keyIdx, clamped);
      setKeysStatus(dspEngineRef.current.getKeysStatus());

      if (res.pressed) {
        recordKeyPress(keyIdx);
      }

      if (connectionMode === 'hardware') {
        sendSerialCommand(`SIM ${keyIdx} ${clamped.toFixed(2)}`);
      }
    }
  };

  const handleToggleHid = () => {
    const next = !hidEnabled;
    setHidEnabled(next);
    sendSerialCommand(`SET_HID ${next ? 1 : 0}`);
    showToast(next ? 'Keyboard HID output enabled' : 'Keyboard HID output disabled');
  };

  const handleSaveFlash = () => {
    sendSerialCommand('SAVE');
    showToast('Committed settings to RP2040 Flash');
  };

  const handleFactoryReset = () => {
    if (window.confirm('Reset all profiles, actuation points, and keymaps to factory defaults?')) {
      sendSerialCommand('RESET');
      setProfiles(PRODUCTIVITY_PROFILES);
      saveProfilesToStorage(PRODUCTIVITY_PROFILES);
      handleSelectProfile(PRODUCTIVITY_PROFILES[0].id);
      showToast('Factory reset complete');
    }
  };

  const handleCalibrate = () => {
    sendSerialCommand('CALIBRATE');
    showToast('Rest baselines calibrated');
  };

  const handleScreensaver = () => {
    setScreensaverActive(true);
    sendSerialCommand('SCREENSAVER');
  };

  const handleBootsel = () => {
    if (window.confirm('Reboot RP2040 into USB Bootloader for flashing?')) {
      sendSerialCommand('BOOTSEL');
    }
  };

  // Keyboard shortcut listener for testing
  useEffect(() => {
    const keyMapToIdx: Record<string, number> = {
      Escape: 0,
      Digit1: 1,
      Digit2: 2,
      Digit3: 3,
      Tab: 4,
      KeyQ: 5,
      KeyW: 6,
      KeyE: 7,
      ShiftLeft: 8,
      KeyA: 9,
      KeyS: 10,
      KeyD: 11,
      ControlLeft: 12,
      KeyR: 13,
      Space: 14,
      KeyF: 15,
      Numpad7: 1,
      Numpad8: 2,
      Numpad9: 3,
      Numpad4: 5,
      Numpad5: 6,
      Numpad6: 7,
      Numpad1: 9,
      Numpad2: 10,
      Numpad3: 11,
      Numpad0: 14,
      NumpadEnter: 15,
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const idx = keyMapToIdx[e.code];
      if (idx !== undefined) {
        setSelectedSimKey(idx);
        recordKeyPress(idx);
        handleSimTravelChange(idx, 2.5);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const idx = keyMapToIdx[e.code];
      if (idx !== undefined) {
        handleSimTravelChange(idx, 0.0);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [recordKeyPress]);

  const activeKeyObj = keysStatus[selectedSimKey] || {
    idx: selectedSimKey,
    pressed: false,
    travel: 0,
    label: '',
  };

  const currentWorkspaceKeys = deviceConfig.layers[0] || [];
  const currentLayerKeyDef = currentWorkspaceKeys[selectedSimKey] || {
    idx: selectedSimKey,
    code: 0,
    label: 'KEY',
  };
  const activeProfile = profiles.find((p) => p.id === activeProfileId) || profiles[0];

  return (
    <div className="min-h-screen bg-[#f7f4ee] text-[#1b2930] flex flex-col p-3 sm:p-5 gap-3.5 max-w-7xl mx-auto selection:bg-[#c86443]/20 selection:text-[#c86443]">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-4 right-4 z-50 bg-[#ffffff] border border-[#ded7ca] text-[#1b2930] px-4 py-2.5 rounded-xl shadow-lg text-xs font-mono flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
          <span className="w-2 h-2 rounded-full bg-[#c86443]" />
          <span className="font-medium">{toastMessage}</span>
        </div>
      )}

      {/* Unified Streamlined Header (Clean 3-Column Studio Bar) */}
      <Header
        connectionMode={connectionMode}
        profiles={profiles}
        activeProfileId={activeProfileId}
        onSelectProfile={handleSelectProfile}
        onExportProfiles={handleExportProfiles}
        onImportProfiles={handleImportProfiles}
        onCreateCustomProfile={handleCreateCustomProfile}
        onDuplicateProfile={handleDuplicateProfile}
        onConnectToggle={handleConnectToggle}
        onToggleVirtualMode={handleToggleVirtualMode}
        onOpenFlashFirmware={() => setFlashModalOpen(true)}
      />

      {/* Main Studio Grid: 2D Hardware Chassis & Controller Deck */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* Left Column (7 cols): The 2D Hardware Macropad Chassis */}
        <div className="lg:col-span-7 flex flex-col gap-3">
          {/* Physical Pad Hardware Enclosure */}
          <div className="bg-[#ebe5d9] border-2 border-[#d3c9b8] rounded-3xl p-3.5 sm:p-5 shadow-sm flex flex-col gap-3.5 relative">
            {/* Chassis Header Bar */}
            <div className="flex items-center justify-between text-[11px] font-mono text-[#5a6a72] border-b border-[#ded7ca] pb-2">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${connectionMode === 'hardware' ? 'bg-[#15803d]' : 'bg-[#5b8e85]'}`} />
                <span className="font-bold tracking-wider text-[#1b2930]">DRIFTPAD · RP2040</span>
              </div>
              <span className="text-[#71828a] font-semibold text-[10px]">16-KEY HALL EFFECT CHASSIS</span>
            </div>

            {/* Top Deck: OLED Screen on Left, Rotary Dial on Right */}
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-stretch">
              <div className="sm:col-span-7">
                <OledCanvas
                  actuation={deviceConfig.actuation}
                  rtSens={deviceConfig.rt_sens}
                  rtEnabled={deviceConfig.rt_enabled}
                  keys={keysStatus}
                  lastActiveKey={selectedSimKey}
                  profileName={activeProfile.name}
                  knobName={deviceConfig.encoder?.name || 'Dial'}
                  theme={activeProfile.oledTheme || DEFAULT_OLED_THEME}
                  isSleeping={isSleeping}
                  screensaverActive={screensaverActive}
                  forcedAnim={forcedAnim}
                  onSendSerialCommand={sendSerialCommand}
                  onOpenThemeModal={() => setOledThemeModalOpen(true)}
                />
              </div>

              {deviceConfig.encoder && (
                <div className="sm:col-span-5">
                  <RotaryEncoderDial
                    variant="dialOnly"
                    config={deviceConfig.encoder}
                    onUpdateConfig={handleUpdateEncoderConfig}
                    onTriggerAction={handleTriggerEncoderAction}
                  />
                </div>
              )}
            </div>

            {/* Subtle Hardware Hairline Divider */}
            <div className="border-t border-[#d5ccc0]" />

            {/* Bottom Deck: 4x4 Tactile Key Matrix */}
            <div className="bg-[#ffffff] border border-[#d5ccc0] rounded-2xl p-3.5 sm:p-4 shadow-xs">
              <KeyMatrix
                keys={currentWorkspaceKeys}
                keysStatus={keysStatus}
                selectedSimKey={selectedSimKey}
                workspaceName={activeProfile.name}
                pressCounts={heatmapCounts[activeProfileId] || {}}
                onOpenRemap={(idx) => {
                  setRemapKeyIdx(idx);
                  setRemapModalOpen(true);
                }}
                onSelectSimKey={(idx) => {
                  setSelectedSimKey(idx);
                  setCurrentSimTravel(keysStatus[idx]?.travel || 0.0);
                }}
                onResetHeatmap={handleResetHeatmap}
              />
            </div>
          </div>
        </div>

        {/* Right Column (5 cols): Inspection Drawer & DSP Tuning Deck */}
        <div className="lg:col-span-5 flex flex-col gap-3.5">
          {/* Selected Key Quick Inspector Drawer */}
          <SelectedKeyInspector
            keyIdx={selectedSimKey}
            layerKey={currentLayerKeyDef}
            status={activeKeyObj}
            workspaceName={activeProfile.name}
            onOpenRemap={(idx: number) => {
              setRemapKeyIdx(idx);
              setRemapModalOpen(true);
            }}
            onSimulatePress={(idx: number) => {
              handleSimTravelChange(idx, 2.5);
              setTimeout(() => handleSimTravelChange(idx, 0.0), 120);
            }}
          />

          {/* Controller Deck with Clean Tabs */}
          <div className="bg-[#ffffff] border border-[#ded7ca] rounded-2xl p-4 sm:p-5 flex flex-col gap-3 shadow-sm">
            {/* Deck Navigation Tabs */}
            <div className="flex bg-[#f6f3ec] p-1 rounded-xl gap-1 border border-[#ded7ca]">
              <button
                onClick={() => setDeckTab('tuning')}
                className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 ${
                  deckTab === 'tuning'
                    ? 'bg-[#ffffff] text-[#153641] shadow-xs border border-[#ded7ca]'
                    : 'text-[#5a6a72] hover:text-[#1b2930]'
                }`}
              >
                <Sliders className="w-3.5 h-3.5 text-[#c86443]" />
                <span className="hidden sm:inline">Trigger &amp; DSP</span>
                <span className="sm:hidden">DSP</span>
              </button>
              <button
                onClick={() => setDeckTab('encoder')}
                className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 ${
                  deckTab === 'encoder'
                    ? 'bg-[#ffffff] text-[#153641] shadow-xs border border-[#ded7ca]'
                    : 'text-[#5a6a72] hover:text-[#1b2930]'
                }`}
              >
                <Disc3 className="w-3.5 h-3.5 text-[#5b8e85]" />
                <span className="hidden sm:inline">Dial Actions</span>
                <span className="sm:hidden">Dial</span>
              </button>
              <button
                onClick={() => setDeckTab('tools')}
                className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 ${
                  deckTab === 'tools'
                    ? 'bg-[#ffffff] text-[#153641] shadow-xs border border-[#ded7ca]'
                    : 'text-[#5a6a72] hover:text-[#1b2930]'
                }`}
              >
                <Wrench className="w-3.5 h-3.5 text-[#c86443]" />
                <span>Tools</span>
              </button>
              <button
                onClick={() => setDeckTab('console')}
                className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 ${
                  deckTab === 'console'
                    ? 'bg-[#ffffff] text-[#153641] shadow-xs border border-[#ded7ca]'
                    : 'text-[#5a6a72] hover:text-[#1b2930]'
                }`}
              >
                <Terminal className="w-3.5 h-3.5 text-[#153641]" />
                <span>Console</span>
              </button>
            </div>

            {/* Deck Tab Content */}
            {deckTab === 'tuning' && (
              <RapidTriggerTuning
                actuation={deviceConfig.actuation}
                rtSens={deviceConfig.rt_sens}
                rtEnabled={deviceConfig.rt_enabled}
                selectedSimKey={selectedSimKey}
                currentSimTravel={currentSimTravel}
                isSimPressed={activeKeyObj.pressed}
                customKeyActuation={currentLayerKeyDef?.customActuation}
                onActuationChange={handleActuationChange}
                onRtSensChange={handleRtSensChange}
                onRtToggle={handleRtToggle}
                onSimTravelChange={handleSimTravelChange}
                onSelectSimKey={(idx) => {
                  setSelectedSimKey(idx);
                  setCurrentSimTravel(keysStatus[idx]?.travel || 0.0);
                }}
              />
            )}

            {deckTab === 'encoder' && deviceConfig.encoder && (
              <RotaryEncoderDial
                variant="actionsOnly"
                config={deviceConfig.encoder}
                onUpdateConfig={handleUpdateEncoderConfig}
                onTriggerAction={handleTriggerEncoderAction}
              />
            )}

            {deckTab === 'tools' && (
              <div className="flex flex-col gap-3 text-xs">
                <div className="p-3 bg-[#f6f3ec] rounded-xl border border-[#ded7ca] flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="font-bold text-[#1b2930] flex items-center gap-1.5">
                      <Shield className="w-3.5 h-3.5 text-[#153641]" /> Keyboard HID Output
                    </span>
                    <span className="text-[11px] text-[#5a6a72]">
                      Send real keystrokes to connected OS
                    </span>
                  </div>
                  <button
                    onClick={handleToggleHid}
                    className={`px-3 py-1 rounded-lg text-xs font-bold font-mono transition-colors border ${
                      hidEnabled
                        ? 'bg-[#15803d]/15 text-[#15803d] border-[#15803d]/30'
                        : 'bg-[#ffffff] text-[#5a6a72] border-[#ded7ca]'
                    }`}
                  >
                    {hidEnabled ? 'ENABLED' : 'DISABLED'}
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={handleCalibrate}
                    className="p-3 bg-[#faf7f2] hover:bg-[#ede7da] rounded-xl border border-[#ded7ca] text-left transition-colors flex flex-col gap-1 shadow-xs"
                  >
                    <div className="flex items-center gap-1.5 font-bold text-[#1b2930]">
                      <Check className="w-3.5 h-3.5 text-[#15803d]" /> Calibrate Sensors
                    </div>
                    <span className="text-[10px] text-[#5a6a72] leading-tight">
                      Re-zero Hall rest baselines
                    </span>
                  </button>

                  <button
                    onClick={handleScreensaver}
                    className="p-3 bg-[#faf7f2] hover:bg-[#ede7da] rounded-xl border border-[#ded7ca] text-left transition-colors flex flex-col gap-1 shadow-xs"
                  >
                    <div className="flex items-center gap-1.5 font-bold text-[#1b2930]">
                      <Sparkles className="w-3.5 h-3.5 text-[#c86443]" /> Screensaver Test
                    </div>
                    <span className="text-[10px] text-[#5a6a72] leading-tight">
                      Trigger OLED animations
                    </span>
                  </button>

                  <button
                    onClick={handleBootsel}
                    className="p-3 bg-[#faf7f2] hover:bg-[#ede7da] rounded-xl border border-[#ded7ca] text-left transition-colors flex flex-col gap-1 shadow-xs"
                  >
                    <div className="flex items-center gap-1.5 font-bold text-[#1b2930]">
                      <DownloadCloud className="w-3.5 h-3.5 text-[#5a6a72]" /> USB Bootloader
                    </div>
                    <span className="text-[10px] text-[#5a6a72] leading-tight">
                      Reboot RP2040 into UF2 mode
                    </span>
                  </button>

                  <button
                    onClick={() => setHardwareInfoOpen(true)}
                    className="p-3 bg-[#faf7f2] hover:bg-[#ede7da] rounded-xl border border-[#ded7ca] text-left transition-colors flex flex-col gap-1 shadow-xs"
                  >
                    <div className="flex items-center gap-1.5 font-bold text-[#1b2930]">
                      <Info className="w-3.5 h-3.5 text-[#153641]" /> Hardware Specs
                    </div>
                    <span className="text-[10px] text-[#5a6a72] leading-tight">
                      Pinout &amp; MCU details
                    </span>
                  </button>

                  <button
                    onClick={handleSaveFlash}
                    className="p-3 bg-[#faf7f2] hover:bg-[#ede7da] rounded-xl border border-[#ded7ca] text-left transition-colors flex flex-col gap-1 shadow-xs"
                    title="Commit current configuration to non-volatile RP2040 flash"
                  >
                    <div className="flex items-center gap-1.5 font-bold text-[#1b2930]">
                      <Save className="w-3.5 h-3.5 text-[#5b8e85]" /> Commit to Flash
                    </div>
                    <span className="text-[10px] text-[#5a6a72] leading-tight">
                      Save active RAM to flash
                    </span>
                  </button>
                </div>

                <div className="pt-1 border-t border-[#f0ebdF]">
                  <button
                    onClick={handleFactoryReset}
                    className="w-full p-2.5 bg-red-50 hover:bg-red-100/80 text-red-700 rounded-xl border border-red-200 text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Factory Reset All Profiles &amp; Baselines</span>
                  </button>
                </div>
              </div>
            )}

            {deckTab === 'console' && (
              <SerialConsole
                logs={logs}
                onSendCommand={sendSerialCommand}
                onClearLogs={() => setLogs([])}
              />
            )}
          </div>
        </div>
      </div>

      {/* Key Remap Modal */}
      {currentLayerKeyDef && (
        <RemapModal
          isOpen={remapModalOpen}
          keyIdx={remapKeyIdx}
          currentKey={currentLayerKeyDef}
          workspaceName={activeProfile.name}
          onClose={() => setRemapModalOpen(false)}
          onSave={handleSaveRemapKey}
        />
      )}

      {/* Hardware Specs Modal */}
      <HardwareInfoModal
        isOpen={hardwareInfoOpen}
        onClose={() => setHardwareInfoOpen(false)}
      />

      {/* OLED Visual Theme Customizer Modal */}
      <OledThemeModal
        isOpen={oledThemeModalOpen}
        profileName={activeProfile.name}
        currentTheme={activeProfile.oledTheme || DEFAULT_OLED_THEME}
        onClose={() => setOledThemeModalOpen(false)}
        onSaveTheme={handleSaveOledTheme}
      />

      {/* Automatic Firmware Flashing Modal */}
      <FlashFirmwareModal
        isOpen={flashModalOpen}
        onClose={() => setFlashModalOpen(false)}
        onFlashComplete={() => {
          showToast(`Firmware v2.4.1 flashed and verified successfully!`);
          addLog('INFO', `Flash complete: RP2040 running v2.4.1, workspace "${activeProfile.name}" synced.`);
        }}
        activeWorkspaceName={activeProfile.name}
      />
    </div>
  );
};
export default App;
