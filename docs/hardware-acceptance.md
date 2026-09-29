# Hardware acceptance

Everything in this repository's automated test suite runs without a DriftPad: production C++ on the
host with fake sensors, flash, USB and display, the configurator in headless Chrome against a fake
device, and tooling against fake ports. Some checks have useful software coverage; none of those
results counts as a hardware pass. A build goes to external beta only after every required item
below passed **on real hardware, with that exact build**, and the record is signed off.

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

## Before the event checks

1. Run the software qualification and save its build identity and bundle. Start an acceptance record
   against that bundle's `build_manifest.json`; never reuse a record for a different build.
2. Complete HW-01 through HW-05 first. Guided calibration must complete for all 16 keys and survive
   a power cycle. Each saved sensor range must be at least 600 ADC counts; firmware reports a lower
   range as invalid rather than claiming the full 4 mm travel scale. If calibration reports a
   failed/noisy rest phase, fix the noise or motion and restart the calibration before proceeding.
3. With the pad connected, open Device → **Turn keyboard output on** and confirm `INFO.output.enabled`
   is true. This is a runtime setting and is not saved. It is required for the keyboard-event checks
   below; tests that explicitly require silence turn it back off. The **Force** button is for bench
   testing only and is not a substitute for a valid calibration.
4. For HW-13 and HW-14, configure and verify the actual labels/codes first: seven unique printable
   keys for rollover, and `SHFT`, `A`, `CTRL`, and `S` on layer 2 for the modifier sequence. Record any
   mapping you changed so the check can be repeated consistently.

`RESET ALL` removes calibration and turns output off. Recalibrate before continuing after that
command. `SET_HID 1` is runtime only; enable it again after each reboot unless standalone boot
output is deliberately enabled as a separately saved setting.

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
| HW-24 | Idle, screensaver, sleep, wake | Leave the pad untouched 60 s (the configurator may stay open: read-only queries do not count as activity); then send `SLEEP` (serial terminal or `tools/save_stress.py --command SLEEP`) and press a key. | The screensaver starts at 45 s and dims 3 minutes into it (leave it that long to see it); any input returns the panel to full brightness; `SLEEP` turns the display off; the key press wakes it and types normally. |
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

## Software coverage audit

This table records what automated code can check, not which hardware rows are complete. **Every
required row still needs its physical procedure and an acceptance record for the release build.**
The repo currently has no signed hardware acceptance record, PCB fabrication files, BOM or enclosure
files.

| Check | Existing software evidence | What still requires physical hardware |
|---|---|---|
| Check HW-01 | `test_flash_tool.py`, `firmware_image.py`: image safety, fake update, identity/readback rules. | Real board update and its reported build identity. |
| Check HW-02 | Firmware build and identity output are checked in host tests. | USB enumeration and one CDC plus HID device on the target PC. |
| Check HW-03 | Fake flash-tool tests cover the BOOTSEL/update control path. | Real reset into BOOTSEL, drive appearance and update. |
| Check HW-04 | `test_protocol_device.py`, `test_keyboard_output.py`: missing-calibration gate and silent output. | RESET/save/power cycle, all 16 physical keys and zero host events. |
| Check HW-05 | `test_persistence_device.py`, `test_configurator_js.py`: guided phases, completion and settings persistence against fakes. | Calibration of the assembled sensors, all keys and power-cycle readback. |
| Check HW-06 | DSP/calibration tests exercise synthetic noise and thresholds. | One-second raw measurements from all 16 sensors. |
| Check HW-07 | `test_keyboard_output.py`: boot-held suppression and release recovery in the host harness. | Plugging in with an actual key held and checking host events. |
| Check HW-08 | DSP tests cover modeled drift. | Half-hour thermal drift, real typing and unplug/replug. |
| Check HW-09 | Host tests exercise guarded fault handling. | A reworkable board, a physically faulted sensor and the remaining 15 keys. |
| Check HW-10 | Host tests verify calibration-to-travel/actuation calculations. | Measured depths with a real key and the specified tolerance. |
| Check HW-11 | `test_firmware_parity.py` exercises the real sensing C++ on generated input. | 20 real reversals and exact keyboard-event ordering. |
| Check HW-12 | DSP and parity tests cover modeled RT-floor noise/chatter. | Finger-rest behavior at two physical depths. |
| Check HW-13 | `test_keyboard_output.py` checks 6-key rollover and cleanup in the harness. | Seven real simultaneous USB key presses, overflow status and host cleanup. |
| Check HW-14 | Host tests check HID key/modifier codes and ownership. | Shift/A and Ctrl/S behavior on the target host, including modifier cleanup. |
| Check HW-15 | `test_keyboard_output.py` covers held-key remap and release ownership. | Write a remap through WebSerial while the real key is held. |
| Check HW-16 | `test_keyboard_output.py` covers layer changes while a key is held. | Change the physical pad's layer while a key is down. |
| Check HW-17 | Host tests simulate link loss and reconciliation. | PC sleep/wake, real USB delivery recovery and host key state. |
| Check HW-18 | Host tests check connection loss and held-key cleanup. | Unplug/replug a physically held switch. |
| Check HW-19 | `test_persistence_device.py` checks A/B save, recovery and readback using fake flash. | Ten real power cycles with calibration and settings readback each time. |
| Check HW-20 | Host persistence tests simulate interrupted writes and sector recovery. | Twenty random USB power cuts during actual flash saves. |
| Check HW-21 | Persistence tests exercise the legacy v1 data migration. | Updating an actual pad running legacy firmware and checking its saved configuration. |
| Check HW-22 | `test_display_scheduling.py` checks deferred encoder-save timing and sequencing. | Encoder use while typing and the real on-device save time. |
| Check HW-23 | `test_oled_frames.py` renders firmware drawing code and checks layout. | Visible lag, brief taps, layer state and settings on the fitted panel. |
| Check HW-24 | Host frame/state tests cover screensaver and sleep logic. | Real 45-second idle, dimming, wake input and key output. |
| Check HW-25 | `test_timing.py` checks counter calculations. | Maximum scan gap for 60 seconds on the RP2040. |
| Check HW-26 | Compiled firmware tests exercise scan/telemetry paths. | 120-second capture with real typing and configurator telemetry. |
| Check HW-27 | `test_display_scheduling.py` checks core ownership and deferred replies. | I2C scan and OLED test-pattern behavior during real device timing capture. |
| Check HW-28 | Host tests exercise save handling and scan scheduling. | Flash-write scan pause on the powered board. |
| Check HW-29 | `test_configurator_js.py` and `test_configurator_contract.py` run pages against a fake device and compare protocol replies. | Chrome or Edge WebSerial with the physical pad, unplug and reconnect. |
| Check HW-30 | Browser and protocol tests check backup/restore against a fake device. | Backup from one real pad, restore/readback on a second pad and calibration isolation. |
| Check HW-31 | Browser tests simulate disconnect and pending writes. | Unplugging the pad while its WebSerial write is in flight. |
| Check HW-32 | Source and browser checks cover labels and announcements. | A real NVDA or VoiceOver keyboard-navigation smoke test. |
| Check HW-33 | No other-host automated acceptance run is configured. | Repeat the listed smoke tests on actual macOS and Linux hosts. |
