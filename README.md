# DriftPad Productivity Workstation & Macropad Suite

A high-performance React application and WebSerial configurator for **DriftPad**, the 16-key Hall-effect macropad built around analog magnetic key sensing, Rapid Trigger DSP, a rotary encoder, and an SSD1306 OLED cockpit display on the Raspberry Pi Pico (RP2040).

## Features

- **Productivity Workspace Profiles**:
  - **Code & Terminal Studio**: Git Pull/Push/Commit, terminal toggle, code formatting, build tasks, test runner, line comments, and safe 3.5mm process kill.
  - **Video Timeline & NLE**: Razor cut, ripple delete, play/pause, frame jog left/right, marker drop, timeline zoom, and export media.
  - **3D CAD & Blender**: Orthographic viewport snaps (Top, Front, Side), camera view, extrude, bevel, loop cut, inset, and wireframe toggle.
  - **Spreadsheets & Finance**: AutoSum (`=SUM()`), paste values, currency format `$`, percent `%`, insert/delete row, filter, and table formatting.
  - **Design & OS Multitasking**: Figma frame tools, auto-layout, CSS property export, screen snip, virtual desktop navigation, and app launchers.
- **Heatmap Overlay & Layout Optimizer**:
  - Live color-graded heat distribution (Cool -> Moderate -> High -> Peak Flame) based on real activation frequency per profile.
  - Frequency counters (`hits` & `% density`) on keycaps.
  - Automatic layout advice highlighting top high-traffic shortcuts and underutilized keys to optimize thumb reach and ergonomics.
  - One-click frequency reset per profile.
- **Global Multi-Layer View (All Layers Simultaneous)**:
  - View mappings across all 3 layers at once on each keycap with color-coded tags (Cyan L0, Purple L1, Pink L2).
  - Direct row click to remap shortcuts on any layer without tab switching.
- **Hardware Rotary Encoder (GP20/GP21/GP4)**:
  - Interactive on-screen knurled dial with horizontal drag and mouse wheel spinning.
  - Configurable clockwise (CW), counter-clockwise (CCW), and center push-click actions per layer or profile.
  - Presets for Timeline Jogging, Master Volume/Mute, Canvas Zoom/Fit, Document Scroll, and Tab Switching.
- **Easiest & Most Reliable Storage**:
  - Single-click **Export Backup (.json)** file download.
  - **Import Backup (.json)** file restore with schema verification.
  - Direct synchronization to RP2040 Flash memory (`SAVE`).
- **Safety Depth & Per-Key Actuation Override**:
  - Configure individual keys to require deeper actuation (e.g. 3.50mm for destructive keys like Delete, Kill Server, or Format) to prevent accidental triggers while keeping navigation hair-trigger light.
- **Enhanced Key Remapping**:
  - Support for multi-key modifier combos (Ctrl `^`, Alt `⌥`, Shift `⇧`, Meta/Win/Cmd `⌘`).
  - Pre-packaged productivity shortcuts and custom key labels.
- **SSD1306 128×64 OLED Cockpit**:
  - Productivity HUD showing active profile name, current rotary dial assignment, and analog travel gauges.
  - 6 screensaver modes: 3D Warp Starfield, Cyber Rain, Analog Oscilloscope, Synthwave 3D Grid, Magnetic Ripples, and Conway's Game of Life.
- **Dual Mode (Hardware USB + Digital Twin DSP)**:
  - Connect directly to physical RP2040 boards via WebSerial at 115200 baud, or test in browser using the complete Hall-effect Rapid Trigger DSP emulator.

## Getting Started

```bash
npm install
npm run dev
```

Runs on `http://localhost:3000`.
