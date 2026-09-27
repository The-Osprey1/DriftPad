#ifndef CONFIG_PERSIST_H
#define CONFIG_PERSIST_H

#include "config.h"

/**
 * @file config_persist.h
 * @brief Storage behind config.cpp. Internal to the config module.
 *
 * config.cpp owns the settings model (validation, mutators, dirty tracking); a persistence backend
 * only turns a DeviceSettings into flash contents and back.
 *
 * Current backend: src/config_persist_eeprom_v1.cpp - the single-sector v1 EEPROM image the
 * firmware has always used (see legacy_settings_v1.h). It holds actuation, RT settings, the active
 * layer and the keymaps; calibration and boot output are not part of that image.
 */

// Loads the stored settings into `out` (validated and, where needed, repaired: out-of-range values
// clamped, invalid labels/codes replaced by the factory entry, reported in report.errors).
// Returns false when nothing valid is stored (`out` untouched; report.source = Defaults).
bool persistLoad(DeviceSettings& out, LoadReport& report);

// Writes `s` and verifies it by reading the flash back. On failure the previous contents are
// whatever the backend guarantees (documented per backend).
SaveResult persistSave(const DeviceSettings& s);

// Fields the backend stores; config.cpp only counts these when deciding whether RAM is dirty.
bool persistStoresCalibration();
bool persistStoresBootOutput();

// Factory settings (config.cpp); backends use them to repair individual entries.
void configFactoryDefaults(DeviceSettings& s);

#endif // CONFIG_PERSIST_H
