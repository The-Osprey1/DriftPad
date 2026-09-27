#include "config.h"
#include "hall.h"
#include "keycodes.h"
#include "flash_io.h"
#include "settings_store.h"
#include "legacy_settings_v1.h"
#include <cmath>
#include <cstring>

#ifndef DRIFTPAD_HOST_BUILD
#include <Keyboard.h>
#endif

namespace {

using SettingsStore::SlotInfo;
using SettingsStore::SlotState;

// Arduino Keyboard codes used by the factory keymaps (values from HID_Keyboard.h; checked against
// the library below so the defaults stay byte-identical to firmware v1).
constexpr uint8_t KC_LEFT_CTRL   = 0x80;
constexpr uint8_t KC_LEFT_SHIFT  = 0x81;
constexpr uint8_t KC_RETURN      = 0xB0;
constexpr uint8_t KC_ESC         = 0xB1;
constexpr uint8_t KC_BACKSPACE   = 0xB2;
constexpr uint8_t KC_TAB         = 0xB3;
constexpr uint8_t KC_INSERT      = 0xD1;
constexpr uint8_t KC_HOME        = 0xD2;
constexpr uint8_t KC_PAGE_UP     = 0xD3;
constexpr uint8_t KC_DELETE      = 0xD4;
constexpr uint8_t KC_END         = 0xD5;
constexpr uint8_t KC_PAGE_DOWN   = 0xD6;
constexpr uint8_t KC_RIGHT_ARROW = 0xD7;
constexpr uint8_t KC_LEFT_ARROW  = 0xD8;
constexpr uint8_t KC_DOWN_ARROW  = 0xD9;
constexpr uint8_t KC_UP_ARROW    = 0xDA;
constexpr uint8_t KC_F13         = 0xF0;
constexpr uint8_t KC_F14         = 0xF1;
constexpr uint8_t KC_F15         = 0xF2;
constexpr uint8_t KC_F16         = 0xF3;

#ifndef DRIFTPAD_HOST_BUILD
static_assert(KC_LEFT_CTRL == KEY_LEFT_CTRL && KC_LEFT_SHIFT == KEY_LEFT_SHIFT &&
              KC_RETURN == KEY_RETURN && KC_ESC == KEY_ESC && KC_BACKSPACE == KEY_BACKSPACE &&
              KC_TAB == KEY_TAB && KC_INSERT == KEY_INSERT && KC_HOME == KEY_HOME &&
              KC_PAGE_UP == KEY_PAGE_UP && KC_DELETE == KEY_DELETE && KC_END == KEY_END &&
              KC_PAGE_DOWN == KEY_PAGE_DOWN && KC_RIGHT_ARROW == KEY_RIGHT_ARROW &&
              KC_LEFT_ARROW == KEY_LEFT_ARROW && KC_DOWN_ARROW == KEY_DOWN_ARROW &&
              KC_UP_ARROW == KEY_UP_ARROW && KC_F13 == KEY_F13 && KC_F14 == KEY_F14 &&
              KC_F15 == KEY_F15 && KC_F16 == KEY_F16,
              "factory keymap codes must match the Arduino Keyboard library");
#endif

// -------------------------------------------------------------
// Layer 0: Standard Numpad / Calc
// -------------------------------------------------------------
const LayerKey l0[NUM_KEYS] = {
    { KC_ESC,     "ESC"  }, { '7',        "7"    }, { '8',        "8"    }, { '9',        "9"    },
    { KC_F13,     "M1"   }, { '4',        "4"    }, { '5',        "5"    }, { '6',        "6"    },
    { KC_F14,     "M2"   }, { '1',        "1"    }, { '2',        "2"    }, { '3',        "3"    },
    { KC_F15,     "M3"   }, { KC_F16,     "M4"   }, { '0',        "0"    }, { KC_RETURN,  "ENT"  }
};

// -------------------------------------------------------------
// Layer 1: Navigation & Editing
// -------------------------------------------------------------
const LayerKey l1[NUM_KEYS] = {
    { KC_ESC,         "ESC"  }, { KC_HOME,        "HOME" }, { KC_UP_ARROW,    "UP"   }, { KC_PAGE_UP,     "PGUP" },
    { KC_TAB,         "TAB"  }, { KC_LEFT_ARROW,  "LEFT" }, { KC_DOWN_ARROW,  "DOWN" }, { KC_RIGHT_ARROW, "RGHT" },
    { KC_INSERT,      "INS"  }, { KC_END,         "END"  }, { KC_DOWN_ARROW,  "DOWN" }, { KC_PAGE_DOWN,   "PGDN" },
    { KC_BACKSPACE,   "BSPC" }, { KC_DELETE,      "DEL"  }, { ' ',            "SPCE" }, { KC_RETURN,      "ENT"  }
};

// -------------------------------------------------------------
// Layer 2: Ultra-Fast Gaming WASD Cluster
// -------------------------------------------------------------
const LayerKey l2[NUM_KEYS] = {
    { KC_ESC,         "ESC"  }, { '1',            "1"    }, { '2',            "2"    }, { '3',            "3"    },
    { KC_TAB,         "TAB"  }, { 'q',            "Q"    }, { 'w',            "W"    }, { 'e',            "E"    },
    { KC_LEFT_SHIFT,  "SHFT" }, { 'a',            "A"    }, { 's',            "S"    }, { 'd',            "D"    },
    { KC_LEFT_CTRL,   "CTRL" }, { 'r',            "R"    }, { ' ',            "SPCE" }, { 'f',            "F"    }
};

const LayerKey* const kDefaultLayers[NUM_LAYERS] = { l0, l1, l2 };

// Live settings (applied to the sensing engine) and the copy that is committed in flash.
DeviceSettings s_settings;
DeviceSettings s_flashCopy;       // meaningful while s_flashSlot >= 0
int8_t         s_flashSlot  = -1; // A/B slot holding s_flashCopy, -1 if flash holds no record of it
uint32_t       s_flashSeq   = 0;
bool           s_forceDirty = false;   // loaded from an older format: dirty until saved
bool           s_dirty      = true;
LoadReport     s_report     = { SettingsSource::Defaults, 0, 0, false };

// Scratch for flash scans and saves (core 0 only; none of these functions are re-entrant)
uint8_t        s_payload[SettingsStore::PAYLOAD_MAX];
uint8_t        s_payloadCompare[SettingsStore::PAYLOAD_MAX];
DeviceSettings s_candidate[FlashIo::SECTOR_COUNT];
DeviceSettings s_loaded;

void setDefaults(DeviceSettings& s) {
    memset(&s, 0, sizeof(s));
    s.actuationCmm = limits::ACTUATION_DEFAULT_CMM;
    s.rtSensCmm    = limits::RT_SENS_DEFAULT_CMM;
    s.rtEnabled    = true;
    s.activeLayer  = 0;
    s.bootOutput   = false;
    for (uint8_t l = 0; l < NUM_LAYERS; ++l) {
        memcpy(s.keymaps[l], kDefaultLayers[l], sizeof(s.keymaps[l]));
    }
    calibrationClear(s.calibration);
}

// Compares through the canonical encoding (no padding, labels NUL padded).
bool sameSettings(const DeviceSettings& a, const DeviceSettings& b) {
    const uint16_t la = SettingsStore::encode(a, s_payload, sizeof(s_payload));
    const uint16_t lb = SettingsStore::encode(b, s_payloadCompare, sizeof(s_payloadCompare));
    return la == lb && memcmp(s_payload, s_payloadCompare, la) == 0;
}

void updateDirty() {
    s_dirty = s_forceDirty || s_flashSlot < 0 || !sameSettings(s_settings, s_flashCopy);
}

bool inRange(uint16_t v, uint16_t lo, uint16_t hi) {
    return v >= lo && v <= hi;
}

// A label is stored in its normalised form, NUL padded.
bool labelCanonical(const char label[limits::LABEL_MAX_LEN + 1]) {
    char norm[limits::LABEL_MAX_LEN + 1];
    if (memchr(label, '\0', limits::LABEL_MAX_LEN + 1) == nullptr) return false;
    if (!configNormalizeLabel(label, norm)) return false;
    return memcmp(norm, label, sizeof(norm)) == 0;
}

// Semantic validation of settings decoded from flash (the calibration block is judged by
// finishLoadedCalibration instead: implausible data loads as CalState::Invalid).
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

// Stored calibration is re-judged by the current plausibility rules on every load.
void finishLoadedCalibration(CalibrationData& c) {
    if (c.state == (uint8_t)CalState::Missing) {
        calibrationClear(c);
        return;
    }
    c.state = (uint8_t)calibrationEvaluate(c);
}

// Inspects both slots; Valid slots are decoded into s_candidate[] and downgraded to Invalid if
// they fail decoding or validation. Adds load_error bits to `errors` when given.
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
                finishLoadedCalibration(c);
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

// ---- legacy v1 migration --------------------------------------------------------------------

float legacyFloat(const uint8_t* p) {
    const uint32_t bits = legacy_v1::readU32(p);
    float f;
    memcpy(&f, &bits, sizeof(f));
    return f;
}

// v1 stored millimetres as float. Rounds to 0.01 mm and clamps to the limits; `repaired` is set
// when the value had to change by more than float rounding.
uint16_t migrateMm(float mm, uint16_t lo, uint16_t hi, uint16_t fallback, bool& repaired) {
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

// Reads the v1 EEPROM image. Absent (erased) -> false without an error bit. Present but not a
// valid v1 image -> LEGACY_INVALID. Valid -> migrated into `out` (LEGACY_REPAIRED if anything
// had to be clamped or replaced). Calibration becomes Missing: v1 stored no polarity or range.
bool loadLegacy(DeviceSettings& out, uint16_t& errors) {
    const uint8_t* img = FlashIo::legacyEepromPtr();
    if (img == nullptr) return false;

    bool erased = true;
    for (size_t i = 0; i < legacy_v1::IMAGE_SIZE && erased; ++i) erased = img[i] == 0xFF;
    if (erased) return false;
    if (!legacy_v1::imageValid(img)) {
        errors |= load_error::LEGACY_INVALID;
        return false;
    }

    bool repaired = false;
    setDefaults(out);   // boot output off, calibration Missing
    out.actuationCmm = migrateMm(legacyFloat(img + legacy_v1::OFF_ACTUATION), limits::ACTUATION_MIN_CMM,
                                 limits::ACTUATION_MAX_CMM, limits::ACTUATION_DEFAULT_CMM, repaired);
    out.rtSensCmm = migrateMm(legacyFloat(img + legacy_v1::OFF_RT_SENS), limits::RT_SENS_MIN_CMM,
                              limits::RT_SENS_MAX_CMM, limits::RT_SENS_DEFAULT_CMM, repaired);

    const uint8_t rt = img[legacy_v1::OFF_RT_ENABLE];
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
            const uint8_t* e = img + legacy_v1::OFF_KEYMAPS + (l * legacy_v1::NUM_KEYS + k) * sizeof(legacy_v1::LayerKey);
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
    if (repaired) errors |= load_error::LEGACY_REPAIRED;
    return true;
}

// Newest valid A/B record, else legacy v1. False when flash holds neither (`out` untouched).
bool loadFromFlash(DeviceSettings& out, LoadReport& report, int8_t& slot) {
    report = { SettingsSource::Defaults, 0, 0, false };
    slot = -1;
    if (FlashIo::available()) {
        SlotInfo info[FlashIo::SECTOR_COUNT];
        scanSlots(info, &report.errors);
        const int8_t v = SettingsStore::newestValid(info);
        if (v >= 0) {
            out = s_candidate[v];
            slot = v;
            report.source   = v == 0 ? SettingsSource::SlotA : SettingsSource::SlotB;
            report.seq      = info[v].seq;
            report.migrated = info[v].schema != SettingsStore::SCHEMA_CURRENT;
            return true;
        }
    }
    if (loadLegacy(out, report.errors)) {
        report.source   = SettingsSource::LegacyV1;
        report.migrated = true;
        return true;
    }
    return false;
}

void adoptLoaded(const LoadReport& report, int8_t slot) {
    s_report     = report;
    s_flashSlot  = slot;
    s_flashSeq   = slot >= 0 ? report.seq : 0;
    s_flashCopy  = s_settings;
    s_forceDirty = report.migrated;
    updateDirty();
}

void applyLayerToKeys() {
    const uint8_t layer = s_settings.activeLayer < NUM_LAYERS ? s_settings.activeLayer : 0;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        HallKey& k = HallManager::getKey(i);
        k.setHidKeyCode(s_settings.keymaps[layer][i].hidCode);
        k.setLabel(s_settings.keymaps[layer][i].label);
    }
}

} // namespace

