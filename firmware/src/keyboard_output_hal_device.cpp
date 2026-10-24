// keyboard_output_hal.h on the arduino-pico Keyboard library and TinyUSB.
// Host tests compile this file unchanged against tests/firmware_host/usb_host/ fakes.
#include "keyboard_output_hal.h"
#include <Arduino.h>
#include <Keyboard.h>
#include <Mouse.h>
#include <USB.h>
#include "tusb.h"

namespace {
// Written from tud_task(), which arduino-pico runs from a USB interrupt as well as from inside
// the library's HIDReady() wait; 32-bit stores are atomic on the RP2040.
volatile uint32_t s_delivered = 0;
volatile uint32_t s_failed = 0;
uint32_t s_linkDrops = 0;
bool     s_linkWasUp = false;
}

// TinyUSB weak callbacks (pico-sdk lib/tinyusb src/class/hid/hid_device.c). The core does not
// define them. Keyboard and media reports share the endpoint and are both counted: KeyboardOutput
// expects one delivery for a report already in flight when it starts, whichever kind it is.
extern "C" void tud_hid_report_complete_cb(uint8_t, uint8_t const*, uint16_t) {
    s_delivered = s_delivered + 1;
}

extern "C" void tud_hid_report_failed_cb(uint8_t, hid_report_type_t type, uint8_t const*, uint16_t) {
    if (type == HID_REPORT_TYPE_INPUT) s_failed = s_failed + 1;
}

void hidInit() {
    Keyboard.begin();
    Mouse.begin();
}

bool hidPress(uint8_t code) {
    return Keyboard.press(code) != 0;
}

bool hidRelease(uint8_t code) {
    return Keyboard.release(code) != 0;
}

void hidReleaseAll() {
    Keyboard.releaseAll();
}

bool hidConsumerPress(uint16_t usage) {
    return Keyboard.consumerPress(usage) != 0;
}

bool hidConsumerRelease() {
    return Keyboard.consumerRelease() != 0;
}

// The Mouse library returns nothing: like the keyboard calls, an attempt is judged by the
// transfer counters
bool hidMouseWheel(int8_t steps) {
    Mouse.move(0, 0, steps);
    return true;
}

bool hidMouseButtons(uint8_t buttons) {
    Mouse.release(MOUSE_ALL & ~buttons);
    Mouse.press(buttons);
    return true;
}

bool hidLinkUp() {
    return tud_ready();
}

bool hidEndpointFree() {
    return tud_hid_ready();
}

uint32_t hidDeliveredCount() {
    return s_delivered;
}

uint32_t hidFailedCount() {
    return s_failed;
}

uint32_t hidLinkDownCount() {
    // arduino-pico does not forward tud_umount_cb/tud_suspend_cb to sketches, so the link is
    // polled; KeyboardOutput::service() calls this every loop. A bus reset shorter than one loop
    // is not seen here, but it aborts the in-flight transfer, which the delivery check catches.
    bool up = tud_ready();
    if (s_linkWasUp && !up) s_linkDrops++;
    s_linkWasUp = up;
    return s_linkDrops;
}
