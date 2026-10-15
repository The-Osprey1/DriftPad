# DriftPad

A browser configurator and simulator for a 16-key Hall-effect macropad built on
the Raspberry Pi Pico (RP2040). The repository includes the React app, firmware,
hardware reference, and OLED design studies.

## Start the app

### Windows desktop app

Download **Setup.exe** from a published [release](https://github.com/The-Osprey1/DriftPad/releases),
install it, and open DriftPad from your desktop. No terminal, Node.js, or separate
browser is needed. The portable executable runs without installation.

Until the first desktop release is published, download the **DriftPad-Windows-x64**
artifact from a successful [desktop build](https://github.com/The-Osprey1/DriftPad/actions/workflows/desktop.yml).
Both versions include Digital Twin, USB configuration, and Pico firmware. Open
**Set Up Pad** to install the bundled firmware directly onto the Pico's BOOTSEL drive;
no developer tools are needed.
See [desktop setup](docs/desktop.md) for details.

### Browser development setup

Use **Node.js 24 or newer**, npm, and a Chromium-based browser such as Chrome or
Edge for WebSerial. The recommended Node version is recorded in [`.nvmrc`](.nvmrc).

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`. Leave the connection mode in **Digital Twin** to
explore profiles, layers, key travel, Rapid Trigger, and the OLED preview without
hardware.

## What's included

- A 4×4 key matrix with three mapping layers and productivity profile presets.
- Actuation and Rapid Trigger controls, including per-key actuation overrides.
- Profile backup import/export, a usage heatmap, and rotary encoder controls.
- A 128×64 OLED preview with six screensavers and adjustable display themes.
- USB WebSerial communication and a browser-side DSP simulator.
- RP2040 firmware for Hall sensors, a multiplexer, an encoder, and an OLED display.

The Digital Twin is a software model. Simulator tests and successful firmware
builds do not establish physical sensor accuracy, USB timing, or hardware acceptance.
PCB and enclosure directories currently contain placeholders.

## Development commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the development server on port 3000 |
| `npm test` | Run the Digital Twin and profile validation tests |
| `npm run typecheck` | Check app and Vite configuration types |
| `npm run lint` | Alias for type checking; no separate style linter is configured |
| `npm run build` | Check types and build the app into `dist/` |
| `npm run check` | Run tests and the production build |
| `npm run preview` | Serve the production build on port 3000 |
| `npm run benchmark:life` | Compare the Game of Life implementations |

Use npm and commit `package-lock.json` when changing dependencies. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

## Repository guide

| Path | Contents |
|---|---|
| [`src/`](src) | React UI, browser services, DSP model, tests, and benchmark |
| [`firmware/`](firmware) | PlatformIO project for the Raspberry Pi Pico |
| [`docs/hardware.md`](docs/hardware.md) | Pinout, mux channel map, and default keymaps |
| [`docs/serial-protocol.md`](docs/serial-protocol.md) | USB serial commands |
| [`docs/testing.md`](docs/testing.md) | Automated checks and manual verification |
| [`docs/design/`](docs/design) | Historical interface design plan |
| [`docs/oled_concepts/`](docs/oled_concepts) | OLED visual studies and previews |
| [`hardware/`](hardware) | Placeholder locations for PCB and enclosure sources |

## Hardware

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


## License

See [LICENSE](LICENSE).
