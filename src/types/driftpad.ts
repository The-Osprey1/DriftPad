export interface ModifierFlags {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export interface LayerKey {
  idx: number;
  code: number;
  label: string;
  modifiers?: ModifierFlags;
  customActuation?: number; // Optional per-key override in mm (e.g. 3.5mm for safety on destructive commands)
  description?: string;
}

export interface EncoderAction {
  label: string;
  actionType: 'key' | 'combo' | 'zoom' | 'scrub' | 'volume' | 'scroll';
  code?: number;
  modifiers?: ModifierFlags;
  delta?: number;
  description?: string;
}

export interface EncoderConfig {
  name: string;
  cw: EncoderAction;
  ccw: EncoderAction;
  click: EncoderAction;
}

export interface OledThemeConfig {
  background: string;
  textColor: string;
  graphColor: string;
  dimColor: string;
  accentColor: string;
}

export interface OledThemePreset {
  id: string;
  name: string;
  description: string;
  theme: OledThemeConfig;
}

export const MONOCHROME_WHITE_OLED_THEME: OledThemeConfig = {
  background: '#04070a',
  textColor: '#ffffff',
  graphColor: '#ffffff',
  dimColor: '#283238',
  accentColor: '#ffffff',
};

export const SOFT_COASTAL_OLED_THEME: OledThemeConfig = {
  background: '#12242b',
  textColor: '#e8f1ee',
  graphColor: '#71938c',
  dimColor: '#28464f',
  accentColor: '#e07a5f',
};

export const DEFAULT_OLED_THEME: OledThemeConfig = MONOCHROME_WHITE_OLED_THEME;

export const OLED_THEME_PRESETS: OledThemePreset[] = [
  {
    id: 'monochrome-white',
    name: 'Hardware Pure White (Single-Color)',
    description: 'Hardware 128x64 monochrome white OLED: crisp white on deep obsidian glass',
    theme: MONOCHROME_WHITE_OLED_THEME,
  },
  {
    id: 'soft-coastal',
    name: 'Soft & Coastal',
    description: 'Dark teal background with terracotta clay & sea-glass sage accents',
    theme: SOFT_COASTAL_OLED_THEME,
  },
  {
    id: 'cyber-cyan',
    name: 'Cyber Cyan',
    description: 'Classic SSD1306 electric cyan on deep obsidian black',
    theme: {
      background: '#05080f',
      textColor: '#00f2fe',
      graphColor: '#00f2fe',
      dimColor: '#0f4c5c',
      accentColor: '#f59e0b',
    },
  },
  {
    id: 'crisp-white',
    name: 'Pure Monochrome',
    description: 'High-contrast studio paper white on true black OLED',
    theme: {
      background: '#000000',
      textColor: '#ffffff',
      graphColor: '#e2e8f0',
      dimColor: '#334155',
      accentColor: '#38bdf8',
    },
  },
  {
    id: 'retro-amber',
    name: 'Phosphor Amber',
    description: 'Warm vintage VT220 terminal CRT amber glow',
    theme: {
      background: '#0d0900',
      textColor: '#ffb000',
      graphColor: '#ff9900',
      dimColor: '#4d3300',
      accentColor: '#ff4d4d',
    },
  },
  {
    id: 'matrix-green',
    name: 'Phosphor P1 Green',
    description: 'Iconic monochrome green phosphor terminal',
    theme: {
      background: '#000f04',
      textColor: '#00ff66',
      graphColor: '#00e65c',
      dimColor: '#00471b',
      accentColor: '#ffee00',
    },
  },
  {
    id: 'tokyo-neon',
    name: 'Tokyo Neon Synth',
    description: 'Vibrant hot magenta with electric cyan graphing',
    theme: {
      background: '#0c040d',
      textColor: '#ff2a85',
      graphColor: '#00f2fe',
      dimColor: '#4d1235',
      accentColor: '#facc15',
    },
  },
  {
    id: 'emerald-mint',
    name: 'Studio Mint',
    description: 'Calm analog synthesizer jade and mint indicators',
    theme: {
      background: '#021410',
      textColor: '#2dd4bf',
      graphColor: '#34d399',
      dimColor: '#0d382f',
      accentColor: '#fbbf24',
    },
  },
  {
    id: 'solar-orange',
    name: 'Solar Flare',
    description: 'Warm industrial safety orange with gold telemetry',
    theme: {
      background: '#0f0502',
      textColor: '#ff5722',
      graphColor: '#ff9800',
      dimColor: '#4a1707',
      accentColor: '#ffeb3b',
    },
  },
  {
    id: 'stealth-violet',
    name: 'Deep Ultraviolet',
    description: 'Subtle violet night mode for low ambient distraction',
    theme: {
      background: '#080512',
      textColor: '#a855f7',
      graphColor: '#c084fc',
      dimColor: '#3b1d61',
      accentColor: '#06b6d4',
    },
  },
];

export interface ProductivityProfile {
  id: string;
  name: string;
  category: 'developer' | 'video' | '3d_cad' | 'finance' | 'design' | 'custom';
  description: string;
  layers: LayerKey[][];
  encoder: EncoderConfig;
  tuning: {
    actuation: number;
    rt_sens: number;
    rt_enabled: boolean;
  };
  oledTheme?: OledThemeConfig;
  isCustom?: boolean;
}

export interface DeviceConfig {
  actuation: number; // in mm (0.10 - 3.80)
  rt_sens: number; // in mm (0.10 - 2.00)
  rt_enabled: boolean;
  active_layer: number; // 0, 1, 2
  layers: LayerKey[][];
  activeProfileId?: string;
  encoder?: EncoderConfig;
}

export interface KeyStatus {
  idx: number;
  pressed: boolean;
  travel: number; // in mm
  label: string;
  peakDepth?: number;
  valleyDepth?: number;
  customActuation?: number;
  pressCount?: number;
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

// ==========================================
// CURATED PRODUCTIVITY PROFILES
// ==========================================

export const PRODUCTIVITY_PROFILES: ProductivityProfile[] = [
  {
    id: 'number-pad',
    name: 'Standard Number Pad & Calc',
    category: 'finance',
    description: 'Hardware 16-key tactile numpad: ESC, 7-8-9, 4-5-6, 1-2-3, 0, operators (+, -, *, /), navigation layer, and math formulas.',
    tuning: { actuation: 1.50, rt_sens: 0.25, rt_enabled: true },
    oledTheme: MONOCHROME_WHITE_OLED_THEME,
    encoder: {
      name: 'Volume & Cell Step',
      cw: { label: 'Vol Up / Step +', actionType: 'volume', delta: 1, description: 'Volume Up / Step +' },
      ccw: { label: 'Vol Dn / Step -', actionType: 'volume', delta: -1, description: 'Volume Down / Step -' },
      click: { label: 'Calc Clear / Reset', actionType: 'key', code: 177, description: 'Clear / Esc' }
    },
    layers: [
      // L0: Standard 4x4 Number Pad
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Escape / Clear' },
        { idx: 1, code: 55, label: '7', description: 'Number 7' },
        { idx: 2, code: 56, label: '8', description: 'Number 8' },
        { idx: 3, code: 57, label: '9', description: 'Number 9' },
        { idx: 4, code: 47, label: '/', description: 'Divide (/)' },
        { idx: 5, code: 52, label: '4', description: 'Number 4' },
        { idx: 6, code: 53, label: '5', description: 'Number 5' },
        { idx: 7, code: 54, label: '6', description: 'Number 6' },
        { idx: 8, code: 42, label: '*', description: 'Multiply (*)' },
        { idx: 9, code: 49, label: '1', description: 'Number 1' },
        { idx: 10, code: 50, label: '2', description: 'Number 2' },
        { idx: 11, code: 51, label: '3', description: 'Number 3' },
        { idx: 12, code: 45, label: '-', description: 'Minus (-)' },
        { idx: 13, code: 43, label: '+', description: 'Plus (+)' },
        { idx: 14, code: 48, label: '0', description: 'Number 0' },
        { idx: 15, code: 176, label: 'ENT', description: 'Enter / Commit' }
      ],
      // L1: Navigation & Quick Editing
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Escape' },
        { idx: 1, code: 210, label: 'HOME', description: 'Home' },
        { idx: 2, code: 218, label: 'UP', description: 'Cursor Up' },
        { idx: 3, code: 211, label: 'PGUP', description: 'Page Up' },
        { idx: 4, code: 179, label: 'TAB', description: 'Tab Key' },
        { idx: 5, code: 216, label: 'LEFT', description: 'Cursor Left' },
        { idx: 6, code: 217, label: 'DOWN', description: 'Cursor Down' },
        { idx: 7, code: 215, label: 'RGHT', description: 'Cursor Right' },
        { idx: 8, code: 209, label: 'INS', description: 'Insert' },
        { idx: 9, code: 213, label: 'END', description: 'End of Line' },
        { idx: 10, code: 217, label: 'DOWN', description: 'Cursor Down' },
        { idx: 11, code: 214, label: 'PGDN', description: 'Page Down' },
        { idx: 12, code: 178, label: 'BSPC', description: 'Backspace' },
        { idx: 13, code: 212, label: 'DEL', customActuation: 3.20, description: 'Delete Key' },
        { idx: 14, code: 32, label: 'SPCE', description: 'Spacebar' },
        { idx: 15, code: 176, label: 'ENT', description: 'Enter' }
      ],
      // L2: Financial & Math Functions
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Clear / Cancel' },
        { idx: 1, code: 61, label: 'SUM', modifiers: { alt: true }, description: 'AutoSum (=SUM())' },
        { idx: 2, code: 37, label: '%', description: 'Percent (%)' },
        { idx: 3, code: 61, label: '=', description: 'Equals (=)' },
        { idx: 4, code: 118, label: 'PSTV', modifiers: { ctrl: true, shift: true }, description: 'Paste Values Only' },
        { idx: 5, code: 40, label: '(', description: 'Open Parenthesis (' },
        { idx: 6, code: 41, label: ')', description: 'Close Parenthesis )' },
        { idx: 7, code: 94, label: '^', description: 'Exponent (^)' },
        { idx: 8, code: 99, label: 'COPY', modifiers: { ctrl: true }, description: 'Copy' },
        { idx: 9, code: 118, label: 'PAST', modifiers: { ctrl: true }, description: 'Paste' },
        { idx: 10, code: 122, label: 'UNDO', modifiers: { ctrl: true }, description: 'Undo' },
        { idx: 11, code: 121, label: 'REDO', modifiers: { ctrl: true }, description: 'Redo' },
        { idx: 12, code: 46, label: '.', description: 'Decimal Point (.)' },
        { idx: 13, code: 48, label: '00', description: 'Double Zero (00)' },
        { idx: 14, code: 115, label: 'SAVE', modifiers: { ctrl: true }, description: 'Save Workbook' },
        { idx: 15, code: 176, label: 'ENT', description: 'Commit & Next' }
      ]
    ]
  },
  {
    id: 'developer-git',
    name: 'Code & Terminal Studio',
    category: 'developer',
    description: 'DevOps, Git operations, terminal toggles, debugger stepping, and multi-cursor hotkeys.',
    tuning: { actuation: 1.20, rt_sens: 0.20, rt_enabled: true },
    oledTheme: MONOCHROME_WHITE_OLED_THEME,
    encoder: {
      name: 'Editor Tabs / File Switcher',
      cw: { label: 'Next Tab', actionType: 'combo', code: 179, modifiers: { ctrl: true }, description: 'Ctrl+Tab' },
      ccw: { label: 'Prev Tab', actionType: 'combo', code: 179, modifiers: { ctrl: true, shift: true }, description: 'Ctrl+Shift+Tab' },
      click: { label: 'Quick Open', actionType: 'combo', code: 112, modifiers: { ctrl: true }, description: 'Ctrl+P' }
    },
    layers: [
      // L0: Git & Dev Commands
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Escape / Clear' },
        { idx: 1, code: 112, label: 'PULL', modifiers: { ctrl: true, shift: true }, description: 'Git Pull' },
        { idx: 2, code: 112, label: 'PUSH', modifiers: { ctrl: true, shift: true }, description: 'Git Push' },
        { idx: 3, code: 99, label: 'COMM', modifiers: { ctrl: true, shift: true }, description: 'Git Commit' },
        { idx: 4, code: 96, label: 'TERM', modifiers: { ctrl: true }, description: 'Toggle Terminal (Ctrl+`)' },
        { idx: 5, code: 102, label: 'FMT', modifiers: { shift: true, alt: true }, description: 'Format Document' },
        { idx: 6, code: 98, label: 'BLD', modifiers: { ctrl: true, shift: true }, description: 'Run Build Task' },
        { idx: 7, code: 116, label: 'TEST', modifiers: { ctrl: true, shift: true }, description: 'Run Tests' },
        { idx: 8, code: 102, label: 'FIND', modifiers: { ctrl: true, shift: true }, description: 'Find in Files' },
        { idx: 9, code: 100, label: 'MULT', modifiers: { ctrl: true }, description: 'Add Selection to Next Find' },
        { idx: 10, code: 47, label: 'COMM', modifiers: { ctrl: true }, description: 'Toggle Line Comment' },
        { idx: 11, code: 122, label: 'UNDO', modifiers: { ctrl: true }, description: 'Undo' },
        { idx: 12, code: 115, label: 'SAVE', modifiers: { ctrl: true }, description: 'Save File' },
        { idx: 13, code: 121, label: 'REDO', modifiers: { ctrl: true }, description: 'Redo' },
        { idx: 14, code: 99, label: 'KILL', modifiers: { ctrl: true }, customActuation: 3.50, description: 'Kill Process (Safe 3.5mm Press)' },
        { idx: 15, code: 176, label: 'ENT', description: 'Enter' }
      ],
      // L1: Debugging & Navigation
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Escape' },
        { idx: 1, code: 198, label: 'STEP', description: 'F5 Debug Step' },
        { idx: 2, code: 203, label: 'NEXT', description: 'F10 Step Over' },
        { idx: 3, code: 204, label: 'INTO', description: 'F11 Step Into' },
        { idx: 4, code: 202, label: 'BKP', description: 'F9 Toggle Breakpoint' },
        { idx: 5, code: 216, label: 'LEFT', description: 'Cursor Left' },
        { idx: 6, code: 218, label: 'UP', description: 'Cursor Up' },
        { idx: 7, code: 215, label: 'RGHT', description: 'Cursor Right' },
        { idx: 8, code: 210, label: 'HOME', description: 'Line Start' },
        { idx: 9, code: 217, label: 'DOWN', description: 'Cursor Down' },
        { idx: 10, code: 213, label: 'END', description: 'Line End' },
        { idx: 11, code: 205, label: 'STOP', description: 'Shift+F5 Stop Debug' },
        { idx: 12, code: 178, label: 'BSPC', description: 'Backspace' },
        { idx: 13, code: 212, label: 'DEL', customActuation: 3.00, description: 'Delete' },
        { idx: 14, code: 32, label: 'SPCE', description: 'Space' },
        { idx: 15, code: 176, label: 'ENT', description: 'Enter' }
      ],
      // L2: Window & Workspace Layout
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Escape' },
        { idx: 1, code: 92, label: 'SPLT', modifiers: { ctrl: true }, description: 'Split Editor Window' },
        { idx: 2, code: 119, label: 'CLSE', modifiers: { ctrl: true }, description: 'Close Window Tab' },
        { idx: 3, code: 116, label: 'REOP', modifiers: { ctrl: true, shift: true }, description: 'Reopen Closed Tab' },
        { idx: 4, code: 179, label: 'TAB', description: 'Tab' },
        { idx: 5, code: 49, label: 'GRP1', modifiers: { ctrl: true }, description: 'Focus Group 1' },
        { idx: 6, code: 50, label: 'GRP2', modifiers: { ctrl: true }, description: 'Focus Group 2' },
        { idx: 7, code: 51, label: 'GRP3', modifiers: { ctrl: true }, description: 'Focus Group 3' },
        { idx: 8, code: 115, label: 'SNIP', modifiers: { shift: true, meta: true }, description: 'Screen Snip' },
        { idx: 9, code: 91, label: 'FOLD', modifiers: { ctrl: true, shift: true }, description: 'Fold Code Block' },
        { idx: 10, code: 93, label: 'UNFL', modifiers: { ctrl: true, shift: true }, description: 'Unfold Code Block' },
        { idx: 11, code: 108, label: 'LINE', modifiers: { ctrl: true }, description: 'Select Current Line' },
        { idx: 12, code: 99, label: 'COPY', modifiers: { ctrl: true }, description: 'Copy' },
        { idx: 13, code: 118, label: 'PAST', modifiers: { ctrl: true }, description: 'Paste' },
        { idx: 14, code: 122, label: 'UNDO', modifiers: { ctrl: true }, description: 'Undo' },
        { idx: 15, code: 176, label: 'ENT', description: 'Enter' }
      ]
    ]
  },
  {
    id: 'video-editing',
    name: 'Video Timeline & NLE',
    category: 'video',
    description: 'Precision timeline navigation, jog scrubbing, razor cuts, ripple deletes, and marker dropping.',
    tuning: { actuation: 0.80, rt_sens: 0.15, rt_enabled: true },
    oledTheme: MONOCHROME_WHITE_OLED_THEME,
    encoder: {
      name: 'Timeline Frame Jog / Shuttle',
      cw: { label: 'Jog Right 1 Frame', actionType: 'scrub', code: 215, delta: 1, description: 'Step +1 Frame' },
      ccw: { label: 'Jog Left 1 Frame', actionType: 'scrub', code: 216, delta: -1, description: 'Step -1 Frame' },
      click: { label: 'Play / Pause', actionType: 'key', code: 32, description: 'Spacebar Playhead Toggle' }
    },
    layers: [
      // L0: Timeline Editing
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Selection Tool (V)' },
        { idx: 1, code: 99, label: 'RAZR', description: 'Razor / Cut Tool (C)' },
        { idx: 2, code: 120, label: 'RPLD', modifiers: { shift: true }, customActuation: 2.80, description: 'Ripple Delete' },
        { idx: 3, code: 107, label: 'SPLT', modifiers: { ctrl: true }, description: 'Split Clip at Playhead' },
        { idx: 4, code: 105, label: 'MKIN', description: 'Mark In Point (I)' },
        { idx: 5, code: 111, label: 'MKOT', description: 'Mark Out Point (O)' },
        { idx: 6, code: 109, label: 'MRKR', description: 'Drop Marker (M)' },
        { idx: 7, code: 32, label: 'PLAY', description: 'Play / Pause' },
        { idx: 8, code: 106, label: 'SLOW', description: 'Shuttle Reverse (J)' },
        { idx: 9, code: 107, label: 'STOP', description: 'Shuttle Pause (K)' },
        { idx: 10, code: 108, label: 'FAST', description: 'Shuttle Forward (L)' },
        { idx: 11, code: 115, label: 'SNAP', description: 'Toggle Magnet Snap (S)' },
        { idx: 12, code: 61, label: 'ZM+', modifiers: { ctrl: true }, description: 'Zoom Timeline In' },
        { idx: 13, code: 45, label: 'ZM-', modifiers: { ctrl: true }, description: 'Zoom Timeline Out' },
        { idx: 14, code: 92, label: 'FIT', description: 'Zoom to Entire Sequence' },
        { idx: 15, code: 101, label: 'EXPT', modifiers: { ctrl: true }, description: 'Export Media (Ctrl+M)' }
      ],
      // L1: Audio & Levels
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Escape' },
        { idx: 1, code: 103, label: 'GAIN', description: 'Audio Gain Dialog' },
        { idx: 2, code: 109, label: 'MUTE', description: 'Mute Track' },
        { idx: 3, code: 115, label: 'SOLO', description: 'Solo Track' },
        { idx: 4, code: 100, label: 'DUPL', modifiers: { alt: true }, description: 'Duplicate Track Audio' },
        { idx: 5, code: 216, label: 'JOG<', description: 'Jog 5 Frames Left' },
        { idx: 6, code: 218, label: 'VOL+', description: 'Volume Up' },
        { idx: 7, code: 215, label: 'JOG>', description: 'Jog 5 Frames Right' },
        { idx: 8, code: 108, label: 'NORM', description: 'Normalize Audio' },
        { idx: 9, code: 217, label: 'VOL-', description: 'Volume Down' },
        { idx: 10, code: 114, label: 'REV', description: 'Reverse Audio Clip' },
        { idx: 11, code: 102, label: 'FADE', description: 'Constant Power Crossfade' },
        { idx: 12, code: 99, label: 'COPY', modifiers: { ctrl: true }, description: 'Copy Audio Attributes' },
        { idx: 13, code: 118, label: 'PAST', modifiers: { ctrl: true, alt: true }, description: 'Paste Attributes' },
        { idx: 14, code: 32, label: 'SPCE', description: 'Spacebar' },
        { idx: 15, code: 176, label: 'ENT', description: 'Enter' }
      ],
      // L2: Color Grading & Nodes
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Bypass Color Grades' },
        { idx: 1, code: 115, label: 'NODE', modifiers: { alt: true }, description: 'Add Serial Node' },
        { idx: 2, code: 112, label: 'PARL', modifiers: { alt: true }, description: 'Add Parallel Node' },
        { idx: 3, code: 108, label: 'LAYR', modifiers: { alt: true }, description: 'Add Layer Node' },
        { idx: 4, code: 100, label: 'BYPS', modifiers: { shift: true }, description: 'Bypass Grade' },
        { idx: 5, code: 119, label: 'WIPE', description: 'Wipe Reference Stills' },
        { idx: 6, code: 103, label: 'GRAB', modifiers: { ctrl: true, alt: true }, description: 'Grab Still Frame' },
        { idx: 7, code: 102, label: 'FULL', modifiers: { ctrl: true }, description: 'Cinema Viewer Fullscreen' },
        { idx: 8, code: 114, label: 'RSET', customActuation: 3.20, description: 'Reset Selected Grade' },
        { idx: 9, code: 107, label: 'QUAL', description: 'Highlight Qualifier Mode' },
        { idx: 10, code: 99, label: 'CURV', description: 'Custom Curves Panel' },
        { idx: 11, code: 119, label: 'WHEE', description: 'Primary Color Wheels' },
        { idx: 12, code: 122, label: 'UNDO', modifiers: { ctrl: true }, description: 'Undo Color Stroke' },
        { idx: 13, code: 121, label: 'REDO', modifiers: { ctrl: true }, description: 'Redo Color Stroke' },
        { idx: 14, code: 32, label: 'SPCE', description: 'Play' },
        { idx: 15, code: 176, label: 'RNDR', description: 'Render Cache In to Out' }
      ]
    ]
  },
  {
    id: '3d-cad-blender',
    name: '3D CAD & Blender Studio',
    category: '3d_cad',
    description: 'Viewport perspective navigation, mesh geometry editing, extrusion, subdivision, and rendering.',
    tuning: { actuation: 1.40, rt_sens: 0.25, rt_enabled: true },
    oledTheme: MONOCHROME_WHITE_OLED_THEME,
    encoder: {
      name: 'Viewport Orbit & Timeline',
      cw: { label: 'Orbit / Step Forward', actionType: 'zoom', delta: 1, description: 'Rotate View / Step Frame' },
      ccw: { label: 'Orbit / Step Backward', actionType: 'zoom', delta: -1, description: 'Rotate View / Step Frame' },
      click: { label: 'Focus Selection (Numpad .)', actionType: 'key', code: 46, description: 'Frame Selected Object' }
    },
    layers: [
      // L0: Viewport & Mesh Ops
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Cancel Modal Op' },
        { idx: 1, code: 55, label: 'TOP', description: 'Top Orthographic View (7)' },
        { idx: 2, code: 49, label: 'FRNT', description: 'Front Orthographic View (1)' },
        { idx: 3, code: 51, label: 'SIDE', description: 'Right Orthographic View (3)' },
        { idx: 4, code: 179, label: 'TAB', description: 'Toggle Edit / Object Mode' },
        { idx: 5, code: 103, label: 'GRAB', description: 'Grab / Translate (G)' },
        { idx: 6, code: 114, label: 'ROTA', description: 'Rotate Geometry (R)' },
        { idx: 7, code: 115, label: 'SCAL', description: 'Scale Geometry (S)' },
        { idx: 8, code: 101, label: 'EXTR', description: 'Extrude Region (E)' },
        { idx: 9, code: 105, label: 'INST', description: 'Inset Faces (I)' },
        { idx: 10, code: 98, label: 'BEVL', description: 'Bevel Edges (Ctrl+B)' },
        { idx: 11, code: 114, label: 'LOOP', description: 'Loop Cut & Slide (Ctrl+R)' },
        { idx: 12, code: 122, label: 'WIRE', description: 'Toggle Wireframe / Shading' },
        { idx: 13, code: 48, label: 'CAM', description: 'Active Camera View (0)' },
        { idx: 14, code: 120, label: 'DEL', customActuation: 3.20, description: 'Delete Selected Geometry' },
        { idx: 15, code: 205, label: 'REND', description: 'F12 Render Image' }
      ],
      // L1: Sculpt & Modifiers
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Escape' },
        { idx: 1, code: 120, label: 'SYMM', description: 'Toggle X-Axis Symmetry' },
        { idx: 2, code: 100, label: 'DYNT', modifiers: { ctrl: true }, description: 'Toggle Dyntopo' },
        { idx: 3, code: 114, label: 'REMS', modifiers: { ctrl: true }, description: 'Voxel Remesh' },
        { idx: 4, code: 99, label: 'CLAY', description: 'Clay Strips Brush' },
        { idx: 5, code: 100, label: 'DRAW', description: 'Draw Brush' },
        { idx: 6, code: 115, label: 'SMTH', modifiers: { shift: true }, description: 'Smooth Surface' },
        { idx: 7, code: 103, label: 'GRAB', description: 'Grab Brush' },
        { idx: 8, code: 109, label: 'MASK', description: 'Box Mask' },
        { idx: 9, code: 105, label: 'INVT', modifiers: { ctrl: true }, description: 'Invert Mask' },
        { idx: 10, code: 97, label: 'CLRM', modifiers: { alt: true }, description: 'Clear Mask' },
        { idx: 11, code: 112, label: 'PINC', description: 'Pinch Brush' },
        { idx: 12, code: 91, label: 'BRS-', description: 'Decrease Brush Radius' },
        { idx: 13, code: 93, label: 'BRS+', description: 'Increase Brush Radius' },
        { idx: 14, code: 122, label: 'UNDO', modifiers: { ctrl: true }, description: 'Undo' },
        { idx: 15, code: 176, label: 'APPL', modifiers: { ctrl: true }, description: 'Apply Modifier' }
      ],
      // L2: Nodes & Materials
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Escape' },
        { idx: 1, code: 97, label: 'ADD', modifiers: { shift: true }, description: 'Add Shader Node' },
        { idx: 2, code: 102, label: 'FIND', description: 'Search Nodes' },
        { idx: 3, code: 109, label: 'MTRL', description: 'Assign Material' },
        { idx: 4, code: 104, label: 'HIDE', description: 'Hide Unused Node Sockets' },
        { idx: 5, code: 106, label: 'JOIN', modifiers: { ctrl: true }, description: 'Join Node Frame' },
        { idx: 6, code: 103, label: 'GRP', modifiers: { ctrl: true }, description: 'Group Selected Nodes' },
        { idx: 7, code: 116, label: 'MAP', modifiers: { ctrl: true }, description: 'Add Texture Coordinate' },
        { idx: 8, code: 99, label: 'COLR', description: 'ColorRamp Node' },
        { idx: 9, code: 98, label: 'BSDF', description: 'Principled BSDF' },
        { idx: 10, code: 110, label: 'NORM', description: 'Normal Map Node' },
        { idx: 11, code: 105, label: 'IMG', description: 'Image Texture Node' },
        { idx: 12, code: 120, label: 'CUT', modifiers: { ctrl: true }, description: 'Mute / Cut Node Links' },
        { idx: 13, code: 100, label: 'DUPL', modifiers: { shift: true }, description: 'Duplicate Node' },
        { idx: 14, code: 122, label: 'UNDO', modifiers: { ctrl: true }, description: 'Undo' },
        { idx: 15, code: 176, label: 'ENT', description: 'Confirm' }
      ]
    ]
  },
  {
    id: 'finance-sheets',
    name: 'Spreadsheets & Finance',
    category: 'finance',
    description: 'High-speed number crunching, formula insertion (=SUM, =VLOOKUP), format conversion, and row manipulation.',
    tuning: { actuation: 1.80, rt_sens: 0.35, rt_enabled: false },
    oledTheme: MONOCHROME_WHITE_OLED_THEME,
    encoder: {
      name: 'Grid Navigation / Sheet Zoom',
      cw: { label: 'Next Column / Zoom In', actionType: 'scroll', code: 215, delta: 1, description: 'Move Right' },
      ccw: { label: 'Prev Column / Zoom Out', actionType: 'scroll', code: 216, delta: -1, description: 'Move Left' },
      click: { label: 'Enter / Confirm Cell', actionType: 'key', code: 176, description: 'Confirm' }
    },
    layers: [
      // L0: Financial Numpad & Quick Formulas
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Cancel Formula Input' },
        { idx: 1, code: 55, label: '7', description: '7' },
        { idx: 2, code: 56, label: '8', description: '8' },
        { idx: 3, code: 57, label: '9', description: '9' },
        { idx: 4, code: 61, label: 'SUM', modifiers: { alt: true }, description: 'AutoSum (=SUM())' },
        { idx: 5, code: 52, label: '4', description: '4' },
        { idx: 6, code: 53, label: '5', description: '5' },
        { idx: 7, code: 54, label: '6', description: '6' },
        { idx: 8, code: 118, label: 'PSTV', modifiers: { ctrl: true, shift: true }, description: 'Paste Values Only' },
        { idx: 9, code: 49, label: '1', description: '1' },
        { idx: 10, code: 50, label: '2', description: '2' },
        { idx: 11, code: 51, label: '3', description: '3' },
        { idx: 12, code: 36, label: 'FMT$', modifiers: { ctrl: true, shift: true }, description: 'Format Currency ($)' },
        { idx: 13, code: 37, label: 'FMT%', modifiers: { ctrl: true, shift: true }, description: 'Format Percent (%)' },
        { idx: 14, code: 48, label: '0', description: '0' },
        { idx: 15, code: 176, label: 'ENT', description: 'Commit & Next Row' }
      ],
      // L1: Data Analysis & Layout
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Escape' },
        { idx: 1, code: 108, label: 'FLTR', modifiers: { ctrl: true, shift: true }, description: 'Toggle AutoFilter' },
        { idx: 2, code: 116, label: 'TABL', modifiers: { ctrl: true }, description: 'Create Excel Table' },
        { idx: 3, code: 112, label: 'PIVT', modifiers: { alt: true }, description: 'Insert Pivot Table' },
        { idx: 4, code: 104, label: 'INSR', modifiers: { ctrl: true, shift: true }, description: 'Insert Row Above' },
        { idx: 5, code: 45, label: 'DELR', modifiers: { ctrl: true }, customActuation: 3.40, description: 'Delete Row (Safe Depth)' },
        { idx: 6, code: 111, label: 'FIT', modifiers: { alt: true }, description: 'Auto-Fit Column Width' },
        { idx: 7, code: 102, label: 'FRZE', modifiers: { alt: true }, description: 'Freeze Top Row / Panes' },
        { idx: 8, code: 113, label: 'VLU', description: 'VLOOKUP / XLOOKUP' },
        { idx: 9, code: 105, label: 'IFER', description: 'IFERROR Wrapper' },
        { idx: 10, code: 99, label: 'COUN', description: 'COUNTIFS Formula' },
        { idx: 11, code: 117, label: 'UPPR', description: 'UPPER / TRIM Formula' },
        { idx: 12, code: 115, label: 'SAVE', modifiers: { ctrl: true }, description: 'Save Spreadsheet' },
        { idx: 13, code: 122, label: 'UNDO', modifiers: { ctrl: true }, description: 'Undo' },
        { idx: 14, code: 121, label: 'REDO', modifiers: { ctrl: true }, description: 'Redo' },
        { idx: 15, code: 176, label: 'ENT', description: 'Enter' }
      ],
      // L2: Sheets & Auditing
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Escape' },
        { idx: 1, code: 91, label: 'PREC', modifiers: { ctrl: true }, description: 'Trace Precedents' },
        { idx: 2, code: 93, label: 'DEPN', modifiers: { ctrl: true }, description: 'Trace Dependents' },
        { idx: 3, code: 178, label: 'RMOV', modifiers: { alt: true }, description: 'Remove Precedent Arrows' },
        { idx: 4, code: 112, label: 'PRNT', modifiers: { ctrl: true }, description: 'Print / Export PDF' },
        { idx: 5, code: 211, label: 'SHT<', modifiers: { ctrl: true }, description: 'Previous Worksheet' },
        { idx: 6, code: 214, label: 'SHT>', modifiers: { ctrl: true }, description: 'Next Worksheet' },
        { idx: 7, code: 110, label: 'NEWS', modifiers: { shift: true, alt: true }, description: 'New Worksheet' },
        { idx: 8, code: 103, label: 'GOAL', modifiers: { alt: true }, description: 'Goal Seek Utility' },
        { idx: 9, code: 99, label: 'CALC', description: 'F9 Recalculate Workbook' },
        { idx: 10, code: 102, label: 'FIND', modifiers: { ctrl: true }, description: 'Find & Replace' },
        { idx: 11, code: 107, label: 'LINK', modifiers: { ctrl: true }, description: 'Insert Hyperlink' },
        { idx: 12, code: 99, label: 'COPY', modifiers: { ctrl: true }, description: 'Copy' },
        { idx: 13, code: 118, label: 'PAST', modifiers: { ctrl: true }, description: 'Paste' },
        { idx: 14, code: 32, label: 'SPCE', description: 'Space' },
        { idx: 15, code: 176, label: 'ENT', description: 'Enter' }
      ]
    ]
  },
  {
    id: 'design-multitask',
    name: 'Design & OS Multitasking',
    category: 'design',
    description: 'Figma frame manipulation, CSS export, window snapping, virtual desktop shifts, and screenshot tools.',
    tuning: { actuation: 1.10, rt_sens: 0.20, rt_enabled: true },
    oledTheme: MONOCHROME_WHITE_OLED_THEME,
    encoder: {
      name: 'Canvas Zoom & Pan',
      cw: { label: 'Zoom In 10%', actionType: 'zoom', delta: 1, description: 'Zoom In' },
      ccw: { label: 'Zoom Out 10%', actionType: 'zoom', delta: -1, description: 'Zoom Out' },
      click: { label: 'Zoom to 100% / Fit', actionType: 'key', code: 48, modifiers: { shift: true }, description: 'Zoom to Fit' }
    },
    layers: [
      // L0: Figma & Vector Tools
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Selection Tool (V)' },
        { idx: 1, code: 102, label: 'FRAM', description: 'Frame Tool (F)' },
        { idx: 2, code: 114, label: 'RECT', description: 'Rectangle Tool (R)' },
        { idx: 3, code: 116, label: 'TEXT', description: 'Text Tool (T)' },
        { idx: 4, code: 97, label: 'AUTL', modifiers: { shift: true }, description: 'Auto-Layout (Shift+A)' },
        { idx: 5, code: 107, label: 'COMP', modifiers: { ctrl: true, alt: true }, description: 'Create Component' },
        { idx: 6, code: 98, label: 'INST', modifiers: { ctrl: true, alt: true }, description: 'Detach Instance' },
        { idx: 7, code: 101, label: 'EXPT', modifiers: { ctrl: true, shift: true }, description: 'Export Assets' },
        { idx: 8, code: 99, label: 'CPYC', modifiers: { ctrl: true, alt: true }, description: 'Copy Properties / CSS' },
        { idx: 9, code: 118, label: 'PSTC', modifiers: { ctrl: true, alt: true }, description: 'Paste Properties' },
        { idx: 10, code: 104, label: 'HIDE', modifiers: { ctrl: true, shift: true }, description: 'Toggle Hide / Show' },
        { idx: 11, code: 108, label: 'LOCK', modifiers: { ctrl: true, shift: true }, description: 'Toggle Lock Layer' },
        { idx: 12, code: 103, label: 'GRP', modifiers: { ctrl: true }, description: 'Group Selection' },
        { idx: 13, code: 103, label: 'UNGP', modifiers: { ctrl: true, shift: true }, description: 'Ungroup Selection' },
        { idx: 14, code: 122, label: 'UNDO', modifiers: { ctrl: true }, description: 'Undo' },
        { idx: 15, code: 176, label: 'ENT', description: 'Select Child / Enter' }
      ],
      // L1: OS Window Management
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Escape' },
        { idx: 1, code: 115, label: 'SNIP', modifiers: { shift: true, meta: true }, description: 'Snip Screenshot' },
        { idx: 2, code: 218, label: 'W-MX', modifiers: { meta: true }, description: 'Maximize Window' },
        { idx: 3, code: 100, label: 'TASK', modifiers: { meta: true }, description: 'Show Desktop' },
        { idx: 4, code: 216, label: 'W-LT', modifiers: { meta: true }, description: 'Snap Window Left' },
        { idx: 5, code: 217, label: 'W-MN', modifiers: { meta: true }, description: 'Minimize Window' },
        { idx: 6, code: 215, label: 'W-RT', modifiers: { meta: true }, description: 'Snap Window Right' },
        { idx: 7, code: 179, label: 'TABW', modifiers: { alt: true }, description: 'Alt-Tab App Switcher' },
        { idx: 8, code: 216, label: 'DSK<', modifiers: { ctrl: true, meta: true }, description: 'Virtual Desktop Left' },
        { idx: 9, code: 101, label: 'EXPL', modifiers: { meta: true }, description: 'Open File Explorer' },
        { idx: 10, code: 215, label: 'DSK>', modifiers: { ctrl: true, meta: true }, description: 'Virtual Desktop Right' },
        { idx: 11, code: 108, label: 'LOCK', modifiers: { meta: true }, customActuation: 3.50, description: 'Lock Workstation' },
        { idx: 12, code: 99, label: 'COPY', modifiers: { ctrl: true }, description: 'Copy' },
        { idx: 13, code: 118, label: 'PAST', modifiers: { ctrl: true }, description: 'Paste' },
        { idx: 14, code: 32, label: 'SPCE', description: 'Space' },
        { idx: 15, code: 176, label: 'ENT', description: 'Enter' }
      ],
      // L2: Productivity Macros & App Launchers
      [
        { idx: 0, code: 177, label: 'ESC', description: 'Escape' },
        { idx: 1, code: 116, label: 'TERM', description: 'Terminal / CLI' },
        { idx: 2, code: 98, label: 'BROW', description: 'Web Browser' },
        { idx: 3, code: 110, label: 'NOTS', description: 'Notes App' },
        { idx: 4, code: 109, label: 'MUTE', description: 'Mute Mic' },
        { idx: 5, code: 118, label: 'CAMX', description: 'Mute Camera' },
        { idx: 6, code: 100, label: 'DND', description: 'Do Not Disturb' },
        { idx: 7, code: 115, label: 'SLAK', description: 'Focus Team Chat' },
        { idx: 8, code: 112, label: 'PASM', description: 'Password Vault' },
        { idx: 9, code: 99, label: 'CALC', description: 'Calculator' },
        { idx: 10, code: 107, label: 'CLIP', modifiers: { meta: true }, description: 'Clipboard History' },
        { idx: 11, code: 101, label: 'EMOJ', modifiers: { meta: true }, description: 'Emoji Picker' },
        { idx: 12, code: 122, label: 'UNDO', modifiers: { ctrl: true }, description: 'Undo' },
        { idx: 13, code: 121, label: 'REDO', modifiers: { ctrl: true }, description: 'Redo' },
        { idx: 14, code: 32, label: 'SPCE', description: 'Space' },
        { idx: 15, code: 176, label: 'ENT', description: 'Enter' }
      ]
    ]
  }
];

