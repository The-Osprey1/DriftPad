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

Start in **Digital Twin**, or plug in your pad and click **Connect USB**. The native
picker asks which serial device to connect to; it never selects one automatically.
If a device was connected after opening the picker, cancel and retry.

Profiles persist under **%APPDATA%\DriftPad**. The portable app also uses this
location, so moving its executable does not erase profiles. Browser profiles are
separate: export JSON from the browser app and import it in the desktop app.
Uninstalling retains profiles; updates use the same storage location.
Only one DriftPad instance runs at a time.

## First hardware setup

Open **Set Up Pad** for a real, bundled **DriftPad.uf2** built from the same source
checkout. Hold BOOTSEL while plugging in the Pico and copy the UF2 onto its
**RPI-RP2** drive. The app does not claim it has flashed, calibrated, or verified
the pad. Reconnect after the Pico restarts, calibrate with keys released, and test
before enabling HID.

The bundled firmware targets the documented V2 Raspberry Pi Pico wiring and
SSD1306 OLED. Other hardware or SH1106 displays require a matching firmware build.
Export profiles before changing firmware. See [hardware.md](hardware.md).

## Maintainers: build from source

Node.js 24, npm, and PlatformIO are build-time requirements only.

~~~sh
npm ci
npm install --prefix desktop
pio run --project-dir firmware
npm run desktop:dist
~~~

Build on Windows to produce Setup and Portable executables. To use an existing
firmware image, set DRIFTPAD_FIRMWARE to its path. The preparation script validates
UF2 block framing before bundling it. To launch from source:

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
It verifies UI rendering, a secure Web Serial context, absence of Node access in
the renderer, bundled firmware, and storage persistence across restarts.
Launch reports and screenshots are attached to the run.

Before publishing, test on a Windows PC:
- Start offline, create a profile, quit, reopen, and export/import JSON.
- Connect a real Pico; cancel the picker; unplug during connection; reconnect.
- Verify telemetry, calibration, HID enable/disable, and saving device settings.
- Copy the bundled UF2 in BOOTSEL mode and confirm the pad boots and reconnects.
- Check installer shortcuts and an upgrade with an existing saved profile.

The app uses a sandboxed renderer without Node integration or a privileged preload.
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
