// Host fake of flash_io.h: NOR flash with fault injection. See fake_flash.h for the model.
#include "fake_flash.h"
#include "flash_io.h"
#include <cstring>

namespace {

constexpr uint32_t ERASE_US        = 45000;   // W25Q16JV sector erase, typical
constexpr uint32_t PAGE_PROGRAM_US = 700;     // W25Q16JV page program, typical

uint8_t  g_sectors[FlashIo::SECTOR_COUNT][FlashIo::SECTOR_SIZE];
uint8_t  g_legacy[FlashIo::LEGACY_SIZE];
bool     g_available     = true;
bool     g_legacyPresent = true;
bool     g_powered       = true;

int64_t  g_cutAfterBytes = -1;   // programmed bytes left before the power cut, -1 = disarmed
int32_t  g_eraseCutK     = -1;
int32_t  g_failProgramNth = -1, g_failProgramBytes = 0;
int32_t  g_failEraseNth   = -1, g_failEraseK = 0;
int      g_readFlipSector = -1, g_readFlipOffset = 0;
uint8_t  g_readFlipMask   = 0;

uint32_t g_eraseCount[FlashIo::SECTOR_COUNT];
uint32_t g_programCalls = 0;
uint32_t g_programBytes = 0;
uint32_t g_badProgramCalls = 0;
uint32_t g_clockUs = 0;

bool rangeOk(uint8_t sector, uint32_t offset, uint32_t len) {
    return sector < FlashIo::SECTOR_COUNT && offset <= FlashIo::SECTOR_SIZE &&
           len <= FlashIo::SECTOR_SIZE - offset;
}

void disarmFaults() {
    g_cutAfterBytes = -1;
    g_eraseCutK = -1;
    g_failProgramNth = -1;
    g_failEraseNth = -1;
    g_readFlipSector = -1;
    g_readFlipMask = 0;
}

} // namespace

namespace FlashIo {

bool available() {
    return g_available;
}

bool read(uint8_t sector, uint32_t offset, uint8_t* buf, uint32_t len) {
    if (!g_available || !rangeOk(sector, offset, len)) return false;
    memcpy(buf, &g_sectors[sector][offset], len);
    if (g_readFlipMask != 0 && g_readFlipSector == sector &&
        (uint32_t)g_readFlipOffset >= offset && (uint32_t)g_readFlipOffset < offset + len) {
        buf[g_readFlipOffset - offset] ^= g_readFlipMask;
    }
    return true;
}

bool eraseSector(uint8_t sector) {
    if (!g_available || sector >= SECTOR_COUNT) return false;
    if (!g_powered) return false;
    g_clockUs += ERASE_US;
    ++g_eraseCount[sector];

    if (g_eraseCutK >= 0) {
        uint32_t k = (uint32_t)g_eraseCutK > SECTOR_SIZE ? SECTOR_SIZE : (uint32_t)g_eraseCutK;
        memset(g_sectors[sector], 0xFF, k);
        g_eraseCutK = -1;
        g_powered = false;
        return false;
    }
    if (g_failEraseNth > 0 && --g_failEraseNth == 0) {
        g_failEraseNth = -1;
        uint32_t k = g_failEraseK < 0 ? 0 : ((uint32_t)g_failEraseK > SECTOR_SIZE ? SECTOR_SIZE : (uint32_t)g_failEraseK);
        memset(g_sectors[sector], 0xFF, k);
        return false;
    }
    memset(g_sectors[sector], 0xFF, SECTOR_SIZE);
    return true;
}

bool program(uint8_t sector, uint32_t offset, const uint8_t* data, uint32_t len) {
    if (!g_available || !rangeOk(sector, offset, len) || len == 0 ||
        (offset % PAGE_SIZE) != 0 || (len % PAGE_SIZE) != 0) {
        ++g_badProgramCalls;
        return false;
    }
    if (!g_powered) return false;
    ++g_programCalls;
    g_clockUs += PAGE_PROGRAM_US * (len / PAGE_SIZE);

    uint32_t limit = len;
    bool fail = false;
    if (g_failProgramNth > 0 && --g_failProgramNth == 0) {
        g_failProgramNth = -1;
        limit = g_failProgramBytes < 0 ? 0 : ((uint32_t)g_failProgramBytes > len ? len : (uint32_t)g_failProgramBytes);
        fail = true;
    }
    for (uint32_t i = 0; i < limit; ++i) {
        if (g_cutAfterBytes == 0) {
            g_cutAfterBytes = -1;
            g_powered = false;
            return false;
        }
        g_sectors[sector][offset + i] &= data[i];   // NOR: programming only clears bits
        ++g_programBytes;
        if (g_cutAfterBytes > 0) --g_cutAfterBytes;
    }
    // Budget used up exactly at the end of this call: the cut hits the next operation
    return !fail;
}

const uint8_t* legacyEepromPtr() {
    return g_legacyPresent ? g_legacy : nullptr;
}

uint32_t nowUs() {
    return g_clockUs;
}

} // namespace FlashIo

