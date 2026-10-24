#ifndef MEDIA_KEYS_H
#define MEDIA_KEYS_H

#include <cstdint>

/**
 * @file media_keys.h
 * @brief What the rotary encoder sends: media keys, key combinations, the mouse wheel and a
 *        middle click, according to the active layer's knob mode (KnobMode in config.h).
 *
 * Taps are queued and sent one report per service() call, only when the endpoint is free and the
 * keyboard has nothing waiting to be confirmed, so a knob action never delays or displaces a
 * keystroke. A key combination (Ctrl+Z) goes through KeyboardOutput's knob key, so keys held on
 * the pad stay held. Like the keys, nothing is sent while keyboard output is disabled.
 */

namespace MediaKeys {

constexpr uint16_t VOLUME_UP   = 0x00E9;   // HID consumer page usages
constexpr uint16_t VOLUME_DOWN = 0x00EA;
constexpr uint16_t MUTE        = 0x00E2;
constexpr uint16_t NEXT_TRACK  = 0x00B5;
constexpr uint16_t PREV_TRACK  = 0x00B6;
constexpr uint16_t PLAY_PAUSE  = 0x00CD;

constexpr uint8_t MOUSE_MIDDLE = 0x04;     // mouse button bits: 1 left, 2 right, 4 middle

void init();

// Queues `count` taps (press, then release) of a media key `usage`. Taps beyond the queue's room
// are dropped.
void tap(uint16_t usage, uint8_t count = 1);
// The same for a keyboard usage held with HID modifier bits (Ctrl+Z is 0x01, 0x1D)
void tapKey(uint8_t modifiers, uint8_t usage, uint8_t count = 1);
// Wheel steps, one report each; positive scrolls up
void scroll(int8_t steps);
// A click (press, then release) of mouse buttons
void click(uint8_t buttons);

// The knob, as the layer's mode says (KnobMode): `clicks` detents turned (positive = clockwise)
void knobTurn(uint8_t mode, int32_t clicks);
void knobPress(uint8_t mode);

// Sends at most one report: the release of what is down, else the next queued press.
// Call every loop.
void service();

// Taps queued and not yet sent
uint8_t queued();

// The last knob action, for the display's pop-up: knobSeq() counts knob turns and presses (modulo
// 256); knobAction() is mode << 3 | what (0 turned anticlockwise, 1 clockwise, 2 pressed), with
// bit 7 set when keyboard output was off, so nothing was sent.
uint8_t knobSeq();
uint8_t knobAction();

} // namespace MediaKeys

#endif // MEDIA_KEYS_H
