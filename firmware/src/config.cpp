#include "config.h"
#include "config_persist.h"
#include "hall.h"
#include "keycodes.h"
#include <cstring>

#ifndef DRIFTPAD_HOST_BUILD
#include <Keyboard.h>
#endif

namespace {

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

// Live settings (applied to the sensing engine) and the copy the flash holds
DeviceSettings s_settings;
DeviceSettings s_flashCopy;
bool           s_flashValid = false;   // flash holds s_flashCopy
bool           s_forceDirty = false;   // loaded values were repaired: dirty until saved
bool           s_dirty      = true;
LoadReport     s_report     = { SettingsSource::Defaults, 0, 0, false };

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

bool sameKeymaps(const DeviceSettings& a, const DeviceSettings& b) {
    for (uint8_t l = 0; l < NUM_LAYERS; ++l) {
        for (uint8_t k = 0; k < NUM_KEYS; ++k) {
            const LayerKey& x = a.keymaps[l][k];
            const LayerKey& y = b.keymaps[l][k];
            if (x.hidCode != y.hidCode || strncmp(x.label, y.label, sizeof(x.label)) != 0) return false;
        }
    }
    return true;
}

// Field by field, only what the persistence backend stores
bool sameStored(const DeviceSettings& a, const DeviceSettings& b) {
    if (a.actuationCmm != b.actuationCmm || a.rtSensCmm != b.rtSensCmm || a.rtEnabled != b.rtEnabled ||
        a.activeLayer != b.activeLayer || !sameKeymaps(a, b)) {
        return false;
    }
    if (persistStoresBootOutput() && a.bootOutput != b.bootOutput) return false;
    if (persistStoresCalibration() && memcmp(&a.calibration, &b.calibration, sizeof(a.calibration)) != 0) {
        return false;
    }
    return true;
}

void updateDirty() {
    s_dirty = s_forceDirty || !s_flashValid || !sameStored(s_settings, s_flashCopy);
}

bool inRange(uint16_t v, uint16_t lo, uint16_t hi) {
    return v >= lo && v <= hi;
}

// Settings read from flash become the live settings and the known flash copy
void adoptLoaded(bool found, const LoadReport& report) {
    s_report     = report;
    s_flashValid = found;
    s_flashCopy  = s_settings;
    // Repaired values differ from what flash holds, so they stay dirty until saved
    s_forceDirty = found && (report.migrated || (report.errors & load_error::LEGACY_REPAIRED));
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

void configFactoryDefaults(DeviceSettings& s) {
    setDefaults(s);
}

void configInit() {
    LoadReport report = { SettingsSource::Defaults, 0, 0, false };
    setDefaults(s_settings);
    const bool found = persistLoad(s_settings, report);
    if (!found) setDefaults(s_settings);
    adoptLoaded(found, report);
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
    return s_flashValid ? s_report.seq : 0;
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
    SaveResult r = persistSave(s_settings);
    if (r.ok) {
        s_flashCopy  = s_settings;
        s_flashValid = true;
        s_forceDirty = false;
        s_report.seq = r.seq;
        s_report.source = r.slot == 0 ? SettingsSource::SlotA : SettingsSource::SlotB;   // INFO names what was written last
    }
    updateDirty();
    return r;
}

bool configRevert() {
    DeviceSettings loaded;
    LoadReport report = { SettingsSource::Defaults, 0, 0, false };
    setDefaults(loaded);
    if (!persistLoad(loaded, report)) return false;
    // Calibration the backend does not store is kept, not reset
    if (!persistStoresCalibration()) loaded.calibration = s_settings.calibration;
    if (!persistStoresBootOutput()) loaded.bootOutput = s_settings.bootOutput;
    s_settings = loaded;
    adoptLoaded(true, report);
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
