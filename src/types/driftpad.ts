export interface LayerKey {
  idx: number;
  code: number;
  label: string;
}

export interface DeviceConfig {
  actuation: number; // in mm (0.10 - 3.80)
  rt_sens: number; // in mm (0.10 - 2.00)
  rt_enabled: boolean;
  active_layer: number; // 0, 1, 2
  layers: LayerKey[][];
}

export interface KeyStatus {
  idx: number;
  pressed: boolean;
  travel: number; // in mm
  label: string;
  peakDepth?: number;
  valleyDepth?: number;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  direction: 'TX' | 'RX' | 'INFO' | 'ERR';
  text: string;
}

export type ScreensaverAnimation = 0 | 1 | 2 | 3 | 4 | 5;

export const SCREENSAVER_NAMES: Record<ScreensaverAnimation, string> = {
  0: '3D Warp Starfield',
  1: 'Cyber Rain',
  2: 'Analog Oscilloscope',
  3: 'Synthwave 3D Grid',
  4: 'Magnetic Ripples',
  5: 'Game of Life',
};

export interface SerialCommandReply {
  status?: 'ok' | 'error';
  type?: 'config' | 'status' | 'sim_event' | 'pong';
  msg?: string;
  actuation?: number;
  rt_sens?: number;
  rt_enabled?: boolean;
  active_layer?: number;
  layers?: LayerKey[][];
  last_key?: number;
  keys?: KeyStatus[];
  key?: number;
  travel?: number | string;
  pressed?: boolean;
  streaming?: boolean;
  fullscreen?: boolean;
  screensaver?: boolean;
  sleep?: boolean;
  wake?: boolean;
  anim?: number;
  bootsel?: boolean;
  hid_output?: boolean;
}

export const DEFAULT_KEYMAPS: LayerKey[][] = [
  // Layer 0: Numpad / Calc
  [
    { idx: 0, code: 177, label: "ESC" }, { idx: 1, code: 55, label: "7" }, { idx: 2, code: 56, label: "8" }, { idx: 3, code: 57, label: "9" },
    { idx: 4, code: 240, label: "M1" },  { idx: 5, code: 52, label: "4" }, { idx: 6, code: 53, label: "5" }, { idx: 7, code: 54, label: "6" },
    { idx: 8, code: 241, label: "M2" },  { idx: 9, code: 49, label: "1" }, { idx: 10, code: 50, label: "2" }, { idx: 11, code: 51, label: "3" },
    { idx: 12, code: 242, label: "M3" }, { idx: 13, code: 243, label: "M4" }, { idx: 14, code: 48, label: "0" }, { idx: 15, code: 176, label: "ENT" }
  ],
  // Layer 1: Navigation & Editing
  [
    { idx: 0, code: 177, label: "ESC" }, { idx: 1, code: 210, label: "HOME" }, { idx: 2, code: 218, label: "UP" },   { idx: 3, code: 211, label: "PGUP" },
    { idx: 4, code: 179, label: "TAB" }, { idx: 5, code: 216, label: "LEFT" }, { idx: 6, code: 217, label: "DOWN" }, { idx: 7, code: 215, label: "RGHT" },
    { idx: 8, code: 209, label: "INS" }, { idx: 9, code: 213, label: "END" },  { idx: 10, code: 217, label: "DOWN" }, { idx: 11, code: 214, label: "PGDN" },
    { idx: 12, code: 178, label: "BSPC" }, { idx: 13, code: 212, label: "DEL" }, { idx: 14, code: 32, label: "SPCE" }, { idx: 15, code: 176, label: "ENT" }
  ],
  // Layer 2: Ultra-Fast Gaming WASD Cluster
  [
    { idx: 0, code: 177, label: "ESC" },  { idx: 1, code: 49, label: "1" },    { idx: 2, code: 50, label: "2" },    { idx: 3, code: 51, label: "3" },
    { idx: 4, code: 179, label: "TAB" },  { idx: 5, code: 113, label: "Q" },   { idx: 6, code: 119, label: "W" },   { idx: 7, code: 101, label: "E" },
    { idx: 8, code: 129, label: "SHFT" }, { idx: 9, code: 97, label: "A" },    { idx: 10, code: 115, label: "S" },  { idx: 11, code: 100, label: "D" },
    { idx: 12, code: 128, label: "CTRL" }, { idx: 13, code: 114, label: "R" },  { idx: 14, code: 32, label: "SPCE" }, { idx: 15, code: 102, label: "F" }
  ]
];

