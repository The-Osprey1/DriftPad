# DriftPad

A browser configurator and simulator for a 16-key Hall-effect macropad built on
the Raspberry Pi Pico (RP2040). The repository includes the React app, firmware,
hardware reference, and OLED design studies.

## Start the app

### Online (GitHub Pages)

Open **https://the-osprey1.github.io/DriftPad/** in Chrome or Edge. Nothing to install. The page
is the device configurator; it changes the settings stored on your pad.

1. Click **Download firmware**. Hold BOOTSEL while plugging in the Pico, then copy `DriftPad.uf2`
   onto the `RPI-RP2` drive. The configurator needs this firmware (protocol 2); the pad restarts
   by itself when the copy finishes.
2. Click **Connect DriftPad** and pick the pad in the browser's list.
3. On the **Device** tab, run the calibration wizard. Keys do not type, and the screen ignores
   them, until calibration is done.

The site is rebuilt from `main` by [`pages.yml`](.github/workflows/pages.yml), and the firmware it
offers is the build that passed the full test suite in that same run. The Studio simulator is in the
Windows app and `npm run dev`, not on the site.

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

## Studio and your pad

**Connect USB** opens the device interface, then **Connect DriftPad** asks you to
select the pad. This interface identifies firmware version and protocol, shows
confirmed device settings, guides calibration, and waits for save acknowledgments.
It runs offline in the Windows app and is also available at
`/configurator/index.html` in the development server. **Back to Studio** returns to
the simulator.

Studio profiles, modifier combinations, encoder remaps, per-key actuation, and OLED
themes are previews stored on this computer. They are not automatically written to
the physical pad. Use the device interface for supported key mappings, global
sensitivity, calibration, output, and display controls.

## What's included

- A 4×4 key matrix with three mapping layers and productivity profile presets.
- Actuation and Rapid Trigger controls, including per-key actuation overrides.
- Profile backup import/export, a usage heatmap, and rotary encoder controls.
- A 128×64 OLED preview with six screensavers and adjustable display themes.
- USB WebSerial communication and a browser-side DSP simulator.
- RP2040 firmware for Hall sensors, a multiplexer, an encoder, and an OLED display. The knob is
  a volume control (turn, press to mute); holding it opens the settings menu on the display.
- Key combinations: any key can hold Ctrl, Shift, Alt and Win with its key (Ctrl + C, Win + D),
  set with four checkboxes in the configurator.

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
| Encoder push switch | GP2 |
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

1. Install the bundled firmware with **Set Up Pad** if needed.
2. Click **Connect USB**, then **Connect DriftPad**, and select the pad.
3. In **Device**, check the firmware identity and keep keyboard output off.
4. Open **Calibration**, release every key, and choose **Start**. After the rest
   phase, press every key fully and release it. When all 16 are done, choose
   **Finish** and **Save**.
5. Test all 16 keys and the OLED; configure mappings and sensitivity, then save.
6. Reconnect and verify calibration and saved settings before enabling keyboard
   output. Standalone output at boot is a separate deliberate setting.

`CALIBRATE` only re-zeros an already calibrated pad. Initial calibration uses
`CAL START` and `CAL FINISH`; see [calibration](docs/calibration.md).
Viewing a layer does not change the active layer on the pad. Use the explicit
**Make this the active layer on the pad** button when that is intended.

### Troubleshooting

- **No serial port:** use a data-capable USB cable and Chrome, Edge, or Opera.
- **Upload failure:** hold BOOTSEL while plugging in the Pico, then retry PlatformIO.
- **Wrong key travel:** use guided calibration for missing or invalid calibration; use `CALIBRATE` only to re-zero a valid calibration.
- **Blank OLED:** check GP0/GP1, power, ground, address `0x3C`, and run `OLED_SCAN`.
- **Unexpected typing:** disable HID with `SET_HID 0` before further testing.
- **Settings not retained:** use `SAVE` for device flash and export profile JSON for
  browser-side profile backups.

See [`docs/hardware.md`](docs/hardware.md), [`docs/serial-protocol.md`](docs/serial-protocol.md),
and [`docs/testing.md`](docs/testing.md) for the authoritative pinout, command reference,
and validation procedures.



## Engineering guides

- [firmware integration](docs/firmware-integration.md)
- [beta checklist](docs/beta-checklist.md)
- [bring up](docs/bring-up.md)
- [calibration](docs/calibration.md)
- [configurator](docs/configurator.md)
- [desktop](docs/desktop.md)
- [flash layout](docs/flash-layout.md)
- [hardware acceptance](docs/hardware-acceptance.md)
- [hardware](docs/hardware.md)
- [scheduling](docs/scheduling.md)
- [serial protocol](docs/serial-protocol.md)
- [testing](docs/testing.md)

## License

See [LICENSE](LICENSE).