FF_API void ff_reset() {
    memset(g_sectors, 0xFF, sizeof(g_sectors));
    memset(g_legacy, 0xFF, sizeof(g_legacy));
    g_available = true;
    g_legacyPresent = true;
    g_powered = true;
    disarmFaults();
    memset(g_eraseCount, 0, sizeof(g_eraseCount));
    g_programCalls = 0;
    g_programBytes = 0;
    g_badProgramCalls = 0;
    g_clockUs = 0;
}

FF_API void ff_power_on() {
    g_powered = true;
    disarmFaults();
}

FF_API int ff_powered() { return g_powered ? 1 : 0; }
FF_API uint8_t* ff_sector(int sector) { return (sector >= 0 && sector < FlashIo::SECTOR_COUNT) ? g_sectors[sector] : nullptr; }
FF_API uint8_t* ff_legacy() { return g_legacy; }
FF_API void ff_set_available(int available) { g_available = available != 0; }
FF_API void ff_set_legacy_present(int present) { g_legacyPresent = present != 0; }

FF_API void ff_cut_after_program_bytes(int32_t n) { g_cutAfterBytes = n; }
FF_API void ff_cut_during_next_erase(int32_t k) { g_eraseCutK = k; }
FF_API void ff_fail_program(int32_t nth, int32_t bytes) { g_failProgramNth = nth; g_failProgramBytes = bytes; }
FF_API void ff_fail_erase(int32_t nth, int32_t k) { g_failEraseNth = nth; g_failEraseK = k; }

FF_API void ff_read_flip(int sector, int offset, int mask) {
    g_readFlipSector = sector;
    g_readFlipOffset = offset;
    g_readFlipMask = (uint8_t)mask;
}

FF_API void ff_flip_bits(int sector, int offset, int mask) {
    if (sector < 0 || sector >= FlashIo::SECTOR_COUNT || offset < 0 || offset >= (int)FlashIo::SECTOR_SIZE) return;
    g_sectors[sector][offset] ^= (uint8_t)mask;
}

FF_API uint32_t ff_erase_count(int sector) { return (sector >= 0 && sector < FlashIo::SECTOR_COUNT) ? g_eraseCount[sector] : 0; }
FF_API uint32_t ff_program_calls() { return g_programCalls; }
FF_API uint32_t ff_program_bytes() { return g_programBytes; }
FF_API uint32_t ff_bad_program_calls() { return g_badProgramCalls; }
FF_API uint32_t ff_clock_us() { return g_clockUs; }
FF_API void ff_set_clock_us(uint32_t us) { g_clockUs = us; }

namespace {
// A factory-fresh device: every flash byte reads 0xFF before any test touches it
struct ErasedAtLoad {
    ErasedAtLoad() { ff_reset(); }
} s_erasedAtLoad;
}
