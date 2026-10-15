// Settings persistence in two A/B flash sectors (see config_persist.h, settings_store.h and
// docs/flash-layout.md for the layout and its verification against the build).
//
// Load: both slots are inspected; a record counts only with valid framing (magic, header CRC,
// payload CRC, commit word), a supported schema and settings that pass semantic validation. The
// valid record with the highest sequence wins. If neither slot holds one, the legacy v1 EEPROM
// image (read only, never written) is migrated: values outside today's limits are clamped,
// invalid codes/labels replaced by the factory entry, calibration becomes missing (v1 stored no
// polarity or range). Migrated settings are dirty until saved.
//
// Save: the record goes to the slot that does not hold the newest valid record, is verified,
// and only then committed (settings_store.cpp). Whatever happens during a save, the previous
// record stays loadable. Physical power-cut behaviour is verified only by hardware tests.
#include "config_persist.h"
#include "flash_io.h"
#include "keycodes.h"
#include "legacy_settings_v1.h"
#include "settings_store.h"
#include <cmath>
#include <cstring>

namespace {

using SettingsStore::SlotInfo;
using SettingsStore::SlotState;

// Scratch buffers (core 0 only; load and save are not re-entrant)
uint8_t        s_payload[SettingsStore::PAYLOAD_MAX];
DeviceSettings s_candidate[FlashIo::SECTOR_COUNT];

bool inRange(uint16_t v, uint16_t lo, uint16_t hi) {
    return v >= lo && v <= hi;
}

// A stored label must already be in its normalised form, NUL padded
bool labelCanonical(const char label[limits::LABEL_MAX_LEN + 1]) {
    char norm[limits::LABEL_MAX_LEN + 1];
    if (memchr(label, '\0', limits::LABEL_MAX_LEN + 1) == nullptr) return false;
    if (!configNormalizeLabel(label, norm)) return false;
    return memcmp(norm, label, sizeof(norm)) == 0;
}

// Semantic validation of a decoded record. The calibration block is judged separately:
// implausible calibration loads as CalState::Invalid instead of rejecting the whole record.
bool settingsValid(const DeviceSettings& s) {
    if (!inRange(s.actuationCmm, limits::ACTUATION_MIN_CMM, limits::ACTUATION_MAX_CMM)) return false;
    if (!inRange(s.rtSensCmm, limits::RT_SENS_MIN_CMM, limits::RT_SENS_MAX_CMM)) return false;
    if (s.activeLayer >= NUM_LAYERS) return false;
    for (uint8_t l = 0; l < NUM_LAYERS; ++l) {
        for (uint8_t k = 0; k < NUM_KEYS; ++k) {
            if (!keycodeIsAssignable(s.keymaps[l][k].hidCode)) return false;
            if (!labelCanonical(s.keymaps[l][k].label)) return false;
        }
    }
    return true;
}

// Stored calibration is re-judged by the current plausibility rules on every load
void finishLoadedCalibration(CalibrationData& c) {
    if (c.state == (uint8_t)CalState::Missing) {
        calibrationClear(c);
        return;
    }
    c.state = (uint8_t)calibrationEvaluate(c);
}

// Inspects both slots; Valid slots are decoded into s_candidate[] and downgraded to Invalid when
// decoding or validation fails. Adds load_error bits to `errors` when given.
void scanSlots(SlotInfo info[FlashIo::SECTOR_COUNT], uint16_t* errors) {
    static const uint16_t kCorrupt[] = { load_error::SLOT_A_CORRUPT, load_error::SLOT_B_CORRUPT };
    static const uint16_t kInvalid[] = { load_error::SLOT_A_INVALID, load_error::SLOT_B_INVALID };
    static const uint16_t kNewer[]   = { load_error::SLOT_A_NEWER_SCHEMA, load_error::SLOT_B_NEWER_SCHEMA };

    for (uint8_t slot = 0; slot < FlashIo::SECTOR_COUNT; ++slot) {
        SlotInfo& si = info[slot];
        si = SettingsStore::inspect(slot, s_payload, sizeof(s_payload));
        if (si.state == SlotState::Valid) {
            DeviceSettings& c = s_candidate[slot];
            if (SettingsStore::decode(si.schema, s_payload, si.payloadLen, c) && settingsValid(c)) {
                finishLoadedCalibration(c.calibration);
            } else {
                si.state = SlotState::Invalid;
            }
        }
        if (errors == nullptr) continue;
        switch (si.state) {
            case SlotState::Corrupt:     *errors |= kCorrupt[slot]; break;
            case SlotState::Invalid:     *errors |= kInvalid[slot]; break;
            case SlotState::NewerSchema: *errors |= kNewer[slot];   break;
            default: break;
        }
    }
}

// ---- legacy v1 image (migration source, read only) -----------------------------------------

float readFloat(const uint8_t* p) {
    const uint32_t bits = legacy_v1::readU32(p);
    float f;
    memcpy(&f, &bits, sizeof(f));
    return f;
}

// v1 stored millimetres as float. Rounds to 0.01 mm and clamps to the limits; `repaired` is set
// when the value had to change by more than float rounding.
uint16_t decodeMm(float mm, uint16_t lo, uint16_t hi, uint16_t fallback, bool& repaired) {
    const float cmm = mm * 100.0f;
    if (!std::isfinite(cmm)) {
        repaired = true;
        return fallback;
    }
    if (cmm < (float)lo - 0.5f) {
        repaired = true;
        return lo;
    }
    if (cmm > (float)hi + 0.5f) {
        repaired = true;
        return hi;
    }
    uint16_t v = (uint16_t)(cmm + 0.5f);
    if (std::fabs(cmm - (float)v) > 0.01f) repaired = true;   // more than two decimals
    if (v < lo) { v = lo; repaired = true; }
    if (v > hi) { v = hi; repaired = true; }
    return v;
}

// Decodes a valid v1 image into `out` (which holds factory settings). Returns true if anything
// had to be clamped or replaced.
bool decodeImage(const uint8_t* img, DeviceSettings& out) {
    bool repaired = false;
    out.actuationCmm = decodeMm(readFloat(img + legacy_v1::OFF_ACTUATION), limits::ACTUATION_MIN_CMM,
                                limits::ACTUATION_MAX_CMM, limits::ACTUATION_DEFAULT_CMM, repaired);
    out.rtSensCmm = decodeMm(readFloat(img + legacy_v1::OFF_RT_SENS), limits::RT_SENS_MIN_CMM,
                             limits::RT_SENS_MAX_CMM, limits::RT_SENS_DEFAULT_CMM, repaired);

    const uint8_t rt = img[legacy_v1::OFF_RT_ENABLE];   // read as a byte, never through a bool
    out.rtEnabled = rt != 0;
    if (rt > 1) repaired = true;

    const uint8_t layer = img[legacy_v1::OFF_LAYER];
    if (layer < NUM_LAYERS) {
        out.activeLayer = layer;
    } else {
        out.activeLayer = 0;
        repaired = true;
    }

    for (uint8_t l = 0; l < NUM_LAYERS; ++l) {
        for (uint8_t k = 0; k < NUM_KEYS; ++k) {
            const uint8_t* e = img + legacy_v1::OFF_KEYMAPS +
                               (l * legacy_v1::NUM_KEYS + k) * sizeof(legacy_v1::LayerKey);
            LayerKey& dst = out.keymaps[l][k];   // holds the factory entry for this key

            if (keycodeIsAssignable(e[0])) {
                dst.hidCode = e[0];
            } else {
                repaired = true;
            }

            char raw[legacy_v1::LABEL_BYTES + 1];
            memcpy(raw, e + 1, legacy_v1::LABEL_BYTES);
            raw[legacy_v1::LABEL_BYTES] = '\0';   // v1 did not guarantee a terminator
            char norm[limits::LABEL_MAX_LEN + 1];
            if (configNormalizeLabel(raw, norm)) {
                if (strcmp(norm, raw) != 0) repaired = true;
                memcpy(dst.label, norm, sizeof(dst.label));
            } else {
                repaired = true;
            }
        }
    }
    return repaired;
}

} // namespace

