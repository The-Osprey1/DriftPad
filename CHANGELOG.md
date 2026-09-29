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
- A refused `CALIBRATE` (`keys_not_at_rest`) no longer releases keys that are being held.
- `CALIBRATE` without a valid calibration answers `applied:false` (only the running baselines are re-zeroed).
- The encoder's delayed save no longer commits settings that a command changed and left unsaved; those stay
  unsaved (INFO `dirty`) until `SAVE`.
- The display link's sequence counter no longer looks "unpublished" after wrapping (one frame lost every ~24 days).
- A failed encoder save is retried after the next rest instead of being dropped.
- `INFO.settings.source` names the slot just written after a `SAVE` (it kept saying `legacy_v1` with the new sequence number until the next power-up). Found when updating a real pad.
- `tools/flash.py --drive` (a board in bootloader mode) no longer verifies against a different pad
  that was already connected.
- `tools/timing_capture.py` reads `TIMING` once at the end by default (each poll delays a scan by ~1.2 ms and was
  counted as a gap), and judges a save's gap as the save plus 2 ms (the SAVE command's own handling).
- OLED: the right-aligned `RT 0.20mm` header wrapped its last glyph onto the row below, over the
  READY/TRAVEL label; text no longer wraps. The synthwave screensaver's horizon lines no longer merge
  into a solid band.

### Added

- OLED key screen motion: map cells fill as a key approaches its actuation point, pop with a ring on
  actuation and fade out on release (about 260 ms), so quick taps are visible. The tuning card wipes
  in and out, and its slider glides to new values. The starfield screensaver is denser.
- OLED power-up / reset intro (about 5.4 s plus a 0.7 s wipe; any key press ends it), drawn like an
  instrument coming up: corner brackets and a ruler along the bottom edge (the scale the key screen
  measures travel with) come on; the `DRIFTPAD` wordmark, a heavy extended italic with chamfered
  corners cut by a fine slit, arrives as halves that drift in from opposite sides and lock together,
  with a glint across it; a low swell settles on a fine horizon and a tracked `HALL-EFFECT` tagline
  types in, is erased, and the pad's real status types in (`OUTPUT READY`, `CALIBRATION NEEDED` or
  `OUTPUT OFF`) while the ruler's bar fills. A second glint crosses, then the screen wipes into the
  key screen. The firmware version appears at the top.
- OLED screens share the title screen's design language: the tuning cards have a hairline header with
  the page name in capitals and four page pips, big values and names in the title screen's italic
  slit lettering, and the slider is the boot ruler (ticks at each detent, a bar under it, a pointer over
  it); the key label and the standby layer name use the same italic slit lettering; screensaver title
  cards are bracketed tracked capitals.
- OLED screensaver: read-only serial queries (`PING`, `INFO`, `STATUS`, `GET_CONFIG`, `STREAM`) no longer
  count as activity, so an open configurator tab or a polling script does not hold the screensaver off
  while the pad sits idle. Animations: the name badge is now a title card that slides in for 3.5 s and
  leaves the animation clear; the starfield streaks and is denser. The rain and wave screensavers are
  replaced by a dithered plasma and a rotating tesseract (4-D hypercube). Screensaver polish: the starfield
  surges into hyperspace and steers; the plasma breathes; the tesseract trails a dotted ghost; the
  grid has drifting mountains the sun sets behind; ripples ease out from a droplet.
- OLED key screen streamlined: the status slot (top-left) is empty unless it has something to say
  (`ACTUATED`, `CAL NEEDED`, `OUTPUT OFF`); `READY`, `TRAVEL`, the scale end labels and the layer name
  in the header are gone.
- OLED: with Rapid Trigger on, a pointer above the travel scale marks where the held key will release
  (deepest travel so far minus the RT sensitivity).
- OLED: while key presses are not being sent to the computer (calibration missing, output off), the
  status label says `CAL NEEDED` or `OUTPUT OFF` in an inverted chip instead of `READY`/`TRAVEL`.
- OLED: the screensaver dims 3 minutes after it starts (contrast, pre-charge and VCOMH all lowered, since contrast
  alone is barely visible on some panels) and any input returns the panel to full brightness; the splash
  screen is centered and shows the firmware version instead of an unverified "USB Connected".
  `tests/test_oled_frames.py` renders the real screens on the host; `tools/render_oled_frames.py`
  regenerates `docs/images/oled_showcase.png` from them.
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
- `flash.py --drive` cannot identify the board first, so it cannot warn about a downgrade or unsaved
  settings; the confirmation prompt is the only guard.
- The display link's request read can, in a rare race, show a test pattern twice (cosmetic).
