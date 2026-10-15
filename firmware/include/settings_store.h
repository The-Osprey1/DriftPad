#ifndef SETTINGS_STORE_H
#define SETTINGS_STORE_H

#include <cstdint>
#include "config.h"
#include "flash_io.h"

/**
 * @file settings_store.h
 * @brief A/B settings records in two flash sectors, and the settings payload codec.
 *
 * Internal to config.cpp. Slot A = FlashIo sector 0, slot B = sector 1. Each slot holds at most
 * one record; a save rewrites the slot that does not hold the newest valid record, so the
 * previous copy survives any failure or power cut during the save.
 *
 * Record layout (all integers little-endian; offsets in bytes from the start of the sector):
 *
 *     0  u32 magic           'D' 'P' 'S' '2'  (RECORD_MAGIC)
 *     4  u8  header_version  HEADER_VERSION (1)
 *     5  u8  reserved        0
 *     6  u16 schema_version  payload schema (SCHEMA_V2 = 2)
 *     8  u32 sequence        +1 per save; the higher valid sequence is the current record
 *    12  u16 payload_len
 *    14  u16 reserved        0
 *    16  u32 payload_crc     CRC-32 (zlib) of the payload
 *    20  u8[8] reserved      0
 *    28  u32 header_crc      CRC-32 (zlib) of bytes 0..27
 *    32  payload[payload_len], then 0xFF up to the next page boundary
 *     C  commit page, C = roundup(32 + payload_len, 256):
 *        u32 'D' 'P' 'O' 'K' (COMMIT_MAGIC), u32 sequence (same as the header), then 0xFF
 *     .. 0xFF to the end of the sector
 *
 * Commit word: the header and payload pages are programmed and read back first; the commit page
 * is programmed last in its own program operation. A record counts only with a matching commit
 * word, so a save cut short at any byte is never mistaken for a finished one, even where the CRC
 * alone could not tell (e.g. the header CRC also guards the sequence and schema fields so they
 * can be trusted in a record whose payload is damaged).
 *
 * Frozen across header versions: this whole framing (bytes 0..31, the CRCs, the commit page
 * rule). A newer header_version may only give meaning to reserved bytes. That lets this firmware
 * verify, date (sequence) and preserve records written by newer firmware.
 *
 * Save sequence (write()): erase -> blank check of the whole sector -> program header+payload
 * pages -> read back and compare them -> program the commit page -> read back and compare the
 * whole sector. A failure after the commit page was programmed "kills" the record by programming
 * the commit page to zero, so a save that reported an error never becomes current later.
 *
 * Timing (typical RP2040 QSPI NOR, e.g. W25Q16JV): sector erase 45 ms typ / 400 ms max, page
 * program 0.7 ms typ / 3 ms max. A settings save = 1 erase + 3 page programs + ~12 KB of XIP reads
 * (blank check, verify, slot scan): ~47 ms typical, ~410 ms worst case. Each erase/program runs
 * with core 0 interrupts off and core 1 parked (see flash_io.h); the caller schedules saves.
 */