bool persistStoresCalibration() { return true; }
bool persistStoresBootOutput() { return true; }

bool persistLoad(DeviceSettings& out, LoadReport& report) {
    report = { SettingsSource::Defaults, 0, 0, false };
    if (FlashIo::available()) {
        SlotInfo info[FlashIo::SECTOR_COUNT];
        scanSlots(info, &report.errors);
        const int8_t v = SettingsStore::newestValid(info);
        if (v >= 0) {
            out = s_candidate[v];
            report.source   = v == 0 ? SettingsSource::SlotA : SettingsSource::SlotB;
            report.seq      = info[v].seq;
            report.migrated = info[v].schema != SettingsStore::SCHEMA_CURRENT;
            return true;
        }
    }

    const uint8_t* img = FlashIo::legacyEepromPtr();
    if (img == nullptr) return false;
    bool erased = true;
    for (size_t i = 0; i < legacy_v1::IMAGE_SIZE && erased; ++i) erased = img[i] == 0xFF;
    if (erased) return false;
    if (!legacy_v1::imageValid(img)) {
        report.errors |= load_error::LEGACY_INVALID;
        return false;
    }
    DeviceSettings migrated;
    configFactoryDefaults(migrated);        // boot output off, calibration missing
    if (decodeImage(img, migrated)) report.errors |= load_error::LEGACY_REPAIRED;
    out = migrated;
    report.source   = SettingsSource::LegacyV1;
    report.migrated = true;
    return true;
}

SaveResult persistSave(const DeviceSettings& s) {
    SaveResult r = { false, "flash_error", 0, 0, 0 };
    const uint32_t t0 = FlashIo::nowUs();
    if (!FlashIo::available()) {
        r.durationUs = FlashIo::nowUs() - t0;
        return r;
    }
    SlotInfo info[FlashIo::SECTOR_COUNT];
    scanSlots(info, nullptr);   // current flash state decides the target slot and sequence

    // Encode after the scan: scanSlots uses s_payload as its read buffer
    const uint16_t len = SettingsStore::encode(s, s_payload, sizeof(s_payload));
    const SettingsStore::WriteResult w = SettingsStore::save(info, SettingsStore::SCHEMA_CURRENT, s_payload, len);
    r.slot = w.slot;
    r.seq  = w.seq;
    if (w.status == SettingsStore::WriteStatus::Ok) {
        r.ok = true;
        r.errorCode = nullptr;
    } else {
        r.errorCode = w.status == SettingsStore::WriteStatus::VerifyFailed ? "flash_verify_failed" : "flash_error";
    }
    r.durationUs = FlashIo::nowUs() - t0;
    return r;
}