export const INITIAL_DEVICE_CONFIG: DeviceConfig = {
  actuation: 1.50,
  rt_sens: 0.25,
  rt_enabled: true,
  active_layer: 0,
  activeProfileId: 'number-pad',
  layers: JSON.parse(JSON.stringify(PRODUCTIVITY_PROFILES[0].layers)),
  encoder: JSON.parse(JSON.stringify(PRODUCTIVITY_PROFILES[0].encoder))
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

  // Letters
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

  // Symbols
  { label: ';', code: 59, category: 'Symbols' },
  { label: '=', code: 61, category: 'Symbols' },
  { label: ',', code: 44, category: 'Symbols' },
  { label: '-', code: 45, category: 'Symbols' },
  { label: '.', code: 46, category: 'Symbols' },
  { label: '/', code: 47, category: 'Symbols' },
  { label: '`', code: 96, category: 'Symbols' },
  { label: '[', code: 91, category: 'Symbols' },
  { label: ']', code: 93, category: 'Symbols' },
  { label: '\\', code: 92, category: 'Symbols' },

  // Function / Macro Keys
  { label: 'F1', code: 194, category: 'Function/Macro' },
  { label: 'F2', code: 195, category: 'Function/Macro' },
  { label: 'F3', code: 196, category: 'Function/Macro' },
  { label: 'F4', code: 197, category: 'Function/Macro' },
  { label: 'F5', code: 198, category: 'Function/Macro' },
  { label: 'F6', code: 199, category: 'Function/Macro' },
  { label: 'F7', code: 200, category: 'Function/Macro' },
  { label: 'F8', code: 201, category: 'Function/Macro' },
  { label: 'F9', code: 202, category: 'Function/Macro' },
  { label: 'F10', code: 203, category: 'Function/Macro' },
  { label: 'F11', code: 204, category: 'Function/Macro' },
  { label: 'F12', code: 205, category: 'Function/Macro' }
];