// ---- names ----------------------------------------------------------------------------------

const char* configStatusCode(ConfigStatus s) {
    switch (s) {
        case ConfigStatus::Ok:                 return "ok";
        case ConfigStatus::OutOfRange:         return "out_of_range";
        case ConfigStatus::InvalidLabel:       return "invalid_label";
        case ConfigStatus::InvalidCode:        return "invalid_code";
        // Layer/key indices and implausible calibration data are values outside their range;
        // the protocol has no more specific codes for them.
        case ConfigStatus::InvalidLayer:       return "out_of_range";
        case ConfigStatus::InvalidKey:         return "out_of_range";
        case ConfigStatus::CalibrationInvalid: return "out_of_range";
    }
    return "out_of_range";
}

const char* settingsSourceName(SettingsSource s) {
    switch (s) {
        case SettingsSource::SlotA:    return "slot_a";
        case SettingsSource::SlotB:    return "slot_b";
        case SettingsSource::LegacyV1: return "legacy_v1";
        case SettingsSource::Defaults: return "defaults";
    }
    return "defaults";
}

const char* loadErrorName(uint16_t bit) {
    switch (bit) {
        case load_error::SLOT_A_CORRUPT:      return "slot_a_corrupt";
        case load_error::SLOT_B_CORRUPT:      return "slot_b_corrupt";
        case load_error::SLOT_A_INVALID:      return "slot_a_invalid";
        case load_error::SLOT_B_INVALID:      return "slot_b_invalid";
        case load_error::SLOT_A_NEWER_SCHEMA: return "slot_a_newer_schema";
        case load_error::SLOT_B_NEWER_SCHEMA: return "slot_b_newer_schema";
        case load_error::LEGACY_INVALID:      return "legacy_invalid";
        case load_error::LEGACY_REPAIRED:     return "legacy_repaired";
    }
    return "unknown";
}

