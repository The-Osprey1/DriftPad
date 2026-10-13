import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  DeviceConfig,
  KeyStatus,
  LogEntry,
  INITIAL_DEVICE_CONFIG,
  SerialCommandReply,
} from './types/driftpad';
import { SerialService, ConnectionMode } from './services/serialService';
import { DriftPadDspEngine } from './engine/dspEngine';
import { Header } from './components/Header';
import { KeyMatrix } from './components/KeyMatrix';
import { RapidTriggerTuning } from './components/RapidTriggerTuning';
import { OledCanvas } from './components/OledCanvas';
import { SerialConsole } from './components/SerialConsole';
import { RemapModal } from './components/RemapModal';
import { HardwareInfoModal } from './components/HardwareInfoModal';

export const App: React.FC = () => {
  // Services refs
  const serialServiceRef = useRef<SerialService>(new SerialService());
  const dspEngineRef = useRef<DriftPadDspEngine | null>(null);

  // App States
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('virtual');
  const [deviceConfig, setDeviceConfig] = useState<DeviceConfig>(INITIAL_DEVICE_CONFIG);
  const [keysStatus, setKeysStatus] = useState<KeyStatus[]>([]);
  const [selectedSimKey, setSelectedSimKey] = useState<number>(0);
  const [currentSimTravel, setCurrentSimTravel] = useState<number>(0.0);
  const [hidEnabled, setHidEnabled] = useState<boolean>(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // OLED & Screensaver states
  const [isSleeping, setIsSleeping] = useState<boolean>(false);
  const [screensaverActive, setScreensaverActive] = useState<boolean>(false);
  const [forcedAnim, setForcedAnim] = useState<number>(-1);

  // Modals
  const [remapModalOpen, setRemapModalOpen] = useState<boolean>(false);
  const [remapKeyIdx, setRemapKeyIdx] = useState<number>(0);
  const [hardwareInfoOpen, setHardwareInfoOpen] = useState<boolean>(false);

  // Append to serial logs
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

  // Handle incoming line from device or emulator
  const handleIncomingLine = useCallback(
    (line: string) => {
      try {
        const data: SerialCommandReply = JSON.parse(line);

        if (data.type === 'config') {
          setDeviceConfig((prev) => ({
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
          }
        } else if (data.status === 'ok') {
          if (data.screensaver !== undefined) setScreensaverActive(data.screensaver);
          if (data.sleep !== undefined) setIsSleeping(data.sleep);
          if (data.wake !== undefined) setIsSleeping(!data.wake);
          if (data.anim !== undefined) setForcedAnim(data.anim);
          if (data.hid_output !== undefined) setHidEnabled(data.hid_output);
        }
      } catch {
        // Plain telemetry or text string
      }
    },
    [selectedSimKey]
  );

  // Send a serial command to real hardware or virtual DSP engine
  const sendSerialCommand = useCallback(
    (cmd: string) => {
      const trimmed = cmd.trim();
      if (!trimmed) return;

      if (connectionMode === 'hardware' && serialServiceRef.current.isConnected()) {
        serialServiceRef.current.sendCommand(trimmed);
      } else {
        // Route to internal DSP Engine
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

  // Initialize DSP engine and default states
  useEffect(() => {
    const engine = new DriftPadDspEngine((line) => {
      addLog('RX', line);
      handleIncomingLine(line);
    });
    dspEngineRef.current = engine;

    setDeviceConfig(engine.getConfig());
    setKeysStatus(engine.getKeysStatus());

    addLog('INFO', 'DriftPad Digital Twin DSP engine initialized.');
    addLog('INFO', 'Hardware & Simulation ready. Use sliders or keyboard to test Rapid Trigger.');

    // Serial callbacks
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

  // Connect / Disconnect Hardware
  const handleConnectToggle = async () => {
    if (connectionMode === 'hardware') {
      await serialServiceRef.current.disconnect();
      setConnectionMode('virtual');
      addLog('INFO', 'Switched back to Digital Twin DSP mode.');
    } else {
      const ok = await serialServiceRef.current.connectHardware();
      if (ok) {
        setConnectionMode('hardware');
      }
    }
  };

  const handleToggleVirtualMode = () => {
    if (connectionMode === 'hardware') {
      serialServiceRef.current.disconnect();
    }
    setConnectionMode((prev) => (prev === 'virtual' ? 'disconnected' : 'virtual'));
    addLog('INFO', `Switched mode to ${connectionMode === 'virtual' ? 'Disconnected' : 'Virtual'}`);
  };

  const handleSelectLayer = (layer: number) => {
    setDeviceConfig((prev) => ({ ...prev, active_layer: layer }));
    sendSerialCommand(`SET_LAYER ${layer}`);
  };

  const handleActuationChange = (val: number) => {
    const clamped = Number(Math.max(0.1, Math.min(3.8, val)).toFixed(2));
    setDeviceConfig((prev) => ({ ...prev, actuation: clamped }));
    sendSerialCommand(`SET_ACTUATION ${clamped.toFixed(2)}`);
  };

  const handleRtSensChange = (val: number) => {
    const clamped = Number(Math.max(0.1, Math.min(2.0, val)).toFixed(2));
    setDeviceConfig((prev) => ({ ...prev, rt_sens: clamped }));
    sendSerialCommand(`SET_RT_SENS ${clamped.toFixed(2)}`);
  };

  const handleRtToggle = (enabled: boolean) => {
    setDeviceConfig((prev) => ({ ...prev, rt_enabled: enabled }));
    sendSerialCommand(`SET_RT_ENABLE ${enabled ? 1 : 0}`);
  };

  const handleSimTravelChange = (keyIdx: number, travelMm: number) => {
    const clamped = Math.max(0, Math.min(4.0, travelMm));
    setCurrentSimTravel(clamped);

    if (dspEngineRef.current) {
      dspEngineRef.current.injectTravel(keyIdx, clamped);
      setKeysStatus(dspEngineRef.current.getKeysStatus());

      if (connectionMode === 'hardware') {
        sendSerialCommand(`SIM ${keyIdx} ${clamped.toFixed(2)}`);
      }
    }
  };

  const handleToggleHid = () => {
    const next = !hidEnabled;
    setHidEnabled(next);
    sendSerialCommand(`SET_HID ${next ? 1 : 0}`);
  };

  const handleSaveFlash = () => {
    sendSerialCommand('SAVE');
  };

  const handleFactoryReset = () => {
    if (window.confirm('Reset all settings, actuation points, and keymaps to factory defaults?')) {
      sendSerialCommand('RESET');
      setTimeout(() => sendSerialCommand('GET_CONFIG'), 150);
    }
  };

  const handleCalibrate = () => {
    sendSerialCommand('CALIBRATE');
  };

  const handleScreensaver = () => {
    setScreensaverActive(true);
    sendSerialCommand('SCREENSAVER');
  };

  const handleBootsel = () => {
    if (window.confirm('Reboot RP2040 into USB Mass Storage Bootloader for flashing?')) {
      sendSerialCommand('BOOTSEL');
    }
  };

  const handleOpenRemap = (keyIdx: number) => {
    setRemapKeyIdx(keyIdx);
    setRemapModalOpen(true);
  };

  const handleSaveRemapKey = (layer: number, keyIdx: number, code: number, label: string) => {
    setDeviceConfig((prev) => {
      const nextLayers = prev.layers.map((lArr, lIdx) => {
        if (lIdx !== layer) return lArr;
        const newKeys = [...lArr];
        newKeys[keyIdx] = { idx: keyIdx, code, label };
        return newKeys;
      });
      return { ...prev, layers: nextLayers };
    });

    sendSerialCommand(`SET_KEY ${layer} ${keyIdx} ${code} ${label}`);
  };

  // Physical keyboard key listener for intuitive testing!
  useEffect(() => {
    const keyMapToIdx: Record<string, number> = {
      // WASD / Game layout keys
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
      // Numpad physical keys
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
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return; // Don't intercept while user is typing in inputs
      }
      const idx = keyMapToIdx[e.code];
      if (idx !== undefined) {
        setSelectedSimKey(idx);
        handleSimTravelChange(idx, 2.5); // Push down to 2.5mm
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      const idx = keyMapToIdx[e.code];
      if (idx !== undefined) {
        handleSimTravelChange(idx, 0.0); // Release to 0mm
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  const activeKeyObj = keysStatus[selectedSimKey] || {
    idx: selectedSimKey,
    pressed: false,
    travel: 0,
    label: '',
  };

  return (
    <div className="min-h-screen bg-[#0f1117] text-[#f3f4f6] flex flex-col p-3 sm:p-6 gap-5 max-w-7xl mx-auto">
      {/* Top Header Navigation */}
      <Header
        connectionMode={connectionMode}
        hidEnabled={hidEnabled}
        onConnectToggle={handleConnectToggle}
        onToggleVirtualMode={handleToggleVirtualMode}
        onToggleHid={handleToggleHid}
        onSaveFlash={handleSaveFlash}
        onFactoryReset={handleFactoryReset}
        onCalibrate={handleCalibrate}
        onScreensaver={handleScreensaver}
        onBootsel={handleBootsel}
        onOpenHardwareInfo={() => setHardwareInfoOpen(true)}
      />

      {/* Main Grid: 2 Columns */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left Column: 16-Key Matrix Map & OLED Visualizer (7 cols) */}
        <div className="lg:col-span-7 flex flex-col gap-5">
          {/* Key Matrix Card */}
          <div className="bg-[#181c27] border border-[#2d3748] rounded-2xl p-5 shadow-xl flex flex-col gap-4">
            <div className="flex justify-between items-center border-b border-[#2d3748] pb-3">
              <span className="text-sm font-bold uppercase tracking-wider text-[#00f2fe]">
                16-Key Analog Matrix Map
              </span>
              <span className="text-xs font-mono font-bold text-[#00f2fe] bg-[#00f2fe]/10 px-2.5 py-1 rounded border border-[#00f2fe]/20">
                Layer {deviceConfig.active_layer}:{' '}
                {deviceConfig.active_layer === 0
                  ? 'Numpad'
                  : deviceConfig.active_layer === 1
                  ? 'Navigation'
                  : 'WASD Gaming'}
              </span>
            </div>

            <KeyMatrix
              activeLayer={deviceConfig.active_layer}
              layers={deviceConfig.layers}
              keysStatus={keysStatus}
              selectedSimKey={selectedSimKey}
              onSelectLayer={handleSelectLayer}
              onOpenRemap={handleOpenRemap}
              onSelectSimKey={(idx) => {
                setSelectedSimKey(idx);
                setCurrentSimTravel(keysStatus[idx]?.travel || 0.0);
              }}
            />
          </div>

          {/* Real-time SSD1306 128x64 OLED Cockpit Display Canvas */}
          <OledCanvas
            activeLayer={deviceConfig.active_layer}
            actuation={deviceConfig.actuation}
            rtSens={deviceConfig.rt_sens}
            rtEnabled={deviceConfig.rt_enabled}
            keys={keysStatus}
            lastActiveKey={selectedSimKey}
            isSleeping={isSleeping}
            screensaverActive={screensaverActive}
            forcedAnim={forcedAnim}
            onSendSerialCommand={sendSerialCommand}
          />
        </div>

        {/* Right Column: Rapid Trigger Tuning & Switch Simulation (5 cols) */}
        <div className="lg:col-span-5 flex flex-col gap-5">
          {/* Tuning Card */}
          <div className="bg-[#181c27] border border-[#2d3748] rounded-2xl p-5 shadow-xl flex flex-col gap-4">
            <div className="flex justify-between items-center border-b border-[#2d3748] pb-3">
              <span className="text-sm font-bold uppercase tracking-wider text-[#00f2fe]">
                Rapid Trigger &amp; DSP Tuning
              </span>
              <span className="text-xs text-emerald-400 font-mono font-bold flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                ACTIVE DSP ENGINE
              </span>
            </div>

            <RapidTriggerTuning
              actuation={deviceConfig.actuation}
              rtSens={deviceConfig.rt_sens}
              rtEnabled={deviceConfig.rt_enabled}
              selectedSimKey={selectedSimKey}
              currentSimTravel={currentSimTravel}
              isSimPressed={activeKeyObj.pressed}
              onActuationChange={handleActuationChange}
              onRtSensChange={handleRtSensChange}
              onRtToggle={handleRtToggle}
              onSimTravelChange={handleSimTravelChange}
              onSelectSimKey={(idx) => {
                setSelectedSimKey(idx);
                setCurrentSimTravel(keysStatus[idx]?.travel || 0.0);
              }}
            />
          </div>

          {/* Serial Terminal Console */}
          <SerialConsole
            logs={logs}
            onSendCommand={sendSerialCommand}
            onClearLogs={() => setLogs([])}
          />
        </div>
      </div>

      {/* Key Remap Modal */}
      <RemapModal
        isOpen={remapModalOpen}
        activeLayer={deviceConfig.active_layer}
        keyIdx={remapKeyIdx}
        currentLabel={deviceConfig.layers[deviceConfig.active_layer]?.[remapKeyIdx]?.label || ''}
        currentCode={deviceConfig.layers[deviceConfig.active_layer]?.[remapKeyIdx]?.code || 0}
        onClose={() => setRemapModalOpen(false)}
        onSave={handleSaveRemapKey}
      />

      {/* Hardware Info Specification Modal */}
      <HardwareInfoModal
        isOpen={hardwareInfoOpen}
        onClose={() => setHardwareInfoOpen(false)}
      />
    </div>
  );
};
export default App;
