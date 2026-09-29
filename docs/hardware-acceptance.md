# Hardware acceptance

Everything in this repository's automated test suite runs without a DriftPad: production C++ on the
host with fake sensors, flash, USB and display, the configurator in headless Chrome against a fake
device, and tooling against fake ports. What those tests cannot establish is listed here. A build
goes to external beta only after every required item below passed **on real hardware, with that
exact build**, and the record is signed off.

## How to run it

1. Qualify the build: `python tools/qualify_release.py` (clean checkout). It prints the bundle
   directory `dist/driftpad-<version>-<build>/`.
2. Create the record for that build:
   `python tools/acceptance_record.py new --manifest dist/driftpad-<...>/build_manifest.json --tester "<name>" --out acceptance.json`
3. Work through the items in order. After each one:
   `python tools/acceptance_record.py set acceptance.json HW-07 pass --note "key 5 held, 0 events until release"`
   (`fail` with a note when it fails; `n/a` only for items marked *optional*). Attach captures
   (timing JSON files, photos, measurements) next to the record and name them in the note.
4. `python tools/acceptance_record.py check acceptance.json --manifest <bundle>/build_manifest.json`
   lists what is still open. When everything required has passed:
   `python tools/acceptance_record.py sign acceptance.json --by "<name>"`.
5. `python tools/qualify_release.py --acceptance acceptance.json` marks the bundle ready for external
   beta (it re-runs every automated check; nothing is published).

A failed item is a finding, not a formality: open an issue with the note and the captures, fix it,
and start a new record for the new build. Records are never edited to pass.

## Equipment

* The pad under test, fully assembled, with the display fitted, and a second assembled pad (backup
  restore, multi-board items).
* A PC with Chrome or Edge (Windows 10/11). macOS and Linux hosts are optional items.
* The release bundle and Python 3.9+ with `pyserial` (`pip install -r tools/requirements.txt`).
* A key event viewer: `tools/key_tester.html` (offline; shows every keydown/keyup with timestamps,
  counts repeats and flags keys still held).
* A USB hub with per-port power switches, or a USB power-cut switch, for the power-loss items.
* A depth reference for the actuation items: feeler gauges or a caliper with a depth rod.

## Items

Pass criteria are exact. "Events" means keydown/keyup lines in `tools/key_tester.html`.

### Update and identity

| ID | Check | Procedure | Pass criterion |
|---|---|---|---|
| HW-01 | Update with the release tool | `python tools/flash.py --uf2 <bundle>/firmware.uf2` on a pad running any earlier firmware. | Ends with "Updated and verified" naming the bundle's fw version and build id. |
| HW-02 | USB identity | Device Manager (or `lsusb`) with the pad connected. | One composite device 2E8A:000B with a CDC serial port and a keyboard; no unknown devices. |
| HW-03 | Bootloader from the configurator | Device tab, "Restart into the bootloader", then `flash.py --drive <RPI-RP2 drive>`. | The RPI-RP2 drive appears within 5 s; flashing it ends "Updated and verified". |

### Sensors and calibration

| ID | Check | Procedure | Pass criterion |
|---|---|---|---|
| HW-04 | Uncalibrated pad stays silent | `RESET ALL`, `SAVE`, unplug, plug in. Press every key fully. | INFO shows calibration `missing`, output reason `calibration_missing`; 0 events. |
| HW-05 | Guided calibration | Configurator, Device, Calibration: start with hands off, press each key to the bottom once, Finish, Save. Unplug and plug in. | All 16 keys marked done; INFO calibration `valid`, `keys_valid` 16, `faults` empty, after the power cycle too. |
| HW-06 | Rest noise | Device tab, Raw sensor samples, "Capture 1 second" for every key, hands off. | Peak-to-peak ≤ 40 counts for every key (the rest tolerance floor, `calib::TOLERANCE_MIN_COUNTS`); record all 16 values. |
| HW-07 | Key held at power-up | Hold key 5 fully down while plugging in; keep it down 5 s, release, press again. | 0 events while held; INFO `held_at_boot` lists 5; the press after release gives one keydown/keyup pair. Other keys work throughout. |
| HW-08 | Warm drift | Leave the pad plugged in 30 min typing occasionally, then unplug and plug in. | 0 events at rest during the 30 min and after re-plugging; INFO `faults` empty (a key in `drift` is acceptable, record it). |
| HW-09 | Sensor fault is contained | *optional* (needs a rework-able board): lift one sensor's output so the mux reads a rail, power up. | That key in INFO `faults`, 0 events from it; the other 15 keys work. |

### Actuation, Rapid Trigger and output

