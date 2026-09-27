#include "keycodes.h"

// ASCII -> HID usage table of the arduino-pico HID_Keyboard library
// (libraries/HID_Keyboard/src/KeyboardLayout_en_US.cpp, 128 entries). The device links the
// library's own table and the host tests link the same file, so resolution can never drift from
// what Keyboard.press(code) itself would send. Same declaration as in <HID_Keyboard.h>.
extern const uint8_t KeyboardLayout_en_US[];

namespace {

// Keyboard code ranges, as HID_Keyboard::press() splits them
constexpr uint8_t RAW_USAGE_BASE    = 136;   // 136..255: usage = code - 136
constexpr uint8_t RAW_MODIFIER_BASE = 128;   // 128..135: modifier bit = code - 128

// Flags inside layout entries (libraries/HID_Keyboard/src/KeyboardLayout.h)
constexpr uint8_t LAYOUT_SHIFT  = 0x80;      // SHIFT: character needs left shift
constexpr uint8_t LAYOUT_ALT_GR = 0xC0;      // ALT_GR: character needs right alt (tested first)
constexpr uint8_t ISO_REPLACEMENT = 0x32;    // stands in for ISO_KEY inside layout tables
constexpr uint8_t ISO_KEY         = 0x64;

// HID modifier bits the library adds for layout flags
constexpr uint8_t MOD_LEFT_SHIFT = 0x02;
constexpr uint8_t MOD_RIGHT_ALT  = 0x40;

// Usages 0x01..0x03 are the keyboard's own status codes (ErrorRollOver, POSTFail,
// ErrorUndefined). The library would put them in the report, but a host reads a report
// containing them as "phantom state" and ignores every key in it, so they are not actions.
constexpr uint8_t FIRST_KEY_USAGE = 0x04;

} // namespace

HidAction keycodeResolve(uint8_t code) {
    HidAction action = {0, 0, false};
    if (code == 0) {
        return action;
    }

    if (code >= RAW_USAGE_BASE) {
        action.usage = (uint8_t)(code - RAW_USAGE_BASE);
    } else if (code >= RAW_MODIFIER_BASE) {
        action.modifiers = (uint8_t)(1u << (code - RAW_MODIFIER_BASE));
    } else {
        uint8_t k = KeyboardLayout_en_US[code];
        if (k == 0) {
            return action;   // unmapped: the library returns 0 and sends nothing
        }
        if ((k & LAYOUT_ALT_GR) == LAYOUT_ALT_GR) {
            action.modifiers |= MOD_RIGHT_ALT;
            k &= 0x3F;
        } else if ((k & LAYOUT_SHIFT) == LAYOUT_SHIFT) {
            action.modifiers |= MOD_LEFT_SHIFT;
            k &= 0x7F;
        }
        if (k == ISO_REPLACEMENT) {
            k = ISO_KEY;
        }
        action.usage = k;
    }

    if (action.usage != 0 && action.usage < FIRST_KEY_USAGE) {
        return HidAction{0, 0, false};
    }
    action.valid = (action.modifiers != 0 || action.usage != 0);
    if (!action.valid) {
        action.modifiers = 0;
        action.usage = 0;
    }
    return action;
}

bool keycodeIsAssignable(uint8_t code) {
    return code == 0 || keycodeResolve(code).valid;
}