export const PRODUCTIVITY_SHORTCUT_PRESETS = [
  { label: 'Copy (Ctrl+C)', code: 99, modifiers: { ctrl: true }, disp: 'COPY' },
  { label: 'Paste (Ctrl+V)', code: 118, modifiers: { ctrl: true }, disp: 'PAST' },
  { label: 'Cut (Ctrl+X)', code: 120, modifiers: { ctrl: true }, disp: 'CUT' },
  { label: 'Undo (Ctrl+Z)', code: 122, modifiers: { ctrl: true }, disp: 'UNDO' },
  { label: 'Redo (Ctrl+Y)', code: 121, modifiers: { ctrl: true }, disp: 'REDO' },
  { label: 'Save (Ctrl+S)', code: 115, modifiers: { ctrl: true }, disp: 'SAVE' },
  { label: 'Find (Ctrl+F)', code: 102, modifiers: { ctrl: true }, disp: 'FIND' },
  { label: 'Select All (Ctrl+A)', code: 97, modifiers: { ctrl: true }, disp: 'ALL' },
  { label: 'New Tab (Ctrl+T)', code: 116, modifiers: { ctrl: true }, disp: 'NEWT' },
  { label: 'Close Tab (Ctrl+W)', code: 119, modifiers: { ctrl: true }, disp: 'CLSW' },
  { label: 'Snip (Win+Shift+S)', code: 115, modifiers: { meta: true, shift: true }, disp: 'SNIP' },
  { label: 'Format (Alt+Shift+F)', code: 102, modifiers: { alt: true, shift: true }, disp: 'FMT' },
  { label: 'Command Pal (Ctrl+Shift+P)', code: 112, modifiers: { ctrl: true, shift: true }, disp: 'PAL' }
];

