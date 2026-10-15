# Testing

## Automated web checks

From the repository root, with Node.js 24 or newer and npm:

```bash
npm ci
npm run check
```

`npm run check` runs the unit tests, checks TypeScript in the app and Vite
configuration, and creates the production build. Individual commands are
`npm test`, `npm run typecheck`, and `npm run build`.

| Test file | Coverage |
|---|---|
| [`dspEngine.test.ts`](../src/engine/dspEngine.test.ts) | Digital Twin command responses, per-key actuation, simulated events, and streaming start/stop |
| [`profileValidation.test.ts`](../src/services/profileValidation.test.ts) | Built-in profiles, invalid layer/key data, duplicate profile IDs, and backup validation |

Desktop tests in `desktop/*.test.cjs` also run with `npm test`. They cover asset
and navigation restrictions, serial selection, UF2 corruption/wrong-family
rejection, drive validation, exact copy bytes, cancellation, concurrent requests,
and failed writes. Drive I/O is substituted in these tests; no physical pad is
flashed. Packaged-app smoke checks are described in [desktop.md](desktop.md).

These tests run in Node without a browser or device. They do not execute the C++
firmware or exercise browser permissions, real USB communication, or rendered UI.
There is no Python `tests/run_all_tests.py` harness in this branch.

## Firmware build

Install PlatformIO, then run from the repository root:

```bash
pio run --project-dir firmware
```

The Pico build writes `firmware/.pio/build/pico/firmware.uf2`. Build output is
ignored by Git. The platform and libraries in `firmware/platformio.ini` are not
fully pinned, so record their resolved versions when collecting build evidence.

[`firmware/test/`](../firmware/test) reserves a location for future firmware unit
tests; there are no executable firmware unit tests in this branch. Compilation
does not establish correct physical behavior.

## Continuous integration

[DriftPad CI](../.github/workflows/ci.yml) runs the web checks and a separate
PlatformIO build for pushes to `main` and pull requests. The web job reads the
Node version from [`.nvmrc`](../.nvmrc) and installs from `package-lock.json`.

## Manual browser checks

Run `npm run dev`, or `npm run preview` after a production build, then check:

1. Start in Digital Twin mode and confirm the key matrix and OLED preview render.
2. Change layers and profiles, then adjust actuation and Rapid Trigger controls.
3. Remap a key and confirm the selected layer receives the change.
4. Export a profile backup, import it, and confirm its mappings are restored.
5. Try an invalid backup and confirm the existing profiles remain intact.
6. Check keyboard navigation, dialogs, and the layout at a narrow window width.

These are manual checks, not coverage provided by `npm test`.

## Hardware smoke test

After flashing and connecting the Pico through WebSerial, keep HID disabled while
checking the device. Start with:

```text
SET_HID 0
PING
GET_CONFIG
OLED_SCAN
STATUS
```

Release every key before running `CALIBRATE`. Check sensor travel and layer
mappings before enabling HID. `SIM 0 1.50` followed by `SIM 0 0.00` exercises
simulated input; it is not a measurement of the physical sensor. `SAVE` writes
settings to the device.

Record the source commit, resolved toolchain, board/display variant, host/browser,
and observed results when reporting a hardware test. Use the
[hardware reference](hardware.md) and [serial command reference](serial-protocol.md).

## Optional performance benchmark

```bash
npm run benchmark:life
```

This compares two standalone Game of Life implementations. Its timings depend on
the host and are not an automated UI performance check or a CI acceptance gate.