| ID | Check | Procedure | Pass criterion |
|---|---|---|---|
| HW-10 | Actuation depth | For actuation 1.00, 2.00 and 3.00 mm: press key 6 slowly against the depth reference and note the depth of the first keydown (3 readings each). | Depths increase with the setting; each reading within ±0.40 mm of the setting (travel is a linear estimate over the switch's nominal 4 mm; record the readings either way). |
| HW-11 | Rapid Trigger reversal | RT on, 0.20 mm. Hold a key at mid travel, lift about 0.5 mm, press again about 0.5 mm, 10 times. | 10 keyup and 10 keydown events, alternating, with no extra events. |
| HW-12 | No chatter at the RT floor | RT 0.10 mm. Rest a finger on a key at mid travel for 10 s, then at the bottom for 10 s. | At most one keydown and no keyup while resting in each position. |
| HW-13 | Rollover limit | Press 7 keys that send letters, one at a time, and hold them; release all. | 6 keydown events; the 7th key produces none; STATUS `output.overflow` increased; after release no key is held (`key_tester.html` shows none). |
| HW-14 | Modifiers | Layer 2: hold SHFT, press A; hold CTRL, press S. | "A" typed with Shift; Ctrl+S reaches the host (the editor's save dialog); no stuck modifiers afterwards. |
| HW-15 | Remap while held | Hold key 1 (7), change key 1 to "B" in the configurator and Write, release. | keydown 7 then keyup 7; no "B" events; nothing held afterwards. |
| HW-16 | Layer change while held | Hold a key, change layer with the knob, release. | The held key's keyup matches its keydown; nothing held afterwards. |
| HW-17 | Host sleep and wake | Hold a key, put the PC to sleep, wake it after 10 s, release the key. | No key held on the host after release; STATUS `output.delivery` back to `confirmed` within 1 s of wake. |
| HW-18 | Unplug while held | Hold two keys, unplug, plug in while still holding them, release. | No events for those keys until they are released and pressed again (held at power-up rule). |

### Settings and power loss

| ID | Check | Procedure | Pass criterion |
|---|---|---|---|
| HW-19 | Settings survive power cycles | Change actuation, a key, the layer; Save; unplug/plug in 10 times. | Every time: the changed values, INFO settings `source` `slot_a` or `slot_b`, `load_errors` empty. |
| HW-20 | Power cut during save | `python tools/save_stress.py` (alternates actuation 1.50/2.50 mm and saves, logging each confirmed save) while cutting USB power at random points, 20 cuts. After each: power on, INFO, GET_CONFIG. | Every time the pad starts with either the previous or the new settings (never defaults while a save existed before), calibration unchanged, and `SAVE` works again. Record `load_errors` seen. |
| HW-21 | Migration from protocol-1 firmware | *optional* (needs a pad running firmware e2031e2 with saved settings): note its keymap and actuation, update with `flash.py`. | After the update INFO `source` `legacy_v1` and the same keymap and actuation; after `SAVE`, `slot_a`. |
| HW-22 | Encoder edits are saved, not during typing | Turn the knob one step on the actuation page while typing continuously for 10 s with the other hand; then stop typing. | INFO `settings.seq` does not change while typing; it increases once 1 to 2 s after typing stops (knob idle ≥ 3 s). |

### Display and timing

| ID | Check | Procedure | Pass criterion |
|---|---|---|---|
| HW-23 | Display follows the keys | Watch the OLED while typing and while holding keys; press a key briefly (tap). | Pressed keys shown within one frame (no visible lag); taps visible; layer and settings pages match the configurator. |
| HW-24 | Idle, screensaver, sleep, wake | Close the configurator (every serial command counts as activity), leave the pad untouched 60 s; then send `SLEEP` (serial terminal or `tools/save_stress.py --command SLEEP`) and press a key. | Screensaver starts at 45 s; `SLEEP` turns the display off; the key press wakes it and types normally. |
| HW-25 | Scan timing, idle | `python tools/timing_capture.py --label "idle, display on" --seconds 60` (it reads TIMING once, at the end: every poll costs the scan loop about 1.2 ms and would count as a gap) | PASS (max gap ≤ 2000 µs, no gap above 2 ms). |
| HW-26 | Scan timing, typing with the configurator open | Configurator on the Keys page (telemetry streaming) while typing: `timing_capture.py --label "typing, configurator open" --seconds 120` | PASS. |
| HW-27 | Scan timing, display commands | During a 60 s capture send `OLED_SCAN` and `OLED_TEST` 10 times each (Device tab or a script). | PASS: the display work on core 1 never shows as a scan gap. `OLED_SCAN` lists 60 (0x3C, the display). |
| HW-28 | Save pause | During a 60 s capture with `--allow-save-gaps`, `SAVE` 10 times. | PASS; record `save_max_us` (the scan pause a save causes). |

### Configurator

| ID | Check | Procedure | Pass criterion |
|---|---|---|---|
| HW-29 | Configurator end to end | Chrome on Windows, from the bundle's `configurator/index.html` (file) and over a local server: connect, remap and write a key, change sensitivity, Save, disconnect, unplug/plug in, reconnect. | Every value shown "on the pad" matches GET_CONFIG; no console errors; reconnect works without reloading the page. |
| HW-30 | Backup to a second pad | Download a backup from pad A, restore it on pad B, Save on B. | Restore reports 0 failed and 0 mismatched; B's GET_CONFIG equals A's for keymaps and settings; B's calibration unchanged. |
| HW-31 | Unplug during a write | Start writing 10 key changes and unplug mid-write. | The page shows "Connection lost" (announced), no key stuck "writing"; after reconnect the pending keys are listed and a second write completes. |
| HW-32 | Screen reader smoke test | NVDA (Windows) or VoiceOver: connect, move through keys with arrows, change a key, lose the connection. | Connection, key labels, "not written" state and the lost connection are announced. |
| HW-33 | Other hosts | *optional*: repeat HW-02, HW-13 and HW-29 on macOS and on Linux. | Same results as on Windows. |
