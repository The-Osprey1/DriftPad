# DriftPad Configurator & Simulator

A high-performance React application and WebSerial configurator for **DriftPad**, the 16-key Hall-effect macropad built around analog magnetic key sensing, Rapid Trigger DSP, and an SSD1306 OLED cockpit display on the Raspberry Pi Pico (RP2040).

## Features

- **Interactive 16-Key Matrix Map**: 4x4 analog key matrix across 3 layers (L0: Numpad, L1: Navigation, L2: WASD Gaming) with real-time travel meters and key remap modal.
- **Dynamic Rapid Trigger Engine**: Continuous dynamic reset and re-actuation without fixed thresholds, customizable from 0.10 mm to 2.00 mm.
- **Adjustable Actuation Point**: Real-time slider from 0.10 mm to 3.80 mm with hair-trigger and deep-stroke presets.
- **Switch Stem Simulator**: Physical cross-section sandbox with animated stem travel, actuation marker line, bottom-out indicators, and automated tap/flutter stress-test patterns.
- **SSD1306 128×64 OLED Cockpit Visualizer**:
  - Pixel-accurate HUD displaying active layer, Rapid Trigger status, actuation depth, and active key travel gauges.
  - Interactive screensaver animations: 3D Warp Starfield, Cyber Rain, Analog Oscilloscope, Synthwave 3D Grid, Magnetic Ripples, and Conway's Game of Life.
  - Full display controls: Sleep, Wake, I2C Bus Scan, and test grid.
- **Full WebSerial Protocol Suite**: Connects directly to RP2040 microcontrollers over USB Serial at 115200 baud, sending and receiving commands (`PING`, `GET_CONFIG`, `STATUS`, `SET_ACTUATION`, `SET_RT_SENS`, `SET_RT_ENABLE`, `SET_LAYER`, `SET_KEY`, `SET_HID`, `SAVE`, `CALIBRATE`, `BOOTSEL`, `RESET`).
- **Digital Twin DSP Mode**: Seamless in-browser firmware emulator running the full Hall-effect velocity-adaptive filter and Rapid Trigger state machine when no hardware is connected.

## Getting Started

### Development

```bash
npm install
npm run dev
```

The application runs on `http://localhost:3000`.

### Production Build

```bash
npm run build
```
