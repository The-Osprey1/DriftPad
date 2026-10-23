#ifndef SETTINGS_LIMITS_H
#define SETTINGS_LIMITS_H

#include <cstdint>

/**
 * @file settings_limits.h
 * @brief The one definition of user-setting limits.
 *
 * Distances are centi-millimetres (cmm, 0.01 mm). The sensing setters, the serial protocol,
 * the encoder menu, the OLED sliders and the INFO capabilities all derive from these values;
 * the configurator reads them from INFO at run time. tests/test_contract_consistency.py checks
 * that the configurator's offline fallback and the docs agree with this file.
 *
 * These are operating limits of the sensing algorithm, not measured accuracy. Do not lower them
 * without measurements on real hardware.
 */
namespace limits {

// Actuation point. Floor: 0.20 mm top dead-zone (HallKey::TOP_DEADZONE_MM) plus 0.05 mm, so a
// key at rest can never sit on the actuation point. Ceiling: 4.00 mm nominal travel minus the
// 0.15 mm bottom dead-zone, rounded down to the 0.05 mm UI step.
constexpr uint16_t ACTUATION_MIN_CMM     = 25;
constexpr uint16_t ACTUATION_MAX_CMM     = 380;
constexpr uint16_t ACTUATION_DEFAULT_CMM = 120;

// Rapid Trigger press/release distance. Below 0.10 mm, 10-count 60 Hz EMI plus 3-count thermal
// noise causes false releases (tests/test_adversarial_m2.py ADV-02).
constexpr uint16_t RT_SENS_MIN_CMM     = 10;
constexpr uint16_t RT_SENS_MAX_CMM     = 200;
constexpr uint16_t RT_SENS_DEFAULT_CMM = 20;

// Step hints. Values in range are accepted at 0.01 mm resolution; the step only shapes UI controls.
constexpr uint16_t UI_STEP_CMM                 = 5;
constexpr uint16_t ENCODER_ACTUATION_STEP_CMM  = 10;
constexpr uint16_t ENCODER_RT_SENS_STEP_CMM    = 5;

constexpr uint8_t NUM_LAYERS    = 3;
constexpr uint8_t LABEL_MAX_LEN = 4;   // characters, excluding the terminator
constexpr uint8_t CODE_MAX      = 255;

// Serial protocol bounds
constexpr uint8_t  PROTOCOL_VERSION   = 2;
constexpr uint16_t LINE_MAX_LEN       = 160;   // bytes, excluding the terminator
constexpr uint8_t  REQUEST_ID_MAX_LEN = 12;
constexpr uint8_t  STREAM_HZ_DEFAULT  = 30;
constexpr uint8_t  STREAM_HZ_MAX      = 60;

constexpr float cmmToMm(uint16_t cmm) { return cmm / 100.0f; }

} // namespace limits

#endif // SETTINGS_LIMITS_H
