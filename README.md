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

### Software-only virtual setup

Requirements: Node.js 18 or newer and a Chromium-based browser (Chrome, Edge, or Opera).

```bash
npm install
npm run dev
```

Runs on `http://localhost:3000`.

Open that URL and leave the connection mode in **Digital Twin** to test profiles, layers,
Rapid Trigger behavior, the OLED preview, and the serial console without hardware.

Useful project commands:

```bash
npm run lint    # TypeScript validation
npm run build   # TypeScript validation plus production Vite build
npm run preview # Preview the production build
```

### Hardware setup

The firmware is a PlatformIO Arduino project for a Raspberry Pi Pico/RP2040. Install
PlatformIO in VS Code or install the PlatformIO CLI, then build and upload from the
`firmware` directory:

```bash
cd firmware
pio run
pio run --target upload
```

Hold **BOOTSEL** while connecting the Pico if it is not detected. A specific port can
be supplied with `--upload-port COM5`.

The documented DriftPad V2 wiring is:

| Function | RP2040 pin |
|---|---:|
| OLED SDA / SCL | GP0 / GP1 |
| Encoder push switch | GP4 |
| Multiplexer S0-S3 | GP14-GP17 |
| Encoder A / B | GP20 / GP21 |
| Multiplexer common / ADC | GP26 / ADC0 |

The OLED uses I2C address `0x3C`. Hall sensors connect through the CD74HC4067, using
the non-sequential channel map in [`docs/hardware.md`](docs/hardware.md). Check power,
ground, sensor orientation, and the multiplexer wiring before applying USB power.

SSD1306 is enabled by default. For an SH1106 display, set
`-DUSE_SH1106=1` in `firmware/platformio.ini` and upload again.

> **Hardware availability:** `hardware/kicad/` and `hardware/mechanical/` currently
> contain placeholders rather than a complete published PCB/enclosure. You may need
> a fabricated board or custom wiring and mounting solution.

### First connection and safe commissioning

1. Start the web app with `npm run dev`.
2. Connect the Pico and choose **Hardware** in the configurator.
3. Select the serial port in the browser permission dialog.
4. Keep HID output disabled while testing. The app disables HID on a new hardware
   connection so simulated or miscalibrated presses cannot type into the host.
5. Run `CALIBRATE` with every key fully released.
6. Run `PING`, `STATUS`, and `OLED_SCAN` from the serial console.
7. Set actuation and Rapid Trigger sensitivity, then use `SAVE`.
8. Enable HID only after the key matrix and OLED behave correctly.

The serial port runs at 115200 baud. Examples:

```text
PING
CALIBRATE
SET_ACTUATION 1.50
SET_RT_SENS 0.25
SET_RT_ENABLE 1
SET_LAYER 0
SAVE
```

Use `SET_LAYER 0`, `SET_LAYER 1`, or `SET_LAYER 2` to choose which layer is being
edited. The configurator's layer selector updates the active layer, and remapping a
key sends the selected layer to the device. Profile backups are JSON files exported
from the profile bar; imports are schema-validated before replacing any local data.

### Troubleshooting

- **No serial port:** use a data-capable USB cable and Chrome, Edge, or Opera.
- **Upload failure:** hold BOOTSEL while plugging in the Pico, then retry PlatformIO.
- **Wrong key travel:** release every key and run `CALIBRATE`; then adjust actuation.
- **Blank OLED:** check GP0/GP1, power, ground, address `0x3C`, and run `OLED_SCAN`.
- **Unexpected typing:** disable HID with `SET_HID 0` before further testing.
- **Settings not retained:** use `SAVE` for device flash and export profile JSON for
  browser-side profile backups.

See [`docs/hardware.md`](docs/hardware.md), [`docs/serial-protocol.md`](docs/serial-protocol.md),
and [`docs/testing.md`](docs/testing.md) for the authoritative pinout, command reference,
and validation procedures.
