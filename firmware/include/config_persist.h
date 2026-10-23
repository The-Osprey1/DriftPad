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
 * Backend: src/config_persist_ab.cpp - two A/B flash sectors (settings_store.h), with read-only
 * migration from the legacy v1 EEPROM image. It stores every DeviceSettings field.
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
