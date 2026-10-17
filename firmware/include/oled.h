#ifndef OLED_H
#define OLED_H

#include <cstdint>

/**
 * @file oled.h
 * @brief 128x64 OLED display controller for DriftPad.
 *
 * Supports 1.3" SH1106 (default) and 0.96" SSD1306 128x64 displays.
 * Strictly enforces safe-zone rendering (Rows 25..63; Rows 0..24 kept unwritten/black).
 * Offloads I2C display transmission to Core 1 so the 1000Hz ADC scanning loop is never starved.
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

void oledInit();
void oledUpdate(bool force = false);
void oledCycleMenu();
void oledAdjustCurrentSetting(int32_t delta);
void oledTestPattern();
void oledScanBus();
void oledSetFullScreen(bool enabled);
bool oledIsFullScreen();
void oledTriggerScreensaver();
bool oledIsScreensaverActive();
void oledWake();
void oledSleep();
bool oledIsSleeping();
void oledSetScreensaverAnim(int8_t animIdx);

#endif // OLED_H