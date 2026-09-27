// Device implementation of keyboard_output_hal.h on the arduino-pico Keyboard library.
// Host builds use tests/firmware_host/kbd_fake_hal.cpp instead.
#ifndef DRIFTPAD_HOST_BUILD

#include "keyboard_output_hal.h"
#include <Arduino.h>
#include <Keyboard.h>
#include <USB.h>
#include <CoreMutex.h>
#include "tusb.h"

namespace {
bool s_linkUp = false;   // tud_ready() at the previous hidTakeResumed() call
}

void hidInit() {
    Keyboard.begin();
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

bool hidReady() {
    // Keyboard_::sendReport() makes this same call under this same mutex; HIDReady() runs
    // tud_task(), which the USB IRQ task must not enter at the same time. It returns at once when
    // the device is unmounted or suspended. While mounted with an earlier report still in flight
    // it waits for the host to poll that report (one HID poll interval, 500 ms at most), exactly
    // as the library's own send would. The library checks again inside sendReport(); a suspend
    // landing between the two checks drops that one report, and hidTakeResumed() then triggers a
    // resync once the link is back.
    CoreMutex m(&USB.mutex);
    return USB.HIDReady();
}

bool hidTakeResumed() {
    // arduino-pico does not forward tud_mount_cb/tud_resume_cb to sketches, and defining them
    // here could collide with the core in a later release, so the link state is polled instead.
    // tud_ready() = mounted && !suspended.
    bool up = tud_ready();
    bool resumed = up && !s_linkUp;
    s_linkUp = up;
    return resumed;
}

#endif // DRIFTPAD_HOST_BUILD
