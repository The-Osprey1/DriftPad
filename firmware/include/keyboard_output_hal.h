#ifndef KEYBOARD_OUTPUT_HAL_H
#define KEYBOARD_OUTPUT_HAL_H

#include <cstdint>

/**
 * @file keyboard_output_hal.h
 * @brief The only path from KeyboardOutput to the USB keyboard.
 *
 * Device: src/keyboard_output_hal_device.cpp wraps the arduino-pico Keyboard library.
 * Host tests: tests/firmware_host/kbd_fake_hal.cpp reproduces the library's report handling
 * (tests/test_keyboard_output.py checks it against the real library) and records every report.
 *
 * KeyboardOutput passes raw codes only: 136 + usage for keys, 128 + bit for modifiers. With raw
 * codes the library never consults its ASCII map, so it never adds or drops Shift/AltGr itself.
 * Return values are the library's (press()/release() != 0).
 */

void hidInit();                  // Keyboard.begin()
bool hidPress(uint8_t code);     // Keyboard.press(code) != 0; false means no report was sent
bool hidRelease(uint8_t code);   // Keyboard.release(code) != 0
void hidReleaseAll();            // Keyboard.releaseAll()

// True when a report sent now reaches the host (USB.HIDReady(), the check the library makes
// before every report). When false the library still updates its report but drops the send.
bool hidReady();

// True once each time the USB link comes back (mounted and not suspended after being
// unmounted or suspended). The host may have dropped key state meanwhile.
bool hidTakeResumed();

#endif // KEYBOARD_OUTPUT_HAL_H
