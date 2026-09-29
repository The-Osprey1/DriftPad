# Changelog

Versions follow `firmware/include/build_info.h` (`DRIFTPAD_FW_VERSION`). Nothing here has been
published or released; external beta additionally needs a signed hardware acceptance record
([docs/hardware-acceptance.md](docs/hardware-acceptance.md), [docs/beta-checklist.md](docs/beta-checklist.md)).

## 2.1.0-beta.1

Firmware, protocol and configurator move together; a configurator from before this version does not
work with this firmware and says so.

### Changed

- **Serial protocol v2.** Every reply carries `status` and `cmd` (and `id` when the request had an
  `@id` prefix); exactly one reply per line; strict parsing with 17 error codes; `INFO` reports
  version, build, limits, features, calibration, output and settings state. See
  [docs/serial-protocol.md](docs/serial-protocol.md).
- **One set of limits** in `firmware/include/settings_limits.h`: actuation 0.25 to 3.80 mm, Rapid
  Trigger sensitivity 0.10 to 2.00 mm. Out-of-range values are rejected with `out_of_range`, not
  clamped.
- **Settings are saved only on request** (`SAVE`, or the encoder after it has rested and typing has
  stopped). Mutating commands report `applied`, `persisted` and `dirty`.
- **Persistence** in two verified flash slots (A/B) plus the old sector for migration; an interrupted
  save leaves the previous settings intact ([docs/flash-layout.md](docs/flash-layout.md)).
- **Core ownership.** Core 1 alone touches I2C and the display; core 0 publishes a snapshot after
  every scan, so display work cannot delay a key scan ([docs/scheduling.md](docs/scheduling.md)).
- **Configurator consolidated** into one page (`configurator/index.html`): Keys, Sensitivity, Device;
  backup and restore; standalone mode (keyboard output at power-up). `keymap.html` redirects to it.
- Build is pinned by `firmware/toolchain.lock.json`; the library is `Keyboard`.

### Fixed

- Keyboard output: no stuck keys on remap, layer change, host sleep, unplug or calibration; keys held
  at power-up stay silent until released; 7th simultaneous key is dropped and counted, not corrupted.
- Output stays off until the pad has a valid calibration (unless forced), and boot output is opt-in.
- Serial parser: long lines are rejected whole instead of truncated and executed; trailing garbage,
  bad numbers and wrong argument counts are errors; an id is echoed even in error replies.
- `CAL FINISH` with no run active answers `not_allowed`; `CAL CANCEL` is idempotent; `SAVE` reports
  the slot with the same names as `INFO.settings.source`.
- Configurator: values count as "on the pad" only from a correlated reply or a fresh `GET_CONFIG`;
  unanswered writes are read back and reconciled; telemetry frames are parsed as the firmware sends
  them; dialogs, focus and screen-reader announcements; layout at 360 px.

### Added

- `INFO`, `REVERT`, `CAL`, `SET_BOOT_OUTPUT`, `TIMING`, `RAW` commands; guided calibration.
- `tools/flash.py` (identify, verify, refuse to lose unsaved settings), `tools/qualify_release.py`,
  `tools/check_toolchain.py`, `tools/timing_capture.py`, `tools/save_stress.py`,
  `tools/acceptance_record.py`, `tools/key_tester.html`.
- CI workflow running the whole suite in release mode.

### Compatibility and migration

- Settings saved by firmware v1 (up to commit `2734044`) are read, never written, from the legacy
  sector and reported with `INFO.settings.source` `legacy_v1`; they are marked dirty and move to a
  slot on the first `SAVE`. Actuation is clamped to today's limits (v1 allowed 0.10 mm; it becomes
  0.25 mm), unusable key codes and labels are replaced by the factory entry, and what was changed is
  reported as `legacy_repaired`. v1 stored no calibration, so it becomes `missing`: keyboard output
  stays off until the pad is calibrated (or output is forced). Downgrading to v1 firmware finds its
  settings as they were. Details: [docs/flash-layout.md](docs/flash-layout.md).
- Firmware older than this version (protocol 1) is refused by the configurator; update it with
  `tools/flash.py`.
- Downgrading from a newer settings format and saving twice discards the newer firmware's settings.

### Known limits

- Everything above is verified against models and fakes only. No physical pad has run this build.