// ---- load / state ---------------------------------------------------------------------------

void configInit() {
    LoadReport report;
    int8_t slot;
    if (!loadFromFlash(s_settings, report, slot)) setDefaults(s_settings);
    adoptLoaded(report, slot);
    configApplyToHardware();
}

const DeviceSettings& configGet() {
    return s_settings;
}

bool configIsDirty() {
    return s_dirty;
}

const LoadReport& configLoadReport() {
    return s_report;
}

uint32_t configSettingsSeq() {
    return s_flashSlot >= 0 ? s_flashSeq : 0;
}

// ---- mutators: validate -> apply -> dirty ---------------------------------------------------

ConfigStatus configSetActuationCmm(uint16_t cmm) {
    if (!inRange(cmm, limits::ACTUATION_MIN_CMM, limits::ACTUATION_MAX_CMM)) return ConfigStatus::OutOfRange;
    s_settings.actuationCmm = cmm;
    HallKey::setActuationPoint(limits::cmmToMm(cmm));
    updateDirty();
    return ConfigStatus::Ok;
}

ConfigStatus configSetRtSensCmm(uint16_t cmm) {
    if (!inRange(cmm, limits::RT_SENS_MIN_CMM, limits::RT_SENS_MAX_CMM)) return ConfigStatus::OutOfRange;
    s_settings.rtSensCmm = cmm;
    HallKey::setRtSensitivity(limits::cmmToMm(cmm));
    updateDirty();
    return ConfigStatus::Ok;
}

