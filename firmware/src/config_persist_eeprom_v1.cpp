// Settings persistence in the v1 EEPROM image (see config_persist.h, legacy_settings_v1.h).
//
// This is the format every DriftPad firmware so far has used: one image at offset 0 of the
// arduino-pico EEPROM emulation sector (the last 4 KB of flash), written with EEPROM.commit(),
// which erases that sector and programs it again. It is NOT power-fail safe: power lost between
// the erase and the end of programming leaves no valid settings (the loader then falls back to
// factory defaults). What this backend adds over v1 is the read-back check after commit().
//
// Stored: actuation, RT sensitivity, RT enable, active layer, keymaps.
// Not stored (not in the v1 image): calibration, boot output.
#include "config_persist.h"
#include "keycodes.h"
#include "legacy_settings_v1.h"
#include <Arduino.h>
#include <EEPROM.h>
#include <cmath>
#include <cstring>

#ifdef DRIFTPAD_HOST_BUILD
extern "C" uint8_t* eeprom_fake_sector();
#else
extern "C" uint8_t _EEPROM_start;   // XIP-mapped EEPROM sector (arduino-pico linker script)
#endif

namespace {

// v1 called EEPROM.begin(sizeof(DeviceSettings)); keep the same size so older firmware reads
// what this one writes
constexpr size_t EEPROM_BYTES = legacy_v1::IMAGE_SIZE;

bool s_begun = false;

void ensureBegun() {
    if (!s_begun) {
        EEPROM.begin(EEPROM_BYTES);
        s_begun = true;
    }
}

const uint8_t* flashImage() {
#ifdef DRIFTPAD_HOST_BUILD
    return eeprom_fake_sector();
#else
    return &_EEPROM_start;
#endif
}

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

void encodeImage(const DeviceSettings& s, legacy_v1::DeviceSettings& img) {
    memset(&img, 0, sizeof(img));   // v1 zeroed the struct, padding included, before filling it
    img.magic = legacy_v1::CONFIG_MAGIC;
    img.version = legacy_v1::CONFIG_VERSION;
    img.actuationMm = limits::cmmToMm(s.actuationCmm);
    img.rtSensMm = limits::cmmToMm(s.rtSensCmm);
    img.rtEnabled = s.rtEnabled;
    img.activeLayer = s.activeLayer;
    for (uint8_t l = 0; l < NUM_LAYERS; ++l) {
        for (uint8_t k = 0; k < NUM_KEYS; ++k) {
            img.keymaps[l][k].hidCode = s.keymaps[l][k].hidCode;
            memcpy(img.keymaps[l][k].label, s.keymaps[l][k].label, legacy_v1::LABEL_BYTES);
        }
    }
    for (uint8_t k = 0; k < NUM_KEYS; ++k) img.baselines[k] = 2048;   // unused by v1 loaders
    img.checksum = legacy_v1::crc32(reinterpret_cast<const uint8_t*>(&img), legacy_v1::CRC_LEN);
}

} // namespace

bool persistStoresCalibration() { return false; }
bool persistStoresBootOutput() { return false; }

bool persistLoad(DeviceSettings& out, LoadReport& report) {
    report = { SettingsSource::Defaults, 0, 0, false };
    ensureBegun();
    const uint8_t* img = flashImage();

    bool erased = true;
    for (size_t i = 0; i < legacy_v1::IMAGE_SIZE && erased; ++i) erased = img[i] == 0xFF;
    if (erased) return false;
    if (!legacy_v1::imageValid(img)) {
        report.errors |= load_error::LEGACY_INVALID;
        return false;
    }

    DeviceSettings loaded;
    configFactoryDefaults(loaded);
    loaded.calibration = out.calibration;
    loaded.bootOutput = out.bootOutput;
    if (decodeImage(img, loaded)) report.errors |= load_error::LEGACY_REPAIRED;
    out = loaded;
    report.source = SettingsSource::LegacyV1;
    return true;
}

SaveResult persistSave(const DeviceSettings& s) {
    SaveResult r = { false, "flash_error", 0, 0, 0 };
    const uint32_t t0 = micros();
    ensureBegun();

    legacy_v1::DeviceSettings img;
    encodeImage(s, img);
    EEPROM.put(0, img);
    const bool committed = EEPROM.commit();
    if (!committed) {
        r.durationUs = micros() - t0;
        return r;
    }
    // commit() does not report programming errors; compare what flash now holds
    if (memcmp(flashImage(), &img, sizeof(img)) != 0) {
        r.errorCode = "flash_verify_failed";
        r.durationUs = micros() - t0;
        return r;
    }
    r.ok = true;
    r.errorCode = nullptr;
    r.durationUs = micros() - t0;
    return r;
}
