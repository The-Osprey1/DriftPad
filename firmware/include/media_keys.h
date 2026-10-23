#ifndef MEDIA_KEYS_H
#define MEDIA_KEYS_H

#include <cstdint>

/**
 * @file media_keys.h
 * @brief Volume and mute from the rotary encoder, as USB media keys.
 *
 * Taps are queued and sent one report per service() call, only when the endpoint is free and the
 * keyboard has nothing waiting to be confirmed, so a media key never delays or displaces a
 * keystroke. Like the keys, media keys are sent only while keyboard output is enabled.
 */

namespace MediaKeys {

constexpr uint16_t VOLUME_UP   = 0x00E9;   // HID consumer page usages
constexpr uint16_t VOLUME_DOWN = 0x00EA;
constexpr uint16_t MUTE        = 0x00E2;

void init();

// Queues `count` taps (press, then release) of `usage`. Taps beyond the queue's room are dropped.
void tap(uint16_t usage, uint8_t count = 1);

// Sends at most one report: the release of the key that is down, else the next queued press.
// Call every loop.
void service();

// Taps queued and not yet sent
uint8_t queued();

} // namespace MediaKeys

#endif // MEDIA_KEYS_H
