// Host stand-in for the TinyUSB device API used by the arduino-pico Keyboard library and the
// firmware keyboard HAL. Behaviour (endpoint busy until the host polls, suspend, unmount) is
// modelled in tests/firmware_host/usb_fake.cpp.
#ifndef DRIFTPAD_HOST_TUSB_H
#define DRIFTPAD_HOST_TUSB_H

#include <cstdint>

typedef enum {
    HID_REPORT_TYPE_INVALID = 0,
    HID_REPORT_TYPE_INPUT,
    HID_REPORT_TYPE_OUTPUT,
    HID_REPORT_TYPE_FEATURE,
} hid_report_type_t;

#define KEYBOARD_LED_NUMLOCK    0x01
#define KEYBOARD_LED_CAPSLOCK   0x02
#define KEYBOARD_LED_SCROLLLOCK 0x04
#define KEYBOARD_LED_COMPOSE    0x08
#define KEYBOARD_LED_KANA       0x10

// Descriptor macros: the byte content is irrelevant to the fake, only that they compile
#define HID_REPORT_ID(x) 0x85, (x),
#define TUD_HID_REPORT_DESC_KEYBOARD(...) 0x05, 0x01, 0x09, 0x06, __VA_ARGS__ 0xC0
#define TUD_HID_REPORT_DESC_CONSUMER(...) 0x05, 0x0C, 0x09, 0x01, __VA_ARGS__ 0xC0

void tud_task();
bool tud_ready();          // mounted and not suspended
bool tud_mounted();
bool tud_suspended();
bool tud_hid_ready();      // tud_ready() and the HID IN endpoint is free
bool tud_hid_keyboard_report(uint8_t report_id, uint8_t modifier, const uint8_t keycode[6]);
bool tud_hid_report(uint8_t report_id, const void* report, uint16_t len);

// Called by the fake stack when the host has collected a queued report (TinyUSB invokes it
// from tud_task()). The firmware HAL defines it; builds without the HAL link a default.
extern "C" void tud_hid_report_complete_cb(uint8_t instance, const uint8_t* report, uint16_t len);
extern "C" void tud_hid_report_failed_cb(uint8_t instance, hid_report_type_t report_type,
                                         const uint8_t* report, uint16_t xferred_bytes);

#endif
