#ifndef KEYBOARD_OUTPUT_HAL_H
#define KEYBOARD_OUTPUT_HAL_H

#include <cstdint>

/**
 * @file keyboard_output_hal.h
 * @brief The only path from KeyboardOutput to the USB keyboard.
 *
 * src/keyboard_output_hal_device.cpp implements it on the arduino-pico Keyboard library and
 * TinyUSB. Host tests compile that same file against the real library and a fake TinyUSB/host
 * (tests/firmware_host/usb_fake.cpp).
 *
 * KeyboardOutput passes raw codes only: 136 + usage for keys, 128 + bit for modifiers, so the
 * library never consults its ASCII map and never adds or drops Shift/AltGr itself.
 *
 * The library's return values do NOT say whether a report was sent: press()/release() return 1
 * even when sendReport() skipped the report because USB.HIDReady() was false. Delivery is judged
 * only from the transfer counters below.
 */

void hidInit();                  // Keyboard.begin(), Mouse.begin()
// Library calls. Each attempts at most one report and may block inside the library while the
// previous report is still waiting for the host to poll (up to 500 ms if the host stops polling
// while the device stays mounted). Return: the library's own return value.
bool hidPress(uint8_t code);
bool hidRelease(uint8_t code);
void hidReleaseAll();
// Media keys (consumer control usages, e.g. 0xE9 volume up). Same endpoint and blocking rules as
// the keyboard calls; only MediaKeys calls them, and only while hidEndpointFree().
bool hidConsumerPress(uint16_t usage);
bool hidConsumerRelease();
// Mouse (the knob's scroll mode): one report each, same endpoint and rules as the media keys.
// steps > 0 scrolls up. buttons: bit 0 left, 1 right, 2 middle, held until the next call.
bool hidMouseWheel(int8_t steps);
bool hidMouseButtons(uint8_t buttons);

// Non-blocking transport state
bool hidLinkUp();                // mounted and not suspended (tud_ready())
bool hidEndpointFree();          // link up and no report waiting for the host (tud_hid_ready())

// Monotonic counters
uint32_t hidDeliveredCount();    // reports the host collected, keyboard and media (tud_hid_report_complete_cb)
uint32_t hidFailedCount();       // input reports whose transfer failed (tud_hid_report_failed_cb)
uint32_t hidLinkDownCount();     // link up -> down transitions seen by this function's polling

#endif // KEYBOARD_OUTPUT_HAL_H
