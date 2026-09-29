# Hardware

DriftPad V2 is built around a Raspberry Pi Pico (RP2040). The pin assignments below come from [`firmware/include/pins.h`](../firmware/include/pins.h), which was mapped from the `Driftpad-fix2` KiCad PCB layout. If the two ever disagree, `pins.h` is what the firmware actually uses.

## Pinout

| Function | RP2040 pin | Notes |
|---|---|---|
| OLED SDA | GP0 | I2C0, SSD1306 128×64 at address `0x3C` |
| OLED SCL | GP1 | I2C0 |
| Encoder switch | GP4 | Fallback / rework pin, active low with internal pull-up |
| Mux S0 | GP14 | CD74HC4067 channel select |
| Mux S1 | GP15 | |
| Mux S2 | GP16 | |
| Mux S3 | GP17 | |
| Encoder A | GP20 | Internal pull-up |
| Encoder B | GP21 | Internal pull-up |
| Mux common | GP26 / ADC0 | 12-bit analog input shared by all 16 sensors |

The SH1106 display driver is also supported: set `-DUSE_SH1106=1` in `build_flags` in [`firmware/platformio.ini`](../firmware/platformio.ini).

## Key to multiplexer channel map

Keys are numbered row-major, 0 at the top left and 15 at the bottom right. The PCB traces route each Hall sensor to a mux channel that does not follow key order, so the firmware uses this lookup table:

| Key | Default legend | Sensor | Mux channel |
|---:|---|---|---:|
| 0 | Esc | U14 | 10 |
| 1 | 7 | U9 | 9 |
| 2 | 8 | U13 | 6 |
| 3 | 9 | U4 | 4 |
| 4 | Macro 1 | U18 | 11 |
| 5 | 4 | U5 | 8 |
| 6 | 5 | U17 | 7 |
| 7 | 6 | U8 | 5 |
| 8 | Macro 2 | U6 | 12 |
| 9 | 1 | U15 | 14 |
| 10 | 2 | U3 | 0 |
| 11 | 3 | U12 | 2 |
| 12 | Macro 3 | U10 | 13 |
| 13 | Macro 4 | U19 | 15 |
| 14 | 0 | U7 | 1 |
| 15 | Enter | U16 | 3 |

## Default keymaps

Defined in [`firmware/src/config.cpp`](../firmware/src/config.cpp) and restored by the `RESET` serial command. All three layers can be remapped from the configurator.

**Layer 0: Numpad**

| | | | |
|---|---|---|---|
| Esc | 7 | 8 | 9 |
| M1 (F13) | 4 | 5 | 6 |
| M2 (F14) | 1 | 2 | 3 |
| M3 (F15) | M4 (F16) | 0 | Enter |

**Layer 1: Navigation and editing**

| | | | |
|---|---|---|---|
| Esc | Home | Up | Page Up |
| Tab | Left | Down | Right |
| Insert | End | Down | Page Down |
| Backspace | Delete | Space | Enter |

**Layer 2: Gaming**

| | | | |
|---|---|---|---|
| Esc | 1 | 2 | 3 |
| Tab | Q | W | E |
| Shift | A | S | D |
| Ctrl | R | Space | F |

## Design files

KiCad sources belong in [`hardware/kicad/`](../hardware/kicad) and enclosure models in [`hardware/mechanical/stl/`](../hardware/mechanical/stl) and [`hardware/mechanical/step/`](../hardware/mechanical/step). These folders are placeholders until the files are published.

## Hardware readiness

| Item | State |
|---|---|
| Pin map, mux channel map, default keymaps | Taken from `pins.h` and `config.cpp`; checked against the code by the tests, **not** against a built board |
| Firmware | Builds and passes every host test; has **never run on a physical pad** |
| KiCad project, gerbers, BOM, enclosure STL/STEP, assembly guide, photographs | **Not in this repository.** `hardware/` holds placeholders |
| Sensor part number and magnet polarity | Not recorded here (the firmware auto-detects polarity); needed for anyone building a pad |
| Real-world figures (rest noise, actuation depth, latency, scan gaps, save pause, power-cut behaviour) | None measured; procedure in [hardware-acceptance.md](hardware-acceptance.md) |

Until the acceptance record is signed, treat every behaviour claim in these documents as verified in
software only. What is missing before an external beta is listed in [beta-checklist.md](beta-checklist.md).
