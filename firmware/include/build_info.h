#ifndef BUILD_INFO_H
#define BUILD_INFO_H

#include <cstdint>
#include "settings_limits.h"

/**
 * @file build_info.h
 * @brief Firmware identity reported by INFO and written to build_manifest.json.
 *
 * DRIFTPAD_FW_VERSION is defined here and only here. firmware/scripts/build_info.py reads it
 * with a regex, so keep the exact form  #define DRIFTPAD_FW_VERSION "x.y.z[-tag]".
 *
 * DRIFTPAD_BUILD_ID ("<12-char git sha>[-dirty]") and DRIFTPAD_BUILD_DATE (git commit date,
 * ISO 8601) are injected by that script as -D flags on the project sources. Host builds and
 * builds without git fall back to "unknown". No wall-clock build time is embedded, so the same
 * commit always produces the same identity.
 */

#define DRIFTPAD_FW_VERSION "2.1.0-beta.1"

#define DRIFTPAD_PROTOCOL_VERSION (limits::PROTOCOL_VERSION)

#ifndef DRIFTPAD_BUILD_ID
#define DRIFTPAD_BUILD_ID "unknown"
#endif

#ifndef DRIFTPAD_BUILD_DATE
#define DRIFTPAD_BUILD_DATE "unknown"
#endif

namespace build_info {

constexpr const char* DEVICE     = "DriftPad";
constexpr const char* HARDWARE   = "DriftPad V2 (RP2040)";
constexpr const char* FW_VERSION = DRIFTPAD_FW_VERSION;
constexpr uint8_t     PROTOCOL   = DRIFTPAD_PROTOCOL_VERSION;
constexpr const char* BUILD_ID   = DRIFTPAD_BUILD_ID;
constexpr const char* BUILD_DATE = DRIFTPAD_BUILD_DATE;

} // namespace build_info

#endif // BUILD_INFO_H
