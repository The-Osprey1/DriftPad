#include "settings_store.h"
#include <cstring>

namespace SettingsStore {

namespace {

constexpr uint32_t PAGE    = FlashIo::PAGE_SIZE;
constexpr uint16_t PAGES   = (uint16_t)(FlashIo::SECTOR_SIZE / FlashIo::PAGE_SIZE);
constexpr uint16_t COMMIT_BYTES = 8;   // commit magic + sequence

static_assert(FlashIo::SECTOR_SIZE % FlashIo::PAGE_SIZE == 0, "sector must be whole pages");
static_assert(PAYLOAD_MAX <= PAYLOAD_LIMIT, "payload buffer larger than a slot can hold");
static_assert(PAYLOAD_V2_SIZE <= PAYLOAD_MAX, "schema 2 payload must fit the buffer");

// Scratch pages for write/verify (core 0 only; saves are not re-entrant)
uint8_t s_page[FlashIo::PAGE_SIZE];
uint8_t s_readback[FlashIo::PAGE_SIZE];

void putU16(uint8_t* p, uint16_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
}

void putU32(uint8_t* p, uint32_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

uint16_t getU16(const uint8_t* p) {
    return (uint16_t)(p[0] | (p[1] << 8));
}

uint32_t getU32(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

bool allErased(const uint8_t* p, uint32_t len) {
    for (uint32_t i = 0; i < len; ++i) {
        if (p[i] != 0xFF) return false;
    }
    return true;
}

// Pages holding the header and payload; the commit page follows them.
uint16_t dataPages(uint16_t payloadLen) {
    return (uint16_t)((HEADER_SIZE + (uint32_t)payloadLen + PAGE - 1) / PAGE);
}

// Everything needed to reproduce any page of a record.
struct Image {
    uint8_t        header[HEADER_SIZE];
    const uint8_t* payload;
    uint16_t       len;
    uint32_t       seq;
    uint16_t       dataPages;
};

void buildHeader(Image& im, uint32_t seq, uint16_t schema, const uint8_t* payload, uint16_t len) {
    memset(im.header, 0, sizeof(im.header));
    putU32(im.header + 0, RECORD_MAGIC);
    im.header[4] = HEADER_VERSION;
    putU16(im.header + 6, schema);
    putU32(im.header + 8, seq);
    putU16(im.header + 12, len);
    putU32(im.header + 16, crc32Update(0, payload, len));
    putU32(im.header + HEADER_CRC_OFFSET, crc32Update(0, im.header, HEADER_CRC_OFFSET));
    im.payload   = payload;
    im.len       = len;
    im.seq       = seq;
    im.dataPages = dataPages(len);
}

// Expected content of page `page` of a slot holding `im`.
void composePage(const Image& im, uint16_t page, uint8_t out[FlashIo::PAGE_SIZE]) {
    memset(out, 0xFF, PAGE);
    if (page < im.dataPages) {
        const uint32_t base = (uint32_t)page * PAGE;
        const uint32_t end  = HEADER_SIZE + (uint32_t)im.len;
        for (uint32_t i = 0; i < PAGE && base + i < end; ++i) {
            const uint32_t pos = base + i;
            out[i] = pos < HEADER_SIZE ? im.header[pos] : im.payload[pos - HEADER_SIZE];
        }
    } else if (page == im.dataPages) {
        putU32(out, COMMIT_MAGIC);
        putU32(out + 4, im.seq);
    }
}

// Reads back pages [first, last) and compares them with the record image, or with 0xFF when
// `blank` (erase check).
bool verifyPages(uint8_t slot, const Image& im, uint16_t first, uint16_t last, bool blank) {
    for (uint16_t page = first; page < last; ++page) {
        if (!FlashIo::read(slot, (uint32_t)page * PAGE, s_readback, PAGE)) return false;
        if (blank) {
            if (!allErased(s_readback, PAGE)) return false;
        } else {
            composePage(im, page, s_page);
            if (memcmp(s_page, s_readback, PAGE) != 0) return false;
        }
    }
    return true;
}

// Makes a possibly committed record unloadable: zeroing the commit page clears the commit word
// (NOR programming can always clear bits). Best effort.
void killRecord(uint8_t slot, const Image& im) {
    memset(s_page, 0x00, PAGE);
    FlashIo::program(slot, (uint32_t)im.dataPages * PAGE, s_page, PAGE);
}

// ---- schema 2 codec -------------------------------------------------------------------------

constexpr uint16_t V2_OFF_KEYMAPS = 8;
constexpr uint16_t V2_KEY_BYTES   = 6;
constexpr uint16_t V2_OFF_CAL     = V2_OFF_KEYMAPS + NUM_LAYERS * NUM_KEYS * V2_KEY_BYTES;  // 296
constexpr uint16_t V2_CAL_KEY_BYTES = 6;
constexpr uint16_t V2_OFF_CAL_KEYS  = V2_OFF_CAL + 4;                                        // 300
static_assert(V2_OFF_CAL_KEYS + NUM_KEYS * V2_CAL_KEY_BYTES == PAYLOAD_V2_SIZE, "schema 2 size");
static_assert(limits::LABEL_MAX_LEN + 1 == V2_KEY_BYTES - 1, "schema 2 stores 5 label bytes");

void encodeV2(const DeviceSettings& s, uint8_t* p) {
    memset(p, 0, PAYLOAD_V2_SIZE);
    putU16(p + 0, s.actuationCmm);
    putU16(p + 2, s.rtSensCmm);
    p[4] = s.rtEnabled ? 1 : 0;
    p[5] = s.activeLayer;
    p[6] = s.bootOutput ? 1 : 0;
    for (uint8_t l = 0; l < NUM_LAYERS; ++l) {
        for (uint8_t k = 0; k < NUM_KEYS; ++k) {
            uint8_t* e = p + V2_OFF_KEYMAPS + (l * NUM_KEYS + k) * V2_KEY_BYTES;
            const LayerKey& lk = s.keymaps[l][k];
            e[0] = lk.hidCode;
            // Label bytes up to the terminator, NUL padded (canonical regardless of RAM garbage)
            for (uint8_t i = 0; i < V2_KEY_BYTES - 1 && lk.label[i] != '\0'; ++i) {
                e[1 + i] = (uint8_t)lk.label[i];
            }
        }
    }
    p[V2_OFF_CAL] = s.calibration.state;
    for (uint8_t k = 0; k < NUM_KEYS; ++k) {
        uint8_t* e = p + V2_OFF_CAL_KEYS + k * V2_CAL_KEY_BYTES;
        const KeyCalibration& kc = s.calibration.keys[k];
        putU16(e + 0, kc.restRaw);
        putU16(e + 2, kc.rangeCounts);
        e[4] = (uint8_t)kc.polarity;
        e[5] = kc.flags;
    }
}

bool decodeBool(uint8_t b, bool& out) {
    if (b > 1) return false;
    out = b != 0;
    return true;
}

bool decodeV2(const uint8_t* p, uint16_t len, DeviceSettings& out) {
    if (len != PAYLOAD_V2_SIZE) return false;
    memset(&out, 0, sizeof(out));
    out.actuationCmm = getU16(p + 0);
    out.rtSensCmm    = getU16(p + 2);
    if (!decodeBool(p[4], out.rtEnabled)) return false;
    out.activeLayer  = p[5];
    if (!decodeBool(p[6], out.bootOutput)) return false;
    for (uint8_t l = 0; l < NUM_LAYERS; ++l) {
        for (uint8_t k = 0; k < NUM_KEYS; ++k) {
            const uint8_t* e = p + V2_OFF_KEYMAPS + (l * NUM_KEYS + k) * V2_KEY_BYTES;
            LayerKey& lk = out.keymaps[l][k];
            lk.hidCode = e[0];
            memcpy(lk.label, e + 1, sizeof(lk.label));
            if (memchr(lk.label, '\0', sizeof(lk.label)) == nullptr) return false;
        }
    }
    const uint8_t state = p[V2_OFF_CAL];
    if (state != (uint8_t)CalState::Missing && state != (uint8_t)CalState::Valid &&
        state != (uint8_t)CalState::Invalid) {
        return false;   // InProgress is runtime only; anything else is not a CalState
    }
    out.calibration.state = state;
    for (uint8_t k = 0; k < NUM_KEYS; ++k) {
        const uint8_t* e = p + V2_OFF_CAL_KEYS + k * V2_CAL_KEY_BYTES;
        KeyCalibration& kc = out.calibration.keys[k];
        kc.restRaw     = getU16(e + 0);
        kc.rangeCounts = getU16(e + 2);
        kc.polarity    = (int8_t)e[4];
        kc.flags       = e[5];
    }
    return true;
}

struct SchemaDecoder {
    uint16_t schema;
    bool (*decode)(const uint8_t* p, uint16_t len, DeviceSettings& out);
};

// Migration table: one row per schema this firmware can read
const SchemaDecoder kDecoders[] = {
    { SCHEMA_V2, decodeV2 },
};

} // namespace

// ---- CRC ------------------------------------------------------------------------------------

uint32_t crc32Update(uint32_t crc, const uint8_t* data, uint32_t len) {
    crc = ~crc;
    for (uint32_t i = 0; i < len; ++i) {
        crc ^= data[i];
        for (uint8_t j = 0; j < 8; ++j) {
            crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
        }
    }
    return ~crc;
}

// ---- codec ----------------------------------------------------------------------------------

uint16_t encode(const DeviceSettings& s, uint8_t* out, uint16_t cap) {
    if (cap < PAYLOAD_V2_SIZE) return 0;
    encodeV2(s, out);
    return PAYLOAD_V2_SIZE;
}

bool schemaSupported(uint16_t schema) {
    for (const SchemaDecoder& d : kDecoders) {
        if (d.schema == schema) return true;
    }
    return false;
}

bool decode(uint16_t schema, const uint8_t* payload, uint16_t len, DeviceSettings& out) {
    for (const SchemaDecoder& d : kDecoders) {
        if (d.schema == schema) return d.decode(payload, len, out);
    }
    return false;
}

// ---- slots ----------------------------------------------------------------------------------

SlotInfo inspect(uint8_t slot, uint8_t* payload, uint16_t cap) {
    SlotInfo info = { SlotState::Corrupt, false, 0, 0, 0, 0 };
    uint8_t hdr[HEADER_SIZE];
    if (!FlashIo::read(slot, 0, hdr, HEADER_SIZE)) return info;

    if (allErased(hdr, HEADER_SIZE)) {
        // Empty only if the whole sector is erased (an interrupted erase leaves old bytes behind)
        for (uint16_t page = 0; page < PAGES; ++page) {
            if (!FlashIo::read(slot, (uint32_t)page * PAGE, s_readback, PAGE)) return info;
            if (!allErased(s_readback, PAGE)) return info;
        }
        info.state = SlotState::Empty;
        return info;
    }
    if (getU32(hdr) != RECORD_MAGIC) return info;
    if (getU32(hdr + HEADER_CRC_OFFSET) != crc32Update(0, hdr, HEADER_CRC_OFFSET)) return info;

    info.seqKnown      = true;
    info.headerVersion = hdr[4];
    info.schema        = getU16(hdr + 6);
    info.seq           = getU32(hdr + 8);
    info.payloadLen    = getU16(hdr + 12);
    if (info.headerVersion == 0 || info.payloadLen > PAYLOAD_LIMIT) return info;

    // Payload CRC, read in page-sized chunks (a newer schema may be larger than PAYLOAD_MAX)
    uint32_t crc = 0;
    for (uint32_t done = 0; done < info.payloadLen;) {
        uint32_t n = info.payloadLen - done;
        if (n > PAGE) n = PAGE;
        if (!FlashIo::read(slot, HEADER_SIZE + done, s_readback, n)) return info;
        crc = crc32Update(crc, s_readback, n);
        done += n;
    }
    if (crc != getU32(hdr + 16)) return info;

    uint8_t commit[COMMIT_BYTES];
    const uint32_t commitOffset = (uint32_t)dataPages(info.payloadLen) * PAGE;
    if (!FlashIo::read(slot, commitOffset, commit, COMMIT_BYTES)) return info;
    if (getU32(commit) != COMMIT_MAGIC || getU32(commit + 4) != info.seq) return info;

    if (info.headerVersion > HEADER_VERSION || info.schema > SCHEMA_CURRENT) {
        info.state = SlotState::NewerSchema;
        return info;
    }
    if (!schemaSupported(info.schema) || info.payloadLen > cap ||
        !FlashIo::read(slot, HEADER_SIZE, payload, info.payloadLen)) {
        info.state = SlotState::Invalid;
        return info;
    }
    info.state = SlotState::Valid;
    return info;
}

int8_t newestValid(const SlotInfo s[FlashIo::SECTOR_COUNT]) {
    int8_t best = -1;
    for (uint8_t i = 0; i < FlashIo::SECTOR_COUNT; ++i) {
        if (s[i].state != SlotState::Valid) continue;
        if (best < 0 || s[i].seq > s[best].seq) best = (int8_t)i;
    }
    return best;
}

uint8_t chooseTarget(const SlotInfo s[FlashIo::SECTOR_COUNT]) {
    const int8_t valid = newestValid(s);
    bool protectedNewer[FlashIo::SECTOR_COUNT];
    for (uint8_t i = 0; i < FlashIo::SECTOR_COUNT; ++i) {
        protectedNewer[i] = s[i].state == SlotState::NewerSchema &&
                            (valid < 0 || s[i].seq > s[valid].seq);
    }
    if (protectedNewer[0] && protectedNewer[1]) return s[0].seq <= s[1].seq ? 0 : 1;
    if (protectedNewer[0]) return 1;
    if (protectedNewer[1]) return 0;
    if (valid >= 0) return (uint8_t)(1 - valid);

    // Nothing worth keeping: overwrite the least valuable slot
    auto rank = [](SlotState st) -> uint8_t {
        switch (st) {
            case SlotState::Empty:   return 0;
            case SlotState::Corrupt: return 1;
            default:                 return 2;
        }
    };
    return rank(s[1].state) < rank(s[0].state) ? 1 : 0;
}

uint32_t nextSequence(const SlotInfo s[FlashIo::SECTOR_COUNT]) {
    uint32_t highest = 0;
    for (uint8_t i = 0; i < FlashIo::SECTOR_COUNT; ++i) {
        if (s[i].seqKnown && s[i].seq > highest) highest = s[i].seq;
    }
    // 2^32 saves are far beyond the flash's erase endurance (~100k cycles per sector)
    return highest == UINT32_MAX ? highest : highest + 1;
}

WriteStatus write(uint8_t slot, uint32_t seq, uint16_t schema, const uint8_t* payload, uint16_t len) {
    if (!FlashIo::available() || slot >= FlashIo::SECTOR_COUNT || len > PAYLOAD_LIMIT) {
        return WriteStatus::FlashError;
    }
    Image im;
    buildHeader(im, seq, schema, payload, len);

    if (!FlashIo::eraseSector(slot)) return WriteStatus::FlashError;
    if (!verifyPages(slot, im, 0, PAGES, true)) return WriteStatus::VerifyFailed;

    for (uint16_t page = 0; page < im.dataPages; ++page) {
        composePage(im, page, s_page);
        if (!FlashIo::program(slot, (uint32_t)page * PAGE, s_page, PAGE)) return WriteStatus::FlashError;
    }
    if (!verifyPages(slot, im, 0, im.dataPages, false)) return WriteStatus::VerifyFailed;

    // Commit last: until this page is programmed the record does not count
    composePage(im, im.dataPages, s_page);
    if (!FlashIo::program(slot, (uint32_t)im.dataPages * PAGE, s_page, PAGE)) {
        killRecord(slot, im);
        return WriteStatus::FlashError;
    }
    if (!verifyPages(slot, im, 0, PAGES, false)) {
        killRecord(slot, im);
        return WriteStatus::VerifyFailed;
    }
    return WriteStatus::Ok;
}

WriteResult save(const SlotInfo s[FlashIo::SECTOR_COUNT], uint16_t schema, const uint8_t* payload, uint16_t len) {
    WriteResult r;
    r.slot   = chooseTarget(s);
    r.seq    = nextSequence(s);
    r.status = write(r.slot, r.seq, schema, payload, len);
    return r;
}

bool matches(uint8_t slot, uint32_t seq, uint16_t schema, const uint8_t* payload, uint16_t len) {
    if (!FlashIo::available() || slot >= FlashIo::SECTOR_COUNT || len > PAYLOAD_LIMIT) return false;
    Image im;
    buildHeader(im, seq, schema, payload, len);
    return verifyPages(slot, im, 0, PAGES, false);
}

} // namespace SettingsStore
