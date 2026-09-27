# Serial protocol v2 — working reference (implementation in progress)

This is the working reference used while protocol v2 is implemented. The final, user-facing
reference replaces `docs/serial-protocol.md` when the work is complete. Sections marked
**(implemented)** exist in the firmware now and are tested end to end in
`tests/test_protocol_device.py`; sections marked **(next)** are being added with the persistence and
calibration change and must be feature-detected through `INFO.features`.

## Framing (implemented)

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
- Errors: `{"status":"error","id":..,"cmd":..,"code":"<code>","msg":"..."}`, codes:
  `unknown_command bad_request bad_arguments bad_number out_of_range invalid_label invalid_code busy
  not_allowed calibration_required calibration_incomplete keys_not_at_rest line_too_long flash_error
  flash_verify_failed display_timeout unsupported`.
- Mutating commands reply with the effective value read back from the device and
  `"applied":true, "persisted":<in flash now>, "dirty":<RAM differs from flash>`. Nothing is written
  to flash except by `SAVE` (and the encoder's delayed save).

## Commands (implemented)

| Command | Reply fields (besides status/cmd/id) |
|---|---|
| `PING` | `type:"pong"` |
| `INFO` (alias `HELLO`) | `type:"info", device:"DriftPad", hw, fw, protocol:2, build, build_date, features[], limits{actuation{min,max,default,step}, rt_sens{...}, layers, keys, label_max, label_chars, code_max, line_max, stream_hz_max}, calibration{state}, output{enabled, reason, active_keys[], suppressed_keys[], overflow, delivery}, settings{dirty, source, seq, load_errors[]}, uptime_ms` |
| `GET_CONFIG` | `type:"config", actuation, rt_sens, rt_enabled, active_layer, boot_output, dirty, settings_seq, layers[3][16]{idx, code, label}` |
| `STATUS` | `type:"status", active_layer, last_key, keys[16]{idx, pressed, travel, label}, output{...}, calibration{state}, sim_mask, dirty` |
| `STREAM <0|1> [hz]` | `streaming, hz`; then `{"type":"telemetry","seq","t","layer","pressed"(bitmask),"active"(bitmask),"sim"(bitmask),"travel"[16 × cmm ints],"dirty"}` at `hz` (default 30, max 60). Streaming stops when the host closes the port. |
| `SET_ACTUATION <mm>` | `actuation` + applied/persisted/dirty |
| `SET_RT_SENS <mm>` | `rt_sens` + applied/persisted/dirty |
| `SET_RT_ENABLE <bool>` | `rt_enabled` + applied/persisted/dirty |
| `SET_LAYER <0-2>` | `active_layer` + applied/persisted/dirty |
| `SET_KEY <layer> <key> <code> [label]` | `layer, key, code, label` (normalised) + applied/persisted/dirty |
| `SET_HID <bool> [FORCE]` (aliases `HID`, `OUTPUT`) | `hid_output, output{...}` (runtime only, never saved) |
| `SAVE` | `persisted:true, dirty:false, duration_ms`, or error `flash_error`/`flash_verify_failed` with `persisted:false` |
| `REVERT` | `applied, persisted, dirty` — reloads the saved settings; `not_allowed` when nothing is saved |
| `RESET` | `applied:true, persisted:false, dirty:true` — factory keymaps and settings, not saved |
| `CALIBRATE` | quick re-zero of every key's rest reading; `applied, persisted, dirty, calibration` (state name), or `keys_not_at_rest` with `keys:[...]` |
| `SIM <key> <mm>` / `SIM <key> OFF` / `SIM OFF` | `type:"sim_event", key, travel, pressed, sim_mask` — simulated keys never produce keyboard output |
| `SCAN_RATE` | `type:"scan_rate", hz, max_gap_us` |
| `TIMING [RESET]` | `type:"timing", ...` |
| `RAW <key>` | `key, samples:1000, rate_hz`; then `{"type":"raw","key","rate_hz","offset","total","samples"[<=100]}` events |
| `FULLSCREEN [bool]`, `SCREENSAVER`, `ANIM [0-5]`, `SLEEP`, `WAKE`, `OLED_TEST`, `OLED_SCAN` | display state fields, answered at once (the display core applies them within a frame). `OLED_TEST` (pattern shown for 2 s) and `OLED_SCAN` (`devices[]`, at most 8, plus `more` when others answered) reply once the display core has done it; error `display_timeout` after 1.5 s. Other commands are answered meanwhile; a second deferred command gets `busy`. |
| `BOOTSEL` | `bootsel:true`, then the device reboots into its USB bootloader |

Label rule (firmware and configurator must agree; vectors in `tests/fixtures/label_vectors.json`):
`a-z` uppercased; 1–4 characters; printable ASCII 0x21–0x7E except `"` `\` `@`; anything else is
rejected (`invalid_label`), never rewritten.

## Additions with persistence and calibration (next)

Present only when `INFO.features` contains `guided_calibration` / `boot_output` / `settings_ab`.

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
  Rest phase: keys untouched for 500 ms. Travel phase: press each key fully and release it.
- `CAL STATUS` → `type:"cal"` with the same fields.
- `CAL FINISH` → `applied:true, persisted:false, dirty:true, calibration{state:"valid"}, output{...}`, or error
  `calibration_incomplete` with `missing:[keys]` and `phase` while a run is not complete, or error
  `not_allowed` with `phase` when no run is active. Save with `SAVE`.
- `CAL CANCEL` → `phase:"cancelled", output{...}`; the previous calibration and output state are
  restored. Accepted (and harmless) when no run is active.
- `SAVE` additionally reports `slot` (`slot_a|slot_b`, the same names as `INFO.settings.source`) and `seq`; `INFO.settings.source` becomes `slot_a|slot_b|legacy_v1|defaults`.
