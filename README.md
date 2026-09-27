<h1 align="center">DriftPad</h1>

<p align="center">
  A 16-key Hall-effect macropad with analog key sensing, Rapid Trigger, an OLED cockpit display and a rotary encoder, built on the RP2040.
</p>

<p align="center">
  <img alt="Status: in development" src="https://img.shields.io/badge/status-in%20development-orange">
  <img alt="MCU: RP2040" src="https://img.shields.io/badge/MCU-RP2040-c51a4a">
  <img alt="Built with PlatformIO" src="https://img.shields.io/badge/built%20with-PlatformIO-f5822a">
  <img alt="License: GPL-3.0" src="https://img.shields.io/badge/license-GPL--3.0-blue">
</p>

<p align="center">
  <img src="docs/images/driftpad_oled_showcase.png" alt="DriftPad OLED: standby screen (left) and a key being actuated (right)" width="760">
</p>

DriftPad is a custom Hall-effect macropad built around analog magnetic key sensing. Instead of a simple on/off switch, every key reports how far it has travelled, which lets the firmware support adjustable actuation and release points, Rapid Trigger, live travel feedback on the OLED, and per-layer keymaps you can change from the browser.

> **Status:** In development. Firmware V2 (Hall-effect engine, Rapid Trigger, OLED UI, WebSerial configurator) is implemented and verified in simulation. PCB and enclosure files are not yet in this repository.

## Contents

- [Features](#features)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start)
- [Hardware](#hardware)
- [How it works](#how-it-works)
- [Documentation](#documentation)
- [Roadmap](#roadmap)
- [License](#license)

## Features

- **Analog Hall-effect sensing** on all 16 keys through a CD74HC4067 analog multiplexer into the RP2040 ADC
- **Adjustable actuation point** from 0.10 to 3.80 mm
- **Rapid Trigger** with adjustable sensitivity from 0.10 to 2.00 mm, so a key re-actuates or releases as soon as it changes direction
- **Noise and drift handling:** velocity-adaptive filtering, automatic rest baseline tracking and magnet polarity auto-detection
- **Three keymap layers** out of the box: Numpad, Navigation and Gaming (WASD)
- **128×64 OLED cockpit UI** showing live key travel, the active layer and Rapid Trigger settings
- **Rotary encoder** for on-device menus: adjust actuation, adjust RT sensitivity, toggle RT and cycle layers
- **Browser configurator** over WebSerial with no install and no external dependencies
- **Settings stored in flash**, so calibration and keymaps survive a power cycle

## Repository layout

| Path | What's in it |
|---|---|
| [`firmware/`](firmware) | PlatformIO project for the RP2040 (Arduino core by Earle Philhower) |
| [`firmware/src/`](firmware/src) | `hall.cpp` sensing and Rapid Trigger, `oled.cpp` display UI, `config.cpp` flash settings and keymaps, `encoder.cpp`, `mux.cpp`, `main.cpp` serial command handler |
| [`firmware/include/pins.h`](firmware/include/pins.h) | Pin assignments and key to multiplexer channel map |
| [`configurator/`](configurator) | Single-file WebSerial configurator (`index.html`) |
| [`tests/`](tests) | Python test harness: DSP model, build checks and configurator protocol |
| [`tools/`](tools) | OLED renderers, design concept generator and a live demo script |
| [`docs/`](docs) | Documentation, OLED design concepts and rendered screenshots |
| [`hardware/`](hardware) | KiCad PCB project and mechanical STL / STEP files (placeholders for now) |

## Quick start

### 1. Build and flash the firmware

Install [PlatformIO](https://platformio.org/) (the VS Code extension or the CLI), then:

```bash
cd firmware
pio run                  # build
pio run -t upload        # flash over USB
```

The build output lands in `firmware/.pio/build/pico/`. You can also hold **BOOTSEL** while plugging in the Pico and copy `firmware.uf2` onto the drive that appears.

### 2. Configure it

Open [`configurator/index.html`](configurator/index.html) in Chrome, Edge or Opera (WebSerial is required), click **Connect DriftPad** and pick the board's serial port. From there you can remap keys, change actuation and Rapid Trigger settings, switch layers and save to flash.

Any serial terminal at 115200 baud works too. See the [serial command reference](docs/serial-protocol.md).

### 3. Run the tests

The harness only needs Python 3 and its standard library:

```bash
python tests/run_all_tests.py
```

The build tests (`TC-13`, `TC-B1` to `TC-B3`) also need PlatformIO on your `PATH`. See [docs/testing.md](docs/testing.md) for what each test covers.

## Hardware

| Part | Details |
|---|---|
| Microcontroller | Raspberry Pi Pico (RP2040) |
| Key sensors | 16 analog Hall-effect sensors in a 4×4 grid |
| Multiplexer | CD74HC4067, select lines on GP14 to GP17, output to GP26 / ADC0 |
| Display | SSD1306 128×64 OLED on I2C0 (SDA GP0, SCL GP1, address `0x3C`) |
| Encoder | Quadrature on GP20 / GP21, push switch on GP4 |

Full pinout and key to channel mapping: [docs/hardware.md](docs/hardware.md).

## How it works

Unlike a traditional mechanical keyboard switch that provides a simple digital on/off signal, DriftPad uses Hall-effect sensors to measure the position of each key magnetically. The firmware turns each 12-bit ADC reading into a travel distance in millimetres and then decides when the key is pressed:

1. **Filter.** A velocity-adaptive low-pass filter smooths heavily while the key is still (rejecting mains hum and sensor noise) and almost not at all while it is moving, so fast strokes are not delayed.
2. **Track the baseline.** While a key is at rest, its zero point slowly follows temperature and supply drift so it never triggers on its own.
3. **Actuate.** A key first fires when it passes the actuation point.
4. **Rapid Trigger.** After that, the firmware tracks the deepest and shallowest points of the stroke. Lifting by the RT sensitivity releases the key; pressing down by the same amount re-actuates it, without needing to return to the top.

The maths and the test results behind each step are in [docs/testing.md](docs/testing.md).

## Documentation

| Document | Contents |
|---|---|
| [docs/hardware.md](docs/hardware.md) | Pinout, multiplexer channel map, default keymaps |
| [docs/serial-protocol.md](docs/serial-protocol.md) | Every serial command the firmware accepts, with arguments and responses |
| [docs/testing.md](docs/testing.md) | Test harness, test case list, filter and Rapid Trigger derivations |
| [docs/oled_concepts/](docs/oled_concepts) | Alternative OLED layouts and key-press animations, with GIFs |
| [docs/images/](docs/images) | Pixel-accurate OLED screenshots rendered from the firmware drawing code |
| [tools/README.md](tools/README.md) | What each helper script does and how to run it |

## Roadmap

- [x] Project concept and feature planning
- [x] KiCad schematic and PCB design
- [x] Mechanical / STL design
- [x] PlatformIO firmware project setup
- [x] Hall-effect sensor firmware and calibration
- [x] Keyboard / HID output
- [x] Adjustable actuation and Rapid Trigger logic
- [x] OLED interface
- [x] Rotary encoder integration
- [x] WebSerial configurator
- [ ] Publish KiCad and enclosure files to `hardware/`
- [ ] Hardware bring-up and testing
- [ ] Final enclosure and assembly
- [ ] Performance measurements on real hardware

## License

DriftPad is released under the [GNU General Public License v3.0](LICENSE).
