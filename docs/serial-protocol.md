# Serial protocol v2

DriftPad speaks a line-based text protocol over its USB serial port (CDC, 115200 baud nominal). The
[configurator](../configurator/index.html) uses it; so can any serial terminal or script
(`tools/driftpad_serial.py`). The firmware's command table is `TABLE` in
[`firmware/src/commands.cpp`](../firmware/src/commands.cpp); `tests/test_contract_consistency.py`
fails when this document and the table disagree. Detect capabilities with `INFO`: `protocol` is 2 and
`features[]` lists what this firmware has (`keymap layers rapid_trigger telemetry timing raw sim
display guided_calibration boot_output settings_ab display_status encoder_status key_modifiers
screensaver_idle themes`). Firmware before 2.1.0 spoke protocol 1
(replies without `cmd` or `id`); the configurator refuses it and says so.

## Limits

| Setting | Minimum | Maximum | Default |
|---|---|---|---|
| Actuation (`SET_ACTUATION`) | 0.25 mm | 3.80 mm | 1.20 mm |
| Rapid Trigger sensitivity (`SET_RT_SENS`) | 0.10 mm | 2.00 mm | 0.20 mm |
| Layers / keys | 3 (0-2) | 16 (0-15) | |
| Key code | 0 | 255 | |
| Line length | | 160 bytes | |
| Screensaver idle start (`SET_SAVER_IDLE`) | 0 minutes (never) | 60 minutes | 2 minutes |
| Screen theme (`SET_THEME`) | 0 (Drift) | 1 (Cherry blossom) | 0 |
| Request id | | 12 characters | |
| Stream rate | | 60 Hz | 30 Hz |

Only `INFO.limits` is authoritative at run time; the configurator reads its bounds from there.

## Framing

- Lines end with `\n` or `\r` (`\r\n` counts once); empty lines are ignored and get no reply.
- At most 160 bytes per line. A longer line is discarded whole and answered with
  `{"status":"error","cmd":"","code":"line_too_long",...}`; it is never truncated and executed.
  Lines containing control bytes are answered with `bad_request`.
- Optional request id prefix `@<id> ` (1–12 of `A-Z a-z 0-9 _ -`), echoed as `"id":"<id>"`.
- Verbs are case-insensitive; argument counts are exact (`bad_arguments` with `min_args`/`max_args`).
- Every non-empty line gets exactly one reply line with `"status":"ok"|"error"` and `"cmd"`
  (canonical verb, `""` if unknown) plus `"id"` when one was sent.
- Unsolicited lines (events) never contain `"status"`: `{"type":"telemetry"|"raw"|"boot"|"cal",...}`.
- Numbers: millimetres are decimal with at most 2 decimals (`1`, `1.2`, `1.25`; leading zeros
  allowed). Anything else is `bad_number`; valid syntax outside the limits is `out_of_range` with
  `min`/`max`. Booleans: `0`/`1`/`on`/`off`/`true`/`false`.
- Errors: `{"status":"error","id":..,"cmd":..,"code":"<code>","msg":"..."}`. Codes never change
  meaning; `msg` is for humans:

| Code | Meaning |
|---|---|
| `unknown_command` | The verb is not in the command table (`cmd` is `""`) |
| `bad_request` | Malformed line: control bytes, bad request id |
| `bad_arguments` | Wrong number of arguments (`min_args`/`max_args` say how many) |
| `bad_number` | An argument is not a number in the accepted syntax |
| `out_of_range` | Valid number outside the limits (`min`/`max` given) |
| `invalid_label` | Label breaks the label rule below |
| `invalid_code` | Key code that produces no keyboard output (0 to 255 is the syntax; not every value is assignable) |
| `busy` | Another operation is in progress (calibration running, a display command still pending) |
| `not_allowed` | Refused in this state (`REVERT` with nothing saved, `CAL FINISH` with no run active) |
| `calibration_required` | `SET_HID 1` without valid calibration and without `FORCE` |
| `calibration_incomplete` | `CAL FINISH` before every key finished (`missing` lists them) |
| `keys_not_at_rest` | `CALIBRATE` while keys are pressed (`keys` lists them) |
| `line_too_long` | Line over 160 bytes; discarded whole, never executed |
| `flash_error` | Erase or program failed during `SAVE` |
| `flash_verify_failed` | The written record did not read back correctly |
| `display_timeout` | The display core did not answer within 1.5 s |
| `unsupported` | Internal: a handler produced no usable reply (not expected in normal use) |