namespace SettingsStore {

constexpr uint32_t RECORD_MAGIC   = 0x32535044;  // bytes "DPS2"
constexpr uint32_t COMMIT_MAGIC   = 0x4B4F5044;  // bytes "DPOK"
constexpr uint8_t  HEADER_VERSION = 1;
constexpr uint16_t HEADER_SIZE    = 32;
constexpr uint16_t HEADER_CRC_OFFSET = 28;
// Largest payload the framing allows: header, payload and the commit page fill one sector
constexpr uint16_t PAYLOAD_LIMIT  = (uint16_t)(FlashIo::SECTOR_SIZE - HEADER_SIZE - FlashIo::PAGE_SIZE);

// ---- payload schemas ------------------------------------------------------------------------
//
// Schema 2 payload (PAYLOAD_V2_SIZE bytes, little-endian, no struct padding):
//      0 u16 actuation_cmm        4 u8 rt_enabled (0/1)     6 u8 boot_output (0/1)
//      2 u16 rt_sens_cmm          5 u8 active_layer         7 u8 reserved 0
//      8 keymaps[3][16], layer-major, 6 bytes each: u8 code, char label[5] (NUL padded)
//    296 u8 calibration state (CalState: 0 missing, 1 valid, 2 invalid; 3 is never stored)
//    297 u8[3] reserved 0
//    300 16 x { u16 rest_raw, u16 range_counts, i8 polarity, u8 flags }
//    396 end
//
// Migration table (decode()): schema 2 -> current RAM model. The legacy v1 EEPROM image is not
// an A/B record; config.cpp migrates it separately (legacy_settings_v1.h). A new schema adds an
// encoder, bumps SCHEMA_CURRENT and keeps a decoder row for every older schema.
constexpr uint16_t SCHEMA_V2       = 2;
constexpr uint16_t SCHEMA_CURRENT  = SCHEMA_V2;
constexpr uint16_t PAYLOAD_V2_SIZE = 396;
constexpr uint16_t PAYLOAD_MAX     = 512;   // largest supported-schema payload this firmware buffers

// Encodes `s` with SCHEMA_CURRENT. Returns the payload length, or 0 if `cap` is too small.
uint16_t encode(const DeviceSettings& s, uint8_t* out, uint16_t cap);

// Decodes a payload of any supported schema into `out` (structure only: lengths, booleans,
// label terminators, calibration state byte). Semantic checks are the caller's. False leaves
// `out` in an unspecified state.
bool decode(uint16_t schema, const uint8_t* payload, uint16_t len, DeviceSettings& out);
bool schemaSupported(uint16_t schema);

// ---- slots ----------------------------------------------------------------------------------

enum class SlotState : uint8_t {
    Empty = 0,     // every byte is 0xFF
    Corrupt,       // bad magic, header CRC, length, payload CRC or commit word (includes cut-short saves)
    Invalid,       // framing valid, supported schema, but the payload failed decoding/validation
    NewerSchema,   // framing valid, written by newer firmware (schema or header version unknown)
    Valid,
};

struct SlotInfo {
    SlotState state;
    bool      seqKnown;       // header CRC verified: headerVersion/schema/seq/payloadLen are real
    uint8_t   headerVersion;
    uint16_t  schema;
    uint32_t  seq;
    uint16_t  payloadLen;
};

// Classifies `slot` by its framing. A committed record of a supported schema is reported Valid
// and its payload copied to `payload` (reported Invalid if it does not fit `cap`); the caller
// downgrades Valid to Invalid when decoding or semantic validation fails.
SlotInfo inspect(uint8_t slot, uint8_t* payload, uint16_t cap);

// Slot holding the Valid record with the highest sequence (A on a tie), -1 if none.
int8_t newestValid(const SlotInfo s[FlashIo::SECTOR_COUNT]);

// Slot the next save writes:
//  1. A NewerSchema record whose sequence is higher than every Valid record is protected: the
//     save goes to the other slot, even if that slot holds the only record this firmware can
//     read (a power cut during that save then leaves nothing loadable by this firmware, but the
//     newer record intact). The saved record gets a higher sequence, so the next save
//     overwrites the newer record: it survives exactly until the user saves twice.
//     Two protected records: the one with the lower sequence is overwritten.
//  2. Otherwise the slot not holding the newest Valid record.
//  3. Neither slot Valid: Empty before Corrupt before Invalid, A on a tie.
uint8_t chooseTarget(const SlotInfo s[FlashIo::SECTOR_COUNT]);

// 1 + the highest sequence with a verified header (Valid, Invalid, NewerSchema, or a Corrupt
// record whose header survived), 1 when there is none.
uint32_t nextSequence(const SlotInfo s[FlashIo::SECTOR_COUNT]);

enum class WriteStatus : uint8_t { Ok = 0, FlashError, VerifyFailed };

struct WriteResult {
    WriteStatus status;
    uint8_t     slot;
    uint32_t    seq;
};

// Writes one record into `slot` (erase, blank check, program, verify, commit, verify).
// FlashError: FlashIo refused an erase/program. VerifyFailed: flash content differs from what
// was written. Never touches the other slot.
WriteStatus write(uint8_t slot, uint32_t seq, uint16_t schema, const uint8_t* payload, uint16_t len);

// chooseTarget() + nextSequence() + write().
WriteResult save(const SlotInfo s[FlashIo::SECTOR_COUNT], uint16_t schema, const uint8_t* payload, uint16_t len);

// True when `slot` holds exactly this committed record, byte for byte over the whole sector.
bool matches(uint8_t slot, uint32_t seq, uint16_t schema, const uint8_t* payload, uint16_t len);

// CRC-32 as zlib.crc32: pass 0 to start, feed chunks by passing the previous result.
uint32_t crc32Update(uint32_t crc, const uint8_t* data, uint32_t len);

} // namespace SettingsStore

#endif // SETTINGS_STORE_H
