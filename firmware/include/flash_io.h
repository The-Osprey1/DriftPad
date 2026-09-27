#ifndef FLASH_IO_H
#define FLASH_IO_H

#include <cstdint>

/**
 * @file flash_io.h
 * @brief Raw access to the two settings sectors and the legacy EEPROM sector.
 *
 * Device: `board_build.filesystem_size = 8k` reserves _FS_start.._FS_end (two 4 KB sectors) just
 * below the legacy EEPROM sector at _EEPROM_start. Sector 0 is settings slot A, sector 1 slot B.
 * LittleFS is never mounted on them. Implemented in src/flash_io_device.cpp with the pico SDK
 * (flash_range_erase/program with interrupts off and core 1 parked, like the EEPROM library).
 *
 * Host tests link tests/firmware_host/fake_flash.cpp instead: NOR semantics plus fault injection.
 *
 * NOR rules the callers rely on: erase sets every byte of a sector to 0xFF; program can only clear
 * bits (new = old & data). Neither call checks what it wrote: SettingsStore reads back.
 *
 * Core 0 only. eraseSector()/program() stall both cores (see settings_store.h for timings).
 */
namespace FlashIo {

constexpr uint8_t  SECTOR_COUNT = 2;
constexpr uint32_t SECTOR_SIZE  = 4096;   // FLASH_SECTOR_SIZE, the erase unit
constexpr uint32_t PAGE_SIZE    = 256;    // FLASH_PAGE_SIZE, the program unit
constexpr uint32_t LEGACY_SIZE  = 4096;   // legacy v1 EEPROM sector (read only)

// True when the linker reserved exactly SECTOR_COUNT * SECTOR_SIZE bytes (_FS_end - _FS_start).
// Every other call fails when this is false.
bool available();

// Copies `len` bytes from `sector` at `offset`. False on a bad range or when unavailable.
bool read(uint8_t sector, uint32_t offset, uint8_t* buf, uint32_t len);

// Erases one sector to 0xFF. False on a bad sector number or when unavailable.
bool eraseSector(uint8_t sector);

// Programs whole pages: `offset` and `len` must be multiples of PAGE_SIZE and inside the sector.
// False on a bad range or when unavailable. On the device the pico SDK cannot report media
// errors, so a true return only means the command was issued.
bool program(uint8_t sector, uint32_t offset, const uint8_t* data, uint32_t len);

// The legacy v1 EEPROM sector (LEGACY_SIZE bytes, XIP mapped at _EEPROM_start), or nullptr if
// there is none. Never written.
const uint8_t* legacyEepromPtr();

// Microsecond clock used to time saves: micros() on the device, a simulated clock in host tests.
uint32_t nowUs();

} // namespace FlashIo

#endif // FLASH_IO_H