export const INITIAL_DEVICE_CONFIG: DeviceConfig = {
  actuation: 1.20,
  rt_sens: 0.20,
  rt_enabled: true,
  active_layer: 0,
  layers: JSON.parse(JSON.stringify(DEFAULT_KEYMAPS))
};

export const COMMON_KEYCODES: { label: string; code: number; category: string }[] = [
  // Numbers
  { label: '0', code: 48, category: 'Numbers' },
  { label: '1', code: 49, category: 'Numbers' },
  { label: '2', code: 50, category: 'Numbers' },
  { label: '3', code: 51, category: 'Numbers' },
  { label: '4', code: 52, category: 'Numbers' },
  { label: '5', code: 53, category: 'Numbers' },
  { label: '6', code: 54, category: 'Numbers' },
  { label: '7', code: 55, category: 'Numbers' },
  { label: '8', code: 56, category: 'Numbers' },
  { label: '9', code: 57, category: 'Numbers' },

  // Letters (Lowercase ASCII sent by Arduino Keyboard.print / write)
  { label: 'A', code: 97, category: 'Letters' },
  { label: 'B', code: 98, category: 'Letters' },
  { label: 'C', code: 99, category: 'Letters' },
  { label: 'D', code: 100, category: 'Letters' },
  { label: 'E', code: 101, category: 'Letters' },
  { label: 'F', code: 102, category: 'Letters' },
  { label: 'G', code: 103, category: 'Letters' },
  { label: 'H', code: 104, category: 'Letters' },
  { label: 'I', code: 105, category: 'Letters' },
  { label: 'J', code: 106, category: 'Letters' },
  { label: 'K', code: 107, category: 'Letters' },
  { label: 'L', code: 108, category: 'Letters' },
  { label: 'M', code: 109, category: 'Letters' },
  { label: 'N', code: 110, category: 'Letters' },
  { label: 'O', code: 111, category: 'Letters' },
  { label: 'P', code: 112, category: 'Letters' },
  { label: 'Q', code: 113, category: 'Letters' },
  { label: 'R', code: 114, category: 'Letters' },
  { label: 'S', code: 115, category: 'Letters' },
  { label: 'T', code: 116, category: 'Letters' },
  { label: 'U', code: 117, category: 'Letters' },
  { label: 'V', code: 118, category: 'Letters' },
  { label: 'W', code: 119, category: 'Letters' },
  { label: 'X', code: 120, category: 'Letters' },
  { label: 'Y', code: 121, category: 'Letters' },
  { label: 'Z', code: 122, category: 'Letters' },

  // Navigation
  { label: 'UP', code: 218, category: 'Navigation' },
  { label: 'DOWN', code: 217, category: 'Navigation' },
  { label: 'LEFT', code: 216, category: 'Navigation' },
  { label: 'RGHT', code: 215, category: 'Navigation' },
  { label: 'HOME', code: 210, category: 'Navigation' },
  { label: 'END', code: 213, category: 'Navigation' },
  { label: 'PGUP', code: 211, category: 'Navigation' },
  { label: 'PGDN', code: 214, category: 'Navigation' },
  { label: 'INS', code: 209, category: 'Navigation' },
  { label: 'DEL', code: 212, category: 'Navigation' },

  // Editing & Controls
  { label: 'ESC', code: 177, category: 'Control' },
  { label: 'ENT', code: 176, category: 'Control' },
  { label: 'TAB', code: 179, category: 'Control' },
  { label: 'BSPC', code: 178, category: 'Control' },
  { label: 'SPCE', code: 32, category: 'Control' },
  { label: 'SHFT', code: 129, category: 'Control' },
  { label: 'CTRL', code: 128, category: 'Control' },
  { label: 'ALT', code: 130, category: 'Control' },

  // Macros / Functions
  { label: 'M1', code: 240, category: 'Function/Macro' },
  { label: 'M2', code: 241, category: 'Function/Macro' },
  { label: 'M3', code: 242, category: 'Function/Macro' },
  { label: 'M4', code: 243, category: 'Function/Macro' },
  { label: 'F1', code: 194, category: 'Function/Macro' },
  { label: 'F2', code: 195, category: 'Function/Macro' },
  { label: 'F3', code: 196, category: 'Function/Macro' },
  { label: 'F4', code: 197, category: 'Function/Macro' },
  { label: 'F5', code: 198, category: 'Function/Macro' }
];
