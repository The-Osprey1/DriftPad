# Scheduling and core ownership

The RP2040 has two cores. DriftPad gives each one a fixed job, and the two share exactly one
channel, `firmware/include/display_link.h`.

| | Core 0 (`setup()` / `loop()`, `firmware/src/main.cpp`) | Core 1 (`setup1()` / `loop1()`, `firmware/src/oled.cpp`) |
|---|---|---|
| Owns | Sensors and key scan, keyboard output (TinyUSB), serial protocol, settings and flash, calibration, encoder and menu state | I2C (`Wire`), the display driver, the idle timers (screensaver, sleep), every frame |
| Reads from the other core | Display state flags (sleeping, screensaver) for command replies and the encoder wake rule | The display snapshot and posted requests only |
| Must never | Call `Wire` or the display, or wait for core 1 | Read `HallManager`, `HallKey`, the settings or keyboard output |

## The channel

* **Snapshot** (`display_link::Snapshot`, 204 bytes): per key travel, pressed state, edge counters
  and label, plus the last active key, the active layer and the three sensing settings. Core 0
  publishes it after every scan (`displayPublish()`, `firmware/src/display_publish.cpp`). A
  sequence lock makes publishing wait-free for core 0; core 1 copies a consistent snapshot at the
  start of each pass, and a pass whose copy keeps racing a publish draws the previous copy.
* **Requests**: wake, sleep, screensaver, test pattern and I2C bus scan. Each kind is a pair of
  counters (posted by core 0, served by core 1), so no request is lost and no read-modify-write is
  shared between the cores. Wake, sleep and screensaver are applied in posting order. `OLED_TEST`
  and `OLED_SCAN` defer their protocol reply until core 1 has served them (`display_timeout` after
  1.5 s); every other command is answered meanwhile.

Before this split, core 0 took an I2C mutex in `oledWake()` (called by every command), drew the
test pattern and ran the 126-address bus scan itself, and core 1 read the sensing engine and the
settings while core 0 wrote them. A command could therefore stall the 1 kHz scan for a whole frame
transfer (about 23 ms at 100 kHz) or a bus scan.

## Core 0 loop order

Each `loop()` pass (`firmware/src/main.cpp`):

1. **Scan** when due (fixed 1 kHz; a pass that fell a full period behind resynchronises instead
   of bursting): `HallManager::updateAll()`, keyboard routing, calibration and telemetry hooks
   (`commands::onScan()`), then `displayPublish()`.
2. `KeyboardOutput::service()`: report delivery and reconciliation.
3. Simulated keys, host connection state.
4. At most one protocol command, and only when its largest reply fits the TX queue.
5. Deferred replies, telemetry, raw capture chunks (`commands::service()`); TX drain (non-blocking).
6. Encoder: menu changes apply at once; the save is scheduled (below).

Most of the pass is non-blocking, but key-edge reports call the Arduino `Keyboard` library. When
the USB host stops polling reports, that library can wait for up to its 500 ms `HIDReady()` timeout
([`keyboard_output.h`](../firmware/include/keyboard_output.h),
[`keyboard_output_hal.h`](../firmware/include/keyboard_output_hal.h)). `KeyboardOutput::service()`
itself does not wait. OLED work does not make core 0 wait for core 1. Flash writes also stop the
scan while the RP2040 erases and programs flash, as described below.

## Flash writes

Erasing and programming a flash sector runs with interrupts off and core 1 parked
(`rp2040.idleOtherCore()`, `firmware/src/flash_io_device.cpp`), because code executes from the same
flash. For that time there is no scan, no USB service and no display update. A save writes one
settings slot (erase + program + verify, `docs/flash-layout.md`).

When saves happen:

* `SAVE` from the configurator: at once (the user asked for it).
* Encoder edits: once the knob has been still for 3 s **and** no key has changed state for 1 s.
  A key held down without changing does not delay it. Before this rule, an encoder edit could be
  saved in the middle of typing (`tests/test_display_scheduling.py` shows both).
* Never on its own otherwise: `SET_*`, calibration and `RESET` only apply.

If core 1 is parked in the middle of a frame transfer, that frame may be cut short (the `Wire`
timeout is 50 ms); the next frame redraws everything.

## Measuring it

`TIMING` (serial protocol) reports, since power-up or `TIMING RESET`:

* scan period statistics: `scans`, `scan_hz`, `max_gap_us`, `missed_deadlines`, a gap histogram
  (`le_1100` ... `gt_50000`), scan duration `scan_max_us` / `scan_avg_us`;
* per operation `_last_us`, `_max_us`, `_count` for `command`, `telemetry`, `save`,
  `calibration`, `publish` (building and publishing the snapshot), `display_request` (posting a
  display request), `tx_drain`.

On the host these fields are tested for accounting, not for real durations (the host clock only
moves between loop passes). Real numbers come from a device: see the scheduling items in
`docs/hardware-acceptance.md`.

## What is verified where

| Claim | Evidence | Scope |
|---|---|---|
| The sequence lock never yields a torn or older snapshot; requests are never lost; results are visible before their ticket | `tests/test_display_link.py` (two host threads, 300 000 publishes; a control without the lock does tear) | production C++ on the host (x86-64 memory model) |
| The snapshot is published every scan and follows keys and settings | `tests/test_display_scheduling.py` | whole firmware image on the host |
| `OLED_TEST` / `OLED_SCAN` wait for core 1 without blocking other commands; a stalled core 1 gives `display_timeout` | `tests/test_display_scheduling.py` (core 1 is a stub there) | whole firmware image on the host |
| Encoder saves wait for typing to stop | `tests/test_display_scheduling.py`, against the loop before and after | whole firmware image on the host |
| Core 1 only touches I2C; the display renders from the snapshot | source (`oled.cpp` includes no sensing or settings header) and the firmware build | build |
| Scan gaps with the display running, during frame transfers, bus scans and saves | not established in software | **hardware** |