- Mutating commands reply with the effective value read back from the device and
  `"applied":true, "persisted":<in flash now>, "dirty":<RAM differs from flash>`. Nothing is written
  to flash except by `SAVE` and the encoder's delayed save, which is skipped while a command's own
  edits are unsaved.

## Commands

| Command | Reply fields (besides status/cmd/id) |
|---|---|
| `PING` | `type:"pong"` |
| `INFO` (alias `HELLO`) | `type:"info", device:"DriftPad", hw, fw, protocol:2, build, build_date, features[], limits{actuation{min,max,default,step}, rt_sens{...}, layers, keys, label_max, label_chars, code_max, line_max, stream_hz_max, saver_idle_max, saver_anims, themes}, calibration{state}, output{enabled, reason, active_keys[], suppressed_keys[], overflow, delivery}, settings{dirty, source, seq, load_errors[]}, uptime_ms`, plus optional `display{available, mode, animation, shuffle, dimmed}` when `display_status` is advertised |
| `GET_CONFIG` | `type:"config", actuation, rt_sens, rt_enabled, active_layer, boot_output, saver_idle, saver_anim, theme, dirty, settings_seq, layers[3][16]{idx, code, label, mods}` (`mods` with feature `key_modifiers`; `saver_idle` and `saver_anim` with `screensaver_idle`; `theme` with `themes`) |
| `STATUS` | `type:"status", active_layer, last_key, keys[16]{idx, pressed, travel, label}, output{...}, calibration{state}, sim_mask, dirty`, plus optional `display{...}` when `display_status` is advertised |
| `STREAM <0|1> [hz]` | `streaming, hz`; then `{"type":"telemetry","seq","t","layer","pressed"(bitmask),"active"(bitmask),"sim"(bitmask),"travel"[16 × cmm ints],"knob"{a,b,sw,steps,presses},"dirty"}` at `hz` (default 30, max 60). `knob` (feature `encoder_status`) gives the raw encoder pin levels (1 = HIGH, contact open) and the quadrature steps and debounced presses counted since boot, for wiring checks. Streaming stops when the host closes the port. |
| `SET_ACTUATION <mm>` | `actuation` + applied/persisted/dirty |
| `SET_RT_SENS <mm>` | `rt_sens` + applied/persisted/dirty |
| `SET_RT_ENABLE <bool>` | `rt_enabled` + applied/persisted/dirty |
| `SET_LAYER <0-2>` | `active_layer` + applied/persisted/dirty |
| `SET_KEY <layer> <key> <code> [label] [mods]` | `layer, key, code, label` (normalised), `mods` + applied/persisted/dirty. `mods` (feature `key_modifiers`, 0 to 15) are modifiers held with the key: 1 Ctrl, 2 Shift, 4 Alt, 8 Win, so `SET_KEY 0 3 99 COPY 1` makes key 3 send Ctrl+C. Omitted means 0, a plain key; `mods` needs `label` before it. With code 0 the key sends only the modifiers |
| `SET_SAVER_IDLE <minutes>` | `saver_idle` + applied/persisted/dirty. Feature `screensaver_idle`: the screensaver starts by itself after this many idle minutes, 0 to 60; 0 = never (see below) |
| `SET_SAVER_ANIM <0-6\|SHUFFLE>` | `saver_anim` (`-1` for shuffle) + applied/persisted/dirty. The animation the idle screensaver plays, numbered as for `ANIM` |
| `SET_THEME <0-1>` | `theme`, `saver_anim` + applied/persisted/dirty. Feature `themes`: the screen's look, 0 Drift or 1 Cherry blossom (title, key card, press effect, layer change, standby art). It also sets the idle screensaver to the theme's own (Drift: shuffle, `-1`; Cherry blossom: Sakura, `6`); a later `SET_SAVER_ANIM` picks another. Behaviour is the same in every theme |
| `SET_HID <bool> [FORCE]` (aliases `HID`, `OUTPUT`) | `hid_output, output{...}` (runtime only, never saved) |
| `SAVE` | `persisted:true, dirty:false, duration_ms`, or error `flash_error`/`flash_verify_failed` with `persisted:false` |
| `REVERT` | `applied, persisted, dirty` — reloads the saved settings; `not_allowed` when nothing is saved |
| `RESET` | `applied:true, persisted:false, dirty:true` — factory keymaps and settings, not saved |
| `CALIBRATE` | quick re-zero of every key's rest reading; `applied, persisted, dirty, calibration` (state name), or `keys_not_at_rest` with `keys:[...]`. `applied` is true only when a valid calibration was updated; without one only the running baselines are re-zeroed (`applied:false`) and `CAL START` is needed |
| `SIM <key> <mm>` / `SIM <key> OFF` / `SIM OFF` | `type:"sim_event", key, travel, pressed, sim_mask` — simulated keys never produce keyboard output |
| `SCAN_RATE` | `type:"scan_rate", hz, max_gap_us` |
| `TIMING [RESET]` | `type:"timing", ...` |
| `RAW <key>` | `key, samples:1000, rate_hz`; then `{"type":"raw","key","rate_hz","offset","total","samples"[<=100]}` events |
| `FULLSCREEN [bool]` | `fullscreen` — immediate request acknowledgment |
| `SCREENSAVER` | `screensaver:true` — starts a new session using the last animation selection; immediate request acknowledgment |
| `ANIM [0-6]` | `anim` — selected fixed animation, or `-1` when the argument is omitted to shuffle all seven; starts a new session; immediate request acknowledgment |
| `SLEEP`, `WAKE` | `sleep:true` or `wake:true` — immediate request acknowledgment |
| `OLED_TEST`, `OLED_SCAN` | `OLED_TEST` replies with `display:"test_pattern"` after the display core serves it (normally shown for up to 2 s; a later mode request supersedes it). `OLED_SCAN` replies with `devices[]` (at most 8) and `more` when others answered, after the scan. Error `display_timeout` after 1.5 s. Other commands are answered meanwhile; a second deferred command gets `busy`. |
| `BOOTSEL` | `bootsel:true`, then the device reboots into its USB bootloader |

