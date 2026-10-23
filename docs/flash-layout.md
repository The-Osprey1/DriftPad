# Flash layout and settings persistence

This page describes where DriftPad keeps its settings in flash, how that space is reserved, how
settings are saved and chosen at power-up, and what has and has not been verified.

## Layout (Raspberry Pi Pico, 2 MB flash)

| Region | XIP address range | Size | Defined by |
|---|---|---|---|
| Firmware (code + read-only data) | `0x10000000` up to `0x101FCFFF` at most | 2,084,864 B | linker `FLASH` region, `LENGTH` reduced by the builder |
| Settings slot A | `0x101FD000`–`0x101FDFFF` | 4 KB (one erase sector) | `_FS_start` |
| Settings slot B | `0x101FE000`–`0x101FEFFF` | 4 KB (one erase sector) | `_FS_start + 4096` |
| Legacy v1 EEPROM sector | `0x101FF000`–`0x101FFFFF` | 4 KB (the last sector) | `_EEPROM_start` |

The current firmware image ends near `0x1001DA00` (about 121 KB), far below the settings sectors.

### How the space is reserved

`firmware/platformio.ini` sets `board_build.filesystem_size = 8k`. The platform builder
(`platform-raspberrypi/builder/main.py`, `fetch_fs_size`) then:

1. subtracts 4 KB (EEPROM emulation sector) and 8 KB (filesystem) from the 2 MB flash and passes the
   result to the linker as the length of the `FLASH` memory region, so the link fails if code or
   data would grow into the reserved sectors;
2. defines `_FS_start`, `_FS_end` and `_EEPROM_start` in the processed linker script
   (`memmap_default.ld`).

LittleFS is never mounted on the filesystem region; the firmware uses its two sectors directly as
settings slots A and B. No source file contains a flash address: `firmware/src/flash_io_device.cpp`
takes every address from those linker symbols and refuses to work (`FlashIo::available()` is false)
unless `_FS_end - _FS_start` is exactly two sectors.

### What verifies this

`tests/test_flash_layout.py` runs against the firmware built in the same test run and checks, from
the ELF symbol table, the processed linker script and the UF2 file:

- slot A starts on a 4 KB boundary and the two slots are exactly two whole sectors, so each can be
  erased on its own without touching the other;
- the linker `FLASH` region ends exactly at slot A;
- the legacy sector directly follows the slots and is the last sector of the 2 MB flash;
- no loadable ELF segment and no UF2 block reaches any of the three sectors (a firmware update
  written as UF2 cannot overwrite the settings);
- no firmware source hardcodes a flash address.

## Record format and saving

Each slot holds at most one record: a 32-byte header (magic `DPS2`, header version, schema version,
sequence number, payload length, payload CRC-32, header CRC-32), the payload, and a separate commit
page (`DPOK` + sequence) programmed last. The exact byte layout and the schema-2 payload are in
`firmware/include/settings_store.h`.

`SAVE` (and the encoder's delayed save):

1. inspects both slots and picks the target: the slot that does **not** hold the newest valid record
   (a record written by newer firmware is protected, see below);
2. erases the target sector and checks it reads back erased;
3. programs the header and payload pages and reads them back;
4. programs the commit page, then reads back and compares the whole sector;
5. reports `persisted:true` only after the whole-sector comparison matched. On any failure the reply
   is `flash_error` or `flash_verify_failed`, the settings stay `dirty`, and a partly committed
   record is invalidated by zeroing its commit page.

The sequence number increases by one per save, so the slots alternate A, B, A, B, and so on.

## Choosing the settings at power-up

1. Both slots are inspected. A record counts only if its magic, header CRC, payload length, payload
   CRC and commit word are all valid, its schema is one this firmware can read, and the decoded
   settings pass semantic validation (limits, layer index, assignable key codes, normalised labels).
   Stored calibration is re-checked against the current plausibility rules; implausible calibration
   loads as `invalid` instead of discarding the whole record.
2. The valid record with the higher sequence number wins.
3. If neither slot holds one, the legacy v1 EEPROM image is migrated (below).
4. Otherwise factory defaults are used.

`INFO` reports the result: `settings.source` is `slot_a`, `slot_b`, `legacy_v1` or `defaults` (after a save, the slot just written), and
`settings.load_errors` lists what was found wrong (`slot_a_corrupt`, `slot_b_invalid`,
`slot_a_newer_schema`, `legacy_invalid`, `legacy_repaired`, ...).

## Interrupted saves

Because a save only ever erases and writes the slot that does not hold the current record, the
current record is untouched whatever happens during the save:

| Power fails during | Target slot afterwards | Loaded at next power-up |
|---|---|---|
| the erase | partly erased: framing check fails | the previous record |
| header/payload programming | no commit word | the previous record |
| commit page programming | commit word incomplete | the previous record |
| after the commit page | complete new record, higher sequence | the new record |

This is exercised by software fault injection in `tests/test_persistence_device.py`: the power is cut
after every single programmed byte of a save (and at several points of an erase), the firmware is
restarted, and the loaded settings must be exactly the old or exactly the new ones.

**Not verified:** what a real flash chip leaves behind when its supply collapses mid-operation.
The fault model assumes an interrupted erase leaves a mix of erased and old bytes and an interrupted
program leaves only the bytes already programmed. Physical power-cut testing is part of the hardware
acceptance procedure and has not been done.

## Records from newer firmware

If a slot holds a valid record whose schema or header version is newer than this firmware
understands and whose sequence is higher than every record it can read, it is reported
(`slot_x_newer_schema`) and not loaded. The next save goes to the other slot so the newer record
survives; a second save then overwrites it. Downgrading and saving twice therefore discards the
newer firmware's settings.

## Migration from firmware v1

Firmware v1 (up to commit `2734044`) kept one image in the EEPROM emulation sector
(`firmware/include/legacy_settings_v1.h`). When neither slot holds a record, that image is read
(never written) and migrated:

- actuation and Rapid Trigger sensitivity are converted to 0.01 mm and clamped to today's limits
  (v1 accepted actuation down to 0.10 mm; it becomes 0.25 mm);
- key codes that produce no keyboard output and labels that break today's label rule are replaced by
  the factory entry for that key;
- calibration becomes `missing` (v1 stored no polarity or range), and standalone boot output is off;
- anything clamped or replaced is reported as `legacy_repaired`; a corrupt image as `legacy_invalid`.

Migrated settings are marked dirty and are not written until the user saves. Because the legacy
sector is never written, downgrading to v1 firmware finds the settings as they were before the
upgrade.

Saved schema-2 calibration records remain loadable, but calibration with a per-key range below the
current 600-count minimum is now reported as `calibration_invalid` and keyboard output stays off.
The other settings remain available; run and save guided calibration to restore the full travel
range. See [calibration.md](calibration.md).

## Save timing

A save erases one 4 KB sector and programs three 256-byte pages, with interrupts off and core 1
parked for each operation, so key scanning and USB servicing pause meanwhile. Typical W25Q16JV
datasheet figures (sector erase 45 ms typ / 400 ms max, page program 0.7 ms typ / 3 ms max) put a
save at about 47 ms typical and about 410 ms worst case. These are datasheet numbers, not
measurements; the firmware records the actual duration in `TIMING` (`save` operation) and the scan
gap it caused. Keys held during a save stay held on the host; changes during the pause are seen at
the next scan.
