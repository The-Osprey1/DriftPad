// Host fake of firmware/include/flash_io.h with NOR semantics and fault injection.
//
// Model:
//  - Two 4 KB settings sectors and a 4 KB legacy EEPROM sector, all 0xFF after ff_reset().
//  - eraseSector() sets a sector to 0xFF; program() ANDs data into flash (bits only clear) and
//    requires page-aligned offsets and whole pages (a violation returns false and is counted).
//  - A simulated clock (FlashIo::nowUs) advances by typical W25Q16JV timings: 45 ms per sector
//    erase, 700 us per programmed page.
//
// Faults (all cleared by ff_reset(); power-cut state also by ff_power_on()):
//  - ff_cut_after_program_bytes(n): power fails once n more bytes have been programmed. The rest
//    of that program call and every later erase/program are lost (they return false and change
//    nothing) until ff_power_on() ("reboot").
//  - ff_cut_during_next_erase(k): the next erase stops after the first k bytes of the sector are
//    0xFF (the remainder keeps its old content), then power fails as above.
//  - ff_fail_program(nth, bytes): the nth program call from now programs only its first `bytes`
//    bytes (0 = none) and returns false. Power stays on.
//  - ff_fail_erase(nth, k): the nth erase call from now erases only the first k bytes and
//    returns false. Power stays on.
//  - ff_read_flip(sector, offset, mask): read() returns that byte XOR mask (flash itself intact),
//    i.e. a readback mismatch. mask 0 disables it.
//  - ff_flip_bits(sector, offset, mask): flips bits in the stored data (retention error).
//  - ff_set_available(0): FlashIo::available() reports no settings region.
//  - ff_set_legacy_present(0): legacyEepromPtr() returns nullptr.
#ifndef DRIFTPAD_FAKE_FLASH_H
#define DRIFTPAD_FAKE_FLASH_H

#include <cstdint>

#if defined(_WIN32)
#define FF_API extern "C" __declspec(dllexport)
#else
#define FF_API extern "C" __attribute__((visibility("default")))
#endif

FF_API void     ff_reset();
FF_API void     ff_power_on();
FF_API int      ff_powered();
FF_API uint8_t* ff_sector(int sector);          // raw storage, 4096 bytes
FF_API uint8_t* ff_legacy();                    // raw legacy sector, 4096 bytes
FF_API void     ff_set_available(int available);
FF_API void     ff_set_legacy_present(int present);

FF_API void ff_cut_after_program_bytes(int32_t n);   // -1 disarms
FF_API void ff_cut_during_next_erase(int32_t k);     // -1 disarms
FF_API void ff_fail_program(int32_t nth, int32_t bytes);
FF_API void ff_fail_erase(int32_t nth, int32_t k);
FF_API void ff_read_flip(int sector, int offset, int mask);
FF_API void ff_flip_bits(int sector, int offset, int mask);

FF_API uint32_t ff_erase_count(int sector);
FF_API uint32_t ff_program_calls();
FF_API uint32_t ff_program_bytes();
FF_API uint32_t ff_bad_program_calls();     // misaligned / out of range program() calls
FF_API uint32_t ff_clock_us();
FF_API void     ff_set_clock_us(uint32_t us);

#endif