export type OledWidgetMode =
  | 'cockpit'
  | 'speedometer'
  | 'heatmap'
  | 'timer'
  | 'custom'
  | 'screensaver'
  | 'test';

export interface OledCustomBitmap {
  name: string;
  width: number;
  height: number;
  data: number[]; // binary 0/1 array (length = width * height)
}

export interface KeyCalibrationData {
  idx: number;
  restAdc: number; // Raw 12-bit ADC resting value (e.g. 1950)
  bottomAdc: number; // Raw 12-bit ADC bottom-out value (e.g. 3400)
  noiseFloor: number; // Noise amplitude in ADC counts (e.g. 6-12)
  isCalibrated: boolean;
}

export interface PinoutConfig {
  name: string;
  adcPin: number; // 26, 27, 28 (GP26 = ADC0, GP27 = ADC1, GP28 = ADC2)
  muxS0: number; // Default: 14
  muxS1: number; // Default: 15
  muxS2: number; // Default: 16
  muxS3: number; // Default: 17
  oledSda: number; // Default: 0
  oledScl: number; // Default: 1
  i2cPort: 0 | 1; // Default: 0
  encoderA: number; // Default: 20
  encoderB: number; // Default: 21
  encoderSw: number; // Default: 2
}

export const DEFAULT_PINOUT_CONFIG: PinoutConfig = {
  name: 'Standard Raspberry Pi Pico (RP2040)',
  adcPin: 26,
  muxS0: 14,
  muxS1: 15,
  muxS2: 16,
  muxS3: 17,
  oledSda: 0,
  oledScl: 1,
  i2cPort: 0,
  encoderA: 20,
  encoderB: 21,
  encoderSw: 2,
};
