#include "config.h"
#include "hall.h"
#include <EEPROM.h>
#include <Keyboard.h>
#include <cstring>

namespace {

DeviceSettings s_settings;

uint32_t calculateCrc(const DeviceSettings& cfg) {
    const uint8_t* data = reinterpret_cast<const uint8_t*>(&cfg);
    size_t len = sizeof(DeviceSettings) - sizeof(uint32_t); // Exclude checksum field
    uint32_t crc = 0xFFFFFFFF;
    for (size_t i = 0; i < len; ++i) {
        crc ^= data[i];
        for (uint8_t j = 0; j < 8; ++j) {
            crc = (crc >> 1) ^ (0xEDB88320 & (-(crc & 1)));
        }
    }
    return ~crc;
}

void setDefaultKeymaps(DeviceSettings& cfg) {
    // -------------------------------------------------------------
    // Layer 0: Standard Numpad / Calc
    // -------------------------------------------------------------
    const LayerKey l0[NUM_KEYS] = {
        { KEY_ESC,     "ESC"  }, { '7',         "7"    }, { '8',         "8"    }, { '9',         "9"    },
        { KEY_F13,     "M1"   }, { '4',         "4"    }, { '5',         "5"    }, { '6',         "6"    },
        { KEY_F14,     "M2"   }, { '1',         "1"    }, { '2',         "2"    }, { '3',         "3"    },
        { KEY_F15,     "M3"   }, { KEY_F16,     "M4"   }, { '0',         "0"    }, { KEY_RETURN,  "ENT"  }
    };
    memcpy(cfg.keymaps[0], l0, sizeof(l0));

    // -------------------------------------------------------------
    // Layer 1: Navigation & Editing
    // -------------------------------------------------------------
    const LayerKey l1[NUM_KEYS] = {
        { KEY_ESC,         "ESC"  }, { KEY_HOME,        "HOME" }, { KEY_UP_ARROW,    "UP"   }, { KEY_PAGE_UP,     "PGUP" },
        { KEY_TAB,         "TAB"  }, { KEY_LEFT_ARROW,  "LEFT" }, { KEY_DOWN_ARROW,  "DOWN" }, { KEY_RIGHT_ARROW, "RGHT" },
        { KEY_INSERT,      "INS"  }, { KEY_END,         "END"  }, { KEY_DOWN_ARROW,  "DOWN" }, { KEY_PAGE_DOWN,   "PGDN" },
        { KEY_BACKSPACE,   "BSPC" }, { KEY_DELETE,      "DEL"  }, { ' ',             "SPCE" }, { KEY_RETURN,      "ENT"  }
    };
    memcpy(cfg.keymaps[1], l1, sizeof(l1));

    // -------------------------------------------------------------
    // Layer 2: Ultra-Fast Gaming WASD Cluster
    // -------------------------------------------------------------
    const LayerKey l2[NUM_KEYS] = {
        { KEY_ESC,         "ESC"  }, { '1',             "1"    }, { '2',             "2"    }, { '3',             "3"    },
        { KEY_TAB,         "TAB"  }, { 'q',             "Q"    }, { 'w',             "W"    }, { 'e',             "E"    },
        { KEY_LEFT_SHIFT,  "SHFT" }, { 'a',             "A"    }, { 's',             "S"    }, { 'd',             "D"    },
        { KEY_LEFT_CTRL,   "CTRL" }, { 'r',             "R"    }, { ' ',             "SPCE" }, { 'f',             "F"    }
    };
    memcpy(cfg.keymaps[2], l2, sizeof(l2));
}

} // namespace

void configResetDefaults() {
    memset(&s_settings, 0, sizeof(s_settings));
    s_settings.magic = CONFIG_MAGIC;
    s_settings.version = CONFIG_VERSION;
    s_settings.actuationMm = 1.20f;
    s_settings.rtSensMm = 0.20f;
    s_settings.rtEnabled = true;
    s_settings.activeLayer = 0;

    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        s_settings.baselines[i] = 2048;
    }

    setDefaultKeymaps(s_settings);
    s_settings.checksum = calculateCrc(s_settings);
}

void configInit() {
    EEPROM.begin(sizeof(DeviceSettings));
    DeviceSettings loaded;
    EEPROM.get(0, loaded);

    if (loaded.magic == CONFIG_MAGIC &&
        loaded.version == CONFIG_VERSION &&
        calculateCrc(loaded) == loaded.checksum) {
        s_settings = loaded;
        Serial.println("[CONFIG] Flash settings loaded successfully.");
    } else {
        Serial.println("[CONFIG] No valid Flash settings found. Initializing defaults.");
        configResetDefaults();
        configSave();
    }

    configApplyToHardware();
}

DeviceSettings& configGet() {
    return s_settings;
}

void configSave() {
    s_settings.checksum = calculateCrc(s_settings);
    EEPROM.put(0, s_settings);
    EEPROM.commit();
    Serial.println("[CONFIG] Settings committed to Flash memory.");
}

void configApplyToHardware() {
    HallKey::setActuationPoint(s_settings.actuationMm);
    HallKey::setRtSensitivity(s_settings.rtSensMm);
    HallKey::setRapidTrigger(s_settings.rtEnabled);

    // Apply keymap for active layer to HallManager keys
    uint8_t layer = s_settings.activeLayer;
    if (layer >= NUM_LAYERS) layer = 0;

    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        HallKey& k = HallManager::getKey(i);
        k.setHidKeyCode(s_settings.keymaps[layer][i].hidCode);
        k.setLabel(s_settings.keymaps[layer][i].label);
    }
}
