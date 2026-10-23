# DriftPad desktop app

## Windows users

Download the Windows x64 **Setup.exe** from a published
[release](https://github.com/The-Osprey1/DriftPad/releases), run it, and open
**DriftPad** from the desktop or Start menu. Setup installs for the current user
without requiring administrator access. **Portable.exe** does not install shortcuts.
Both include their runtime and run offline.

Until the first desktop release is published, use the **DriftPad-Windows-x64**
artifact under a successful **Windows desktop app**
[Actions run](https://github.com/The-Osprey1/DriftPad/actions/workflows/desktop.yml).
GitHub requires sign-in to download Actions artifacts. Unzip once, then run Setup.
No Node.js, Git, local server, terminal, or separate browser is needed to use the app.

Start in **Digital Twin**, or plug in your pad and click **Connect USB**. This opens the device interface. Click **Connect DriftPad**; the native
picker asks which serial device to connect to; it never selects one automatically.
If a device was connected after opening the picker, cancel and retry.

Profiles persist under **%APPDATA%\DriftPad**. The portable app also uses this
location, so moving its executable does not erase profiles. Browser profiles are
separate: export JSON from the browser app and import it in the desktop app.
Uninstalling retains profiles; updates use the same storage location.
Only one DriftPad instance runs at a time.

## First hardware setup

The app includes a real **DriftPad.uf2** built from the same source checkout.
You do not need PlatformIO, Python, Node.js, or a separate firmware download.

1. Open **Set Up Pad**. Disconnect the pad in DriftPad and unplug its cable.
2. Hold the Pico's **BOOTSEL** button while plugging it back in. Release it when
   the **RPI-RP2** drive appears.
3. Click **Choose drive & install**. Select **RPI-RP2** under **This PC**, then
   click **Install firmware here**. Keep the cable connected while the file copies.
4. When the drive disappears, close setup and click **Connect USB**, then
   **Connect DriftPad**. Open **Device → Calibration**. Release all keys, start,
   then press each of the 16 keys fully and release it. Finish, save, and test
   before enabling keyboard output.

The app checks the bundled UF2 blocks and RP2040 family, then checks the selected
root drive's `INFO_UF2.TXT` before writing. It only copies the bundled firmware;
there is no arbitrary file picker or automatic selection of a connected board.
Canceling the picker writes nothing. A failed or interrupted copy is reported as
an error, not success. **Firmware copied** means the Windows write completed;
it does not verify the running firmware, calibration, or physical inputs.

**Save UF2 file** remains available for manual drag-and-drop to RPI-RP2. Browser
builds without the desktop bridge use this manual route when firmware is bundled.
If RPI-RP2 is missing, use a data-capable USB cable and hold BOOTSEL before plugging
it in. Select the drive itself, not a folder. If copying fails, reconnect in
BOOTSEL mode before retrying.

The firmware targets the documented V2 Raspberry Pi Pico wiring and SSD1306 OLED.
Pico 2/RP2350 boards and SH1106 displays require different builds. The bootloader
marker identifies the chip family, not the DriftPad wiring or display. Export your
profiles before updating. See [hardware.md](hardware.md).

## Maintainers: build from source

Node.js 24, npm, and PlatformIO are build-time requirements only.

~~~sh
npm ci
cd desktop
npm install
cd ..
pio run --project-dir firmware
npm run desktop:dist
~~~

Run the desktop dependency install inside `desktop/`; installing the repository
root into that package would bundle source and build output recursively.
Build on Windows to produce Setup and Portable executables. To use an existing
firmware image, set DRIFTPAD_FIRMWARE to its path. The preparation script validates
UF2 framing, RP2040 family, block completeness, and Pico flash bounds before bundling it. To launch from source:

~~~sh
npm run desktop:prepare
npm run desktop:start
~~~

These commands use the production UI without starting Vite. Browser development
commands remain available. The root dependency lockfile is unchanged. Desktop
build tools live in a separate package with exact direct versions; CI archives
the resolved desktop lockfile with validation reports. Transitive desktop
dependencies are resolved at build time.

## Packaging and validation

The desktop workflow compiles firmware, runs tests and TypeScript checks, builds
both executables, launches the packaged app twice, installs it silently on the
disposable Windows runner, and repeats launch checks on the installed app.
It verifies UI rendering, the firmware setup dialog and focus, a secure Web Serial
context, absence of Node access in the renderer, the restricted firmware bridge,
bundled firmware, and storage persistence across restarts. Smoke mode refuses
firmware installation before a native picker opens or any drive is written.
Launch reports and screenshots are attached to the run.

Before publishing, test on a Windows PC:
- Start offline, create a profile, quit, reopen, and export/import JSON.
- Connect a real Pico; cancel the picker; unplug during connection; reconnect.
- Verify telemetry, calibration, HID enable/disable, and saving device settings.
- Install with **Choose drive & install** in BOOTSEL mode and confirm the pad boots
  and reconnects; also check cancellation, wrong-drive rejection, and manual copying.
- Check installer shortcuts and an upgrade with an existing saved profile.

The app uses a sandboxed renderer without Node integration. Its isolated preload
exposes only `installFirmware()` with no arguments. The main process checks the
calling window and top-level frame, owns the native drive picker, reads only the
bundled image, and writes only `DriftPad.uf2` on the validated selected drive.
Concurrent installs are rejected and normal window closing is blocked during setup.
Packaged assets use a stable secure custom origin. Navigation is blocked;
only project GitHub links open externally. Only the app can request serial access,
and each port is explicitly selected. Local system fonts keep the app offline.

## Releases

Update desktop/package.json to the desired version, then push its matching
vX.Y.Z tag. After successful validation, CI prepares a **draft** release with the
installer, portable app, firmware, and SHA-256 checksums. Review the artifacts and
hardware checks before publishing the draft. Releases are not published
automatically. **Help > Downloads and updates** opens the releases page.

Builds are **unsigned** until Windows code signing is configured. Windows may
show an unknown-publisher or SmartScreen warning. Do not describe an unsigned
build as trusted or disable Windows security globally. Code signing and automatic
updates are separate follow-up work.