Label rule (firmware and configurator must agree; vectors in `tests/fixtures/label_vectors.json`):
`a-z` uppercased; 1–4 characters; printable ASCII 0x21–0x7E except `"` `\` `@`; anything else is
rejected (`invalid_label`), never rewritten.

## Display state and manual screensaver operation

The optional `display_status` capability adds the same `display` object to `INFO` and `STATUS`:

```json
{"available":true,"mode":"screensaver","animation":2,"shuffle":false,"dimmed":false}
```

| Field | Meaning |
|---|---|
| `available` | The OLED was initialized successfully after its `0x3C` address acknowledged. Failed initialization is retried by the display core. This is not continuous unplug detection or proof of physically visible pixels. |
| `mode` | The display core's applied mode: `screen`, `screensaver`, or `sleep`. |
| `animation` | The animation currently shown (0–5); `-1` outside screensaver mode. During a wipe, this changes to the incoming animation halfway through. |
| `shuffle` | True only while a shuffled screensaver session is active; false for fixed playback, normal screens, and sleep. |
| `dimmed` | The display core has applied the screensaver's reduced panel levels. |

Core 1 publishes these fields together; core 0 reads that consistent state without touching I2C.
`ANIM`, `SCREENSAVER`, `SLEEP`, and `WAKE` replies acknowledge a posted request, so an immediate
`INFO` or `STATUS` can still report the previous mode. Read again to confirm application. Read-only
queries do not wake the display, restart an animation, or reset its dim timer. Clients must accept
older protocol-2 firmware without `display_status` or the optional object.

| `ANIM` argument | Animation |
|---|---|
| omitted (`anim:-1` in the reply) | Shuffle all |
| `0` | Starfield |
| `1` | Plasma |
| `2` | Tesseract |
| `3` | Drift grid |
| `4` | Magnetic pulse |
| `5` | Lava lamp |
| `6` | Sakura (petals falling past a moon; the Cherry blossom theme's own) |

Omitting the argument shuffles a complete bag of seven animations, using every animation once before
refilling it. Adjacent animations never repeat, including across bag boundaries. Each animation
has a 20-second full-screen dwell followed by a 1.5-second wipe to the next one. A fixed index keeps
that animation until another request or input ends the session. The reply value `-1` identifies
shuffle mode; sending `ANIM -1` is not valid syntax.

`SCREENSAVER` starts another session using the last chosen fixed animation or shuffle mode; its
power-up default is shuffle. Restarting playback restores full panel levels and starts a new
three-minute dim timer. After three minutes of uninterrupted playback the panel dims; `WAKE` or
trusted key/rotary activity restores full brightness and returns to the selected screen. The first
menu input from the knob while hidden only wakes the display, preserving the selected menu and settings;
volume and mute (the knob outside the menu, while keyboard output is on) still apply.
Idle never puts the display to sleep or changes the selected standby page. With `screensaver_idle`,
it starts the screensaver: after `saver_idle` minutes without trusted key activity, a knob input or a
mutating command, the display core starts a session with `saver_anim` (stored settings, factory 2
minutes and shuffle; `SET_SAVER_IDLE 0` turns it off). It does not start over the tuning menu, while
the display is off, or while key input cannot be trusted (calibration missing, invalid or running).
Without `screensaver_idle`, idle never starts a screensaver.
Wake, sleep, screensaver and test-pattern requests are applied in posting order: a later `WAKE`,
`SLEEP` or `SCREENSAVER` cancels an older test pattern, whether it was active or still queued.
If `SLEEP` is applied while the OLED is unavailable, successful initialization later preserves
that sleep mode and leaves the panel off until another action wakes or restarts it.

## Calibration, boot output and settings slots

Advertised by `INFO.features` as `guided_calibration`, `boot_output` and `settings_ab`; `SET_BOOT_OUTPUT`, `CAL` and `REVERT` exist only with them.

- `INFO.calibration`: `{"state":"valid|missing|invalid|in_progress","keys_valid":n,"held_at_boot":[keys],"drift":[keys],"faults":[keys]}`.
- `INFO.output.reason`: `enabled`, `disabled_default`, `calibration_missing`, `calibration_invalid`,
  `calibration_in_progress`, `user_disabled`, `forced`.
- `SET_HID 1` without `FORCE` → error `calibration_required` (with `calibration`: the state name) unless calibration is valid.
- `SET_BOOT_OUTPUT <bool>` → `boot_output` + applied/persisted/dirty. With it on and calibration
  valid, keyboard output starts enabled at power-up (keys held at power-up stay suppressed until
  released).
- `RESET ALL` → like `RESET`, and calibration becomes `missing` (keyboard output disabled). Both report `all`.
- `CAL START` → `{"phase":"rest","rest_ms":500}`; keyboard output is suspended.
  Events: `{"type":"cal","phase":"rest|travel|done|failed|cancelled","rest_ok":[keys],"rest_failed":[keys],"travel_done":[keys],"elapsed_ms":n}`.
  Rest phase: keys untouched for at least 500 ms; more than 120 ADC counts peak-to-peak noise,
  railed samples, or an implausible rest mean rejects that key. Travel phase: press each key fully
  and release it. Every key needs at least 600 ADC counts of range; calibration does not finish with
  a smaller excursion.
- `CAL STATUS` → `type:"cal"` with the same fields.
- `CAL FINISH` → `applied:true, persisted:false, dirty:true, calibration{state:"valid"}, output{...}`, or error
  `calibration_incomplete` with `missing:[keys]` and `phase` while a run is not complete, or error
  `not_allowed` with `phase` when no run is active. Save with `SAVE`.
- `CAL CANCEL` → `phase:"cancelled", output{...}`; the previous calibration and output state are
  restored. Accepted (and harmless) when no run is active.
- `REVERT` is `busy` during guided calibration. When it restores different calibration data, the
  live sensing engine is reset to that saved data and keys already off rest are suppressed until
  release; it does not enable output that the user had disabled.
- `SAVE` additionally reports `slot` (`slot_a|slot_b`, the same names as `INFO.settings.source`) and `seq`; `INFO.settings.source` becomes `slot_a|slot_b|legacy_v1|defaults`.
