#ifndef LEGACY_SETTINGS_V1_H
#define LEGACY_SETTINGS_V1_H

#include <cstddef>
#include <cstdint>

/**
 * @file legacy_settings_v1.h
 * @brief Settings layout written by firmware v1 (config.h at 2734044 and earlier), read only.
 *
 * v1 stored `DeviceSettings` with EEPROM.put(0, ...) into the EEPROM emulation sector
 * (_EEPROM_start, the last 4 KB of flash). EEPROM.begin(sizeof) rounded the image up to 512 bytes;
 * the rest of the sector is whatever was there before (0xFF on a fresh device).
 *
 * The struct is the raw in-memory image, padding included, so its layout is fixed by the ARM EABI
 * (AAPCS: natural alignment, bool is one byte). x86-64 (SysV and Windows) lays these types out the
 * same way; the asserts below hold on both, which is what lets host tests build images with
 * Python's struct module and the loader decode them with the offsets below.
 *
 * The checksum is CRC-32 (reflected, polynomial 0xEDB88320, init and final XOR 0xFFFFFFFF, i.e.
 * zlib.crc32) over the first sizeof(DeviceSettings) - 4 bytes, padding bytes included as stored.
 *
 * Nothing writes this layout any more. The loader decodes it byte by byte (never through a
 * `bool` lvalue, so a corrupt image cannot produce an invalid bool).
 */
namespace legacy_v1 {

constexpr uint32_t CONFIG_MAGIC   = 0x44524654; // "DRFT"
constexpr uint8_t  CONFIG_VERSION = 1;
constexpr uint8_t  NUM_LAYERS     = 3;
constexpr uint8_t  NUM_KEYS       = 16;
constexpr uint8_t  LABEL_BYTES    = 5;

struct LayerKey {
    uint8_t hidCode;
    char    label[LABEL_BYTES];
};

struct DeviceSettings {
    uint32_t magic;
    uint8_t  version;
    float    actuationMm;
    float    rtSensMm;
    bool     rtEnabled;
    uint8_t  activeLayer;
    LayerKey keymaps[NUM_LAYERS][NUM_KEYS];
    uint16_t baselines[NUM_KEYS];
    uint32_t checksum;
};

static_assert(sizeof(bool) == 1 && sizeof(float) == 4, "v1 layout assumes 1-byte bool, 4-byte float");
static_assert(sizeof(LayerKey) == 6, "v1 LayerKey is 6 bytes");
static_assert(offsetof(DeviceSettings, magic) == 0, "v1 layout");
static_assert(offsetof(DeviceSettings, version) == 4, "v1 layout");
static_assert(offsetof(DeviceSettings, actuationMm) == 8, "v1 layout: 3 padding bytes after version");
static_assert(offsetof(DeviceSettings, rtSensMm) == 12, "v1 layout");
static_assert(offsetof(DeviceSettings, rtEnabled) == 16, "v1 layout");
static_assert(offsetof(DeviceSettings, activeLayer) == 17, "v1 layout");
static_assert(offsetof(DeviceSettings, keymaps) == 18, "v1 layout");
static_assert(offsetof(DeviceSettings, baselines) == 306, "v1 layout");
static_assert(offsetof(DeviceSettings, checksum) == 340, "v1 layout: 2 padding bytes after baselines");
static_assert(sizeof(DeviceSettings) == 344, "v1 layout");

// Byte offsets used by the decoder (same values as the offsetof asserts above)
constexpr size_t OFF_MAGIC     = offsetof(DeviceSettings, magic);
constexpr size_t OFF_VERSION   = offsetof(DeviceSettings, version);
constexpr size_t OFF_ACTUATION = offsetof(DeviceSettings, actuationMm);
constexpr size_t OFF_RT_SENS   = offsetof(DeviceSettings, rtSensMm);
constexpr size_t OFF_RT_ENABLE = offsetof(DeviceSettings, rtEnabled);
constexpr size_t OFF_LAYER     = offsetof(DeviceSettings, activeLayer);
constexpr size_t OFF_KEYMAPS   = offsetof(DeviceSettings, keymaps);
constexpr size_t OFF_BASELINES = offsetof(DeviceSettings, baselines);
constexpr size_t OFF_CHECKSUM  = offsetof(DeviceSettings, checksum);
constexpr size_t IMAGE_SIZE    = sizeof(DeviceSettings);
constexpr size_t CRC_LEN       = IMAGE_SIZE - sizeof(uint32_t);

// The v1 CRC-32 (bitwise, as v1 calculateCrc()).
inline uint32_t crc32(const uint8_t* data, size_t len) {
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; ++i) {
        crc ^= data[i];
        for (uint8_t j = 0; j < 8; ++j) {
            crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
        }
    }
    return ~crc;
}

inline uint32_t readU32(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

// True when `image` (IMAGE_SIZE bytes) carries the v1 magic, version and a matching checksum.
inline bool imageValid(const uint8_t* image) {
    return readU32(image + OFF_MAGIC) == CONFIG_MAGIC &&
           image[OFF_VERSION] == CONFIG_VERSION &&
           readU32(image + OFF_CHECKSUM) == crc32(image, CRC_LEN);
}

} // namespace legacy_v1

#endif // LEGACY_SETTINGS_V1_H