void configSetRtEnabled(bool enabled) {
    s_settings.rtEnabled = enabled;
    HallKey::setRapidTrigger(enabled);
    updateDirty();
}

ConfigStatus configSetActiveLayer(uint8_t layer) {
    if (layer >= NUM_LAYERS) return ConfigStatus::InvalidLayer;
    s_settings.activeLayer = layer;
    applyLayerToKeys();
    updateDirty();
    return ConfigStatus::Ok;
}

ConfigStatus configSetKey(uint8_t layer, uint8_t key, uint8_t code, const char* label) {
    if (layer >= NUM_LAYERS) return ConfigStatus::InvalidLayer;
    if (key >= NUM_KEYS) return ConfigStatus::InvalidKey;
    if (!keycodeIsAssignable(code)) return ConfigStatus::InvalidCode;
    char norm[limits::LABEL_MAX_LEN + 1];
    if (label != nullptr && !configNormalizeLabel(label, norm)) return ConfigStatus::InvalidLabel;

    LayerKey& lk = s_settings.keymaps[layer][key];
    lk.hidCode = code;
    if (label != nullptr) memcpy(lk.label, norm, sizeof(lk.label));
    if (layer == s_settings.activeLayer) {
        HallKey& k = HallManager::getKey(key);
        k.setHidKeyCode(lk.hidCode);
        k.setLabel(lk.label);
    }
    updateDirty();
    return ConfigStatus::Ok;
}

void configSetBootOutput(bool enabled) {
    s_settings.bootOutput = enabled;
    updateDirty();
}

