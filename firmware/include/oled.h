#ifndef OLED_H
#define OLED_H

#include <cstdint>

/**
 * @file oled.h
 * @brief 128x64 OLED display controller for DriftPad.
 *
 * Supports 1.3" SH1106 (default) and 0.96" SSD1306 128x64 displays.
 * Strictly enforces safe-zone rendering (Rows 25..63; Rows 0..24 kept unwritten/black).
 *
 * Core ownership (see display_link.h): core 1 owns the I2C bus and the display and draws from
 * the snapshot core 0 publishes (display_publish.h). The functions below are called on core 0;
 * none of them touches I2C or waits for core 1. Display actions are posted as requests; the two
 * that report a result (test pattern, bus scan) return a ticket for oledRequestServed().
 */

#ifndef USE_SH1106
#define USE_SH1106 0
#endif

enum class MenuMode {
    ADJUST_RT = 0,
    ADJUST_ACTUATION,
    TOGGLE_RT,
    CYCLE_LAYER,
    COUNT
};

// Core 0 state only (menu page, requests); core 1 initialises the display itself.
void oledInit();
void oledCycleMenu();
// Returns true if a setting changed (false when the input only woke the display)
bool oledAdjustCurrentSetting(int32_t delta);
void oledSetFullScreen(bool enabled);
bool oledIsFullScreen();
void oledTriggerScreensaver();
bool oledIsScreensaverActive();
void oledWake();
void oledSleep();
bool oledIsSleeping();
void oledSetScreensaverAnim(int8_t animIdx);   // -1 cycles through all of them
constexpr int8_t OLED_ANIM_COUNT = 6;

// Requests with a result, served by core 1
enum class OledRequest : uint8_t { TestPattern, BusScan };
uint32_t oledPost(OledRequest r);
bool oledRequestServed(OledRequest r, uint32_t ticket);
// After oledRequestServed(BusScan, ...): the I2C addresses that answered (at most `max`), returns the count
uint8_t oledBusScanResult(uint8_t* found, uint8_t max);

#endif // OLED_H
