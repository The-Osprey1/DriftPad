// Host stand-in for arduino-pico cores/rp2040/USB.h: the USBClass members that the real
// libraries/Keyboard/src/Keyboard.cpp and firmware/src/keyboard_output_hal_device.cpp use.
// Implemented in tests/firmware_host/usb_fake.cpp.
#ifndef DRIFTPAD_HOST_USB_H
#define DRIFTPAD_HOST_USB_H

#include <cstddef>
#include <cstdint>

typedef struct { int unused; } mutex_t;

class USBClass {
public:
    uint8_t registerHIDDevice(const uint8_t* descriptor, size_t len, int ordering, uint32_t pidMask);
    void unregisterHIDDevice(unsigned int localid);
    uint8_t findHIDReportID(unsigned int localid);
    void disconnect();
    void connect();
    // Same loop as USB.cpp: waits (up to 500 ms) while mounted with the previous report still in
    // flight, running tud_task() so the host can poll it; returns tud_hid_ready().
    bool HIDReady();
    mutex_t mutex;
};

extern USBClass USB;

// arduino-pico's CoreMutex (reached through Arduino.h on the device). Host tests are single
// threaded, so it always acquires.
enum { DebugEnable = 1 };
class CoreMutex {
public:
    CoreMutex(mutex_t*, uint8_t = DebugEnable) {}
    operator bool() { return true; }
};

#endif
