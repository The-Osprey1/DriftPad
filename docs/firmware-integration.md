# Firmware integration

The `firmware/` directory is the source for the firmware bundled with the Windows
app. The protocol-aware device interface lives in `configurator/`; Studio remains
the React profile preview and simulator in `src/`. Both interfaces ship together.
There is one firmware source tree and one hardware configuration interface.

## Imported work

This integration brings forward the `screensaver-lava-and-fixes` checkout at
`79195cef451382de2771e6a11fa51aab7b23c956` plus its unfinished changes preserved on
October 14, 2026. The source checkout was copied and hashed before integration;
its history, working-tree patch, and nonignored files were backed up separately.
The source checkout was not modified or flashed.

The imported work includes protocol 2, correlated command replies, guided
calibration, sensor fault handling, keyboard output ownership, A/B settings
storage, dual-core display scheduling, screensaver playback, and their host and
browser tests. Historical display captures under `docs/reviews/` describe their
original builds, not acceptance evidence for this integrated build.

## Desktop behavior

**Connect USB** opens the device interface; **Connect DriftPad** selects a serial
port and identifies the firmware. It shows confirmed settings, distinguishes
pending edits from saved settings, and guides rest/full-travel calibration.
**Back to Studio** disconnects and returns to the local simulator. Unsaved device
changes prompt before leaving.

Studio productivity profiles contain preview features that the firmware does not
implement, such as modifier combinations, per-key actuation, and encoder remaps.
Studio profiles do not automatically overwrite the physical pad. Hardware keymap
backups and Studio profile backups have separate schemas.

## Verification and remaining acceptance

The reusable firmware workflow runs the full test runner in release-check mode
on Linux and Windows, verifies the toolchain lock, and only then supplies firmware
to the desktop build. Desktop checks exercise navigation, security, simulated
protocol-2 identification, acknowledged settings/save, and restart persistence.

Integration also repairs an outdated Python display snapshot buffer: the firmware
had added a sensor-fault mask, while the test still allocated the smaller structure.
The native test interface now validates the supplied buffer size before writing,
and a regression test checks that an old-sized buffer remains untouched.

Automated release checks do not authorize a public release or establish physical
hardware acceptance. Run [hardware acceptance](hardware-acceptance.md) against the
exact resulting build before calling it hardware-qualified. In particular verify
all 16 sensors, OLED, encoder, USB output, reboot persistence, and reconnect behavior.
