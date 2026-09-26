#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>
#include "pins.h"

constexpr uint32_t CONFIG_MAGIC   = 0x44524654; // "DRFT"
constexpr uint8_t  CONFIG_VERSION = 1;
constexpr uint8_t  NUM_LAYERS     = 3;

struct LayerKey {
    uint8_t hidCode;
    char    label[5];
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

void configInit();
DeviceSettings& configGet();
void configSave();
void configResetDefaults();
void configApplyToHardware();

#endif // CONFIG_H
