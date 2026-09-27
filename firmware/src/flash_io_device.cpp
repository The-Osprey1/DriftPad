// Device implementation of flash_io.h (pico SDK). Host tests use tests/firmware_host/fake_flash.cpp.
#ifndef DRIFTPAD_HOST_BUILD

#include "flash_io.h"
#include <Arduino.h>
#include <hardware/flash.h>
#include <hardware/sync.h>
#include <cstring>

// Linker symbols from memmap_default.ld (values set by board_build.filesystem_size)
extern "C" uint8_t _FS_start;
extern "C" uint8_t _FS_end;
extern "C" uint8_t _EEPROM_start;

static_assert(FlashIo::SECTOR_SIZE == FLASH_SECTOR_SIZE, "settings slot must be one erase sector");
static_assert(FlashIo::PAGE_SIZE == FLASH_PAGE_SIZE, "program unit must match the SDK page size");

namespace {

uintptr_t sectorAddress(uint8_t sector) {
    return (uintptr_t)&_FS_start + (uintptr_t)sector * FlashIo::SECTOR_SIZE;
}

bool rangeOk(uint8_t sector, uint32_t offset, uint32_t len) {
    return sector < FlashIo::SECTOR_COUNT && offset <= FlashIo::SECTOR_SIZE &&
           len <= FlashIo::SECTOR_SIZE - offset;
}

} // namespace

namespace FlashIo {

bool available() {
    return ((uintptr_t)&_FS_end - (uintptr_t)&_FS_start) == (uintptr_t)SECTOR_COUNT * SECTOR_SIZE;
}

bool read(uint8_t sector, uint32_t offset, uint8_t* buf, uint32_t len) {
    if (!available() || !rangeOk(sector, offset, len)) return false;
    // XIP mapped; the SDK flushes the XIP cache after every erase/program
    memcpy(buf, (const void*)(sectorAddress(sector) + offset), len);
    return true;
}

bool eraseSector(uint8_t sector) {
    if (!available() || sector >= SECTOR_COUNT) return false;
    const uint32_t flashOffset = (uint32_t)(sectorAddress(sector) - XIP_BASE);

    // Same sequence as the EEPROM library: nothing may execute from flash while it is erased
#ifndef __FREERTOS
    noInterrupts();
#endif
    rp2040.idleOtherCore();
    flash_range_erase(flashOffset, SECTOR_SIZE);
    rp2040.resumeOtherCore();
#ifndef __FREERTOS
    interrupts();
#endif
    return true;
}

bool program(uint8_t sector, uint32_t offset, const uint8_t* data, uint32_t len) {
    if (!available() || !rangeOk(sector, offset, len)) return false;
    if ((offset % PAGE_SIZE) != 0 || (len % PAGE_SIZE) != 0 || len == 0) return false;
    const uint32_t flashOffset = (uint32_t)(sectorAddress(sector) - XIP_BASE) + offset;

#ifndef __FREERTOS
    noInterrupts();
#endif
    rp2040.idleOtherCore();
    flash_range_program(flashOffset, data, len);
    rp2040.resumeOtherCore();
#ifndef __FREERTOS
    interrupts();
#endif
    return true;
}

const uint8_t* legacyEepromPtr() {
    return &_EEPROM_start;
}

uint32_t nowUs() {
    return (uint32_t)micros();
}

} // namespace FlashIo

#endif // DRIFTPAD_HOST_BUILD
