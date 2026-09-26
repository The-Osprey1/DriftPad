// Host-build stub of the Arduino Keyboard library: HID output is a no-op.
#ifndef DRIFTPAD_HOST_KEYBOARD_H
#define DRIFTPAD_HOST_KEYBOARD_H
#include <cstdint>
#define KEY_ESC    0xB1
#define KEY_RETURN 0xB0
#define KEY_F13    0xF0
#define KEY_F14    0xF1
#define KEY_F15    0xF2
#define KEY_F16    0xF3
struct HostKeyboard {
    void press(uint8_t) {}
    void release(uint8_t) {}
    void releaseAll() {}
};
static HostKeyboard Keyboard;
#endif
