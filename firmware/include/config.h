#ifndef CONFIG_H
#define CONFIG_H

#include <cstdint>
#include "pins.h"
#include "settings_limits.h"
#include "calibration.h"

/**
 * @file config.h
 * @brief Live device settings: validation, application to the sensing engine, and persistence.
 *
 * Mutators validate, apply immediately and mark the settings dirty. Nothing reaches flash until
 * configSave(). The encoder menu and the serial protocol use the same mutators.
 */

constexpr uint8_t NUM_LAYERS = limits::NUM_LAYERS;

struct LayerKey {
    uint8_t hidCode;                       // Arduino Keyboard code, 0 = none
    char    label[limits::LABEL_MAX_LEN + 1];  // normalised, NUL terminated
};

struct DeviceSettings {
    uint16_t        actuationCmm;
    uint16_t        rtSensCmm;
    bool            rtEnabled;
    uint8_t         activeLayer;
    bool            bootOutput;            // enable keyboard output at power-up when calibration is valid
    LayerKey        keymaps[NUM_LAYERS][NUM_KEYS];
    CalibrationData calibration;
};

enum class ConfigStatus : uint8_t {
    Ok = 0,
    OutOfRange,
    InvalidLabel,
    InvalidCode,
    InvalidLayer,
    InvalidKey,
    CalibrationInvalid,
};

// Protocol error code for a status ("out_of_range", "invalid_label", ...); "ok" for Ok.
const char* configStatusCode(ConfigStatus s);

enum class SettingsSource : uint8_t { SlotA = 0, SlotB, LegacyV1, Defaults };
const char* settingsSourceName(SettingsSource s);   // "slot_a", "slot_b", "legacy_v1", "defaults"

// Bits for LoadReport::errors
namespace load_error {
constexpr uint16_t SLOT_A_CORRUPT      = 1u << 0;  // bad magic/length/CRC (erased counts as empty, not corrupt)
constexpr uint16_t SLOT_B_CORRUPT      = 1u << 1;
constexpr uint16_t SLOT_A_INVALID      = 1u << 2;  // CRC ok but semantic validation failed
constexpr uint16_t SLOT_B_INVALID      = 1u << 3;
constexpr uint16_t SLOT_A_NEWER_SCHEMA = 1u << 4;  // written by newer firmware; left untouched until the next save
constexpr uint16_t SLOT_B_NEWER_SCHEMA = 1u << 5;
constexpr uint16_t LEGACY_INVALID      = 1u << 6;
constexpr uint16_t LEGACY_REPAIRED     = 1u << 7;  // legacy values clamped/replaced during migration
}
const char* loadErrorName(uint16_t bit);   // "slot_a_corrupt", ...

struct LoadReport {
    SettingsSource source;
    uint32_t       seq;        // sequence of the loaded record, 0 for legacy/defaults
    uint16_t       errors;     // load_error bits
    bool           migrated;   // loaded from an older schema; dirty until saved
};

struct SaveResult {
    bool        ok;
    const char* errorCode;     // nullptr, "flash_error" or "flash_verify_failed"
    uint8_t     slot;          // 0 = A, 1 = B
    uint32_t    seq;
    uint32_t    durationUs;
};

// Loads settings (newest valid A/B record, else legacy v1 migration, else defaults) and applies
// them. Calibration boot handling is done separately by Calibration::applyAtBoot().
void configInit();

const DeviceSettings& configGet();
bool configIsDirty();
const LoadReport& configLoadReport();
uint32_t configSettingsSeq();     // sequence of the record currently in flash (0 if none)

ConfigStatus configSetActuationCmm(uint16_t cmm);
ConfigStatus configSetRtSensCmm(uint16_t cmm);
void         configSetRtEnabled(bool enabled);
ConfigStatus configSetActiveLayer(uint8_t layer);
// label == nullptr keeps the current label; otherwise it is normalised (configNormalizeLabel)
ConfigStatus configSetKey(uint8_t layer, uint8_t key, uint8_t code, const char* label);
void         configSetBootOutput(bool enabled);
ConfigStatus configSetCalibration(const CalibrationData& data);  // must evaluate Valid (or be Missing)

void configResetUser();   // factory keymaps/actuation/RT/layer/boot output, calibration kept
void configResetAll();    // configResetUser() + calibration cleared (Missing)

SaveResult configSave();
bool configRevert();      // reload from flash; false if flash holds nothing valid (RAM unchanged)

// Label rule shared with the configurator (tests/fixtures/label_vectors.json):
// a-z uppercased; 1..4 chars; printable ASCII 0x21..0x7E except '"', '\\', '@'.
bool configNormalizeLabel(const char* in, char out[limits::LABEL_MAX_LEN + 1]);

// Pushes actuation/RT settings and the active layer's codes and labels into the sensing engine.
void configApplyToHardware();

#endif // CONFIG_H
