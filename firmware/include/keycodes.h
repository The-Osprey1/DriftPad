#ifndef KEYCODES_H
#define KEYCODES_H

#include <cstdint>

/**
 * @file keycodes.h
 * @brief Resolves Arduino Keyboard key codes (0..255) into the HID action they produce.
 *
 * Mirrors arduino-pico HID_Keyboard::press() for the en_US layout:
 *   code >= 136      -> keyboard usage (code - 136), no modifier
 *   128..135         -> modifier bit (code - 128)
 *   1..127           -> KeyboardLayout_en_US[code]; 0 means unmapped. The SHIFT flag adds left
 *                       shift, ALT_GR adds right alt.
 *   0                -> "None": assignable, produces no action.
 */

struct HidAction {
    uint8_t modifiers;  // HID modifier bit mask (bit 0 = left ctrl ... bit 7 = right GUI)
    uint8_t usage;      // HID keyboard usage, 0 when the action is modifiers only
    bool    valid;      // false for code 0 and for unmapped codes
};

HidAction keycodeResolve(uint8_t code);

// True for code 0 (None) and for every code that resolves to a HID action.
bool keycodeIsAssignable(uint8_t code);

#endif // KEYCODES_H