ConfigStatus configSetCalibration(const CalibrationData& data) {
    CalibrationData c = data;
    if (c.state == (uint8_t)CalState::Missing) {
        calibrationClear(c);
    } else {
        if (calibrationEvaluate(c) != CalState::Valid) return ConfigStatus::CalibrationInvalid;
        c.state = (uint8_t)CalState::Valid;
    }
    memset(c.reserved, 0, sizeof(c.reserved));
    s_settings.calibration = c;
    updateDirty();
    return ConfigStatus::Ok;
}

void configResetUser() {
    const CalibrationData keep = s_settings.calibration;
    setDefaults(s_settings);
    s_settings.calibration = keep;
    configApplyToHardware();
    updateDirty();
}

void configResetAll() {
    setDefaults(s_settings);
    configApplyToHardware();
    updateDirty();
}

// ---- persistence ----------------------------------------------------------------------------

SaveResult configSave() {
    SaveResult r = { false, "flash_error", 0, 0, 0 };
    const uint32_t t0 = FlashIo::nowUs();
    if (!FlashIo::available()) {
        r.durationUs = FlashIo::nowUs() - t0;
        return r;
    }

    // Already committed and unchanged: prove it by reading the slot back instead of rewriting it
    if (!s_dirty && s_flashSlot >= 0) {
        uint8_t* payload = s_payloadCompare;
        const uint16_t len = SettingsStore::encode(s_settings, payload, sizeof(s_payloadCompare));
        if (SettingsStore::matches((uint8_t)s_flashSlot, s_flashSeq, SettingsStore::SCHEMA_CURRENT, payload, len)) {
            r.ok = true;
            r.errorCode = nullptr;
            r.slot = (uint8_t)s_flashSlot;
            r.seq = s_flashSeq;
            r.durationUs = FlashIo::nowUs() - t0;
            return r;
        }
    }

    SlotInfo info[FlashIo::SECTOR_COUNT];
    scanSlots(info, nullptr);   // current flash state decides the target slot and sequence

    // Encode after the scan: scanSlots uses s_payload as its read buffer
    const uint16_t len = SettingsStore::encode(s_settings, s_payload, sizeof(s_payload));
    const SettingsStore::WriteResult w =
        SettingsStore::save(info, SettingsStore::SCHEMA_CURRENT, s_payload, len);

    r.slot = w.slot;
    r.seq  = w.seq;
    if (w.status == SettingsStore::WriteStatus::Ok) {
        r.ok = true;
        r.errorCode = nullptr;
        s_flashCopy  = s_settings;
        s_flashSlot  = (int8_t)w.slot;
        s_flashSeq   = w.seq;
        s_forceDirty = false;
    } else {
        r.errorCode = w.status == SettingsStore::WriteStatus::VerifyFailed ? "flash_verify_failed" : "flash_error";
        // Only possible when a protected newer-schema record forced the write onto our own slot
        if (w.slot == s_flashSlot) {
            s_flashSlot = -1;
            s_flashSeq  = 0;
        }
    }
    updateDirty();
    r.durationUs = FlashIo::nowUs() - t0;
    return r;
}

bool configRevert() {
    LoadReport report;
    int8_t slot;
    if (!loadFromFlash(s_loaded, report, slot)) return false;
    s_settings = s_loaded;
    adoptLoaded(report, slot);
    configApplyToHardware();
    return true;
}

// ---- labels and hardware --------------------------------------------------------------------

bool configNormalizeLabel(const char* in, char out[limits::LABEL_MAX_LEN + 1]) {
    if (in == nullptr) return false;
    char tmp[limits::LABEL_MAX_LEN + 1] = { 0 };
    size_t n = 0;
    for (; in[n] != '\0'; ++n) {
        if (n >= limits::LABEL_MAX_LEN) return false;
        unsigned char c = (unsigned char)in[n];
        if (c >= 'a' && c <= 'z') c = (unsigned char)(c - 'a' + 'A');
        if (c < 0x21 || c > 0x7E || c == '"' || c == '\\' || c == '@') return false;
        tmp[n] = (char)c;
    }
    if (n == 0) return false;
    memcpy(out, tmp, sizeof(tmp));
    return true;
}

void configApplyToHardware() {
    HallKey::setActuationPoint(limits::cmmToMm(s_settings.actuationCmm));
    HallKey::setRtSensitivity(limits::cmmToMm(s_settings.rtSensCmm));
    HallKey::setRapidTrigger(s_settings.rtEnabled);
    applyLayerToKeys();
}
