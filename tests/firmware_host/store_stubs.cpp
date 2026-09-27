// Link stand-ins for tests/test_settings_store.py. Each section is compiled only when the test
// module asks for it:
//
//   STORE_STUB_KEYCODES     keycodeResolve/keycodeIsAssignable (when firmware/src/keycodes.cpp
//                           cannot be linked). en_US rules of arduino-pico HID_Keyboard::press().
//   STORE_STUB_CALIBRATION  calibration plausibility helpers (when calibration.cpp cannot be linked)
//   STORE_STUB_HALL         HallKey/HallManager storage (when hall.cpp cannot be linked); the
//                           setters and getters config.cpp uses are inline in hall.h
//   STORE_STUB_MUX          muxReadChannel(), needed by the real hall.cpp
//   STORE_STUB_KBD_OUTPUT   KeyboardOutput no-ops, needed by a real hall.cpp that routes edges
//                           (settings tests never produce key edges)
//
// The real S1 sources are always preferred; the test report says which set was linked.
#include <cstdint>
#include <cstring>

#if defined(STORE_STUB_KEYCODES)
#include "keycodes.h"

// Codes 1..127 whose KeyboardLayout_en_US entry is 0 (unmapped) in arduino-pico 6.1.0:
// NUL..BEL, VT, FF, CR, SO..US and DEL. test_settings_store.py checks this list against the
// framework's KeyboardLayout_en_US.cpp when the framework is installed.
static bool enUsUnmapped(uint8_t code) {
    return (code >= 1 && code <= 7) || (code >= 11 && code <= 31) || code == 127;
}

HidAction keycodeResolve(uint8_t code) {
    HidAction a = { 0, 0, false };
    if (code == 0) return a;
    if (code >= 136) { a.usage = (uint8_t)(code - 136); a.valid = true; return a; }
    if (code >= 128) { a.modifiers = (uint8_t)(1u << (code - 128)); a.valid = true; return a; }
    a.valid = !enUsUnmapped(code);
    return a;   // usage not needed by the settings tests
}

bool keycodeIsAssignable(uint8_t code) {
    return code == 0 || keycodeResolve(code).valid;
}
#endif

#if defined(STORE_STUB_CALIBRATION)
#include "calibration.h"

const char* calStateName(CalState s) {
    switch (s) {
        case CalState::Missing:    return "missing";
        case CalState::Valid:      return "valid";
        case CalState::Invalid:    return "invalid";
        case CalState::InProgress: return "in_progress";
    }
    return "invalid";
}

// Contract section 5: rest in [64, 4031]; range in [300, 4095] with rest +- range inside
// [0, 4095] in the press direction; polarity +-1.
bool calibrationKeyPlausible(const KeyCalibration& k) {
    if (k.restRaw < calib::REST_MIN || k.restRaw > calib::REST_MAX) return false;
    if (k.rangeCounts < calib::RANGE_MIN || k.rangeCounts > 4095) return false;
    if (k.polarity == 1) return (uint32_t)k.restRaw + k.rangeCounts <= 4095;
    if (k.polarity == -1) return k.restRaw >= k.rangeCounts;
    return false;
}

CalState calibrationEvaluate(const CalibrationData& d) {
    if (d.state == (uint8_t)CalState::Missing) return CalState::Missing;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        if (!calibrationKeyPlausible(d.keys[i])) return CalState::Invalid;
    }
    return CalState::Valid;
}

void calibrationClear(CalibrationData& d) {
    memset(&d, 0, sizeof(d));
    d.state = (uint8_t)CalState::Missing;
}
#endif

#if defined(STORE_STUB_HALL)
#include "hall.h"

float HallKey::s_actuationPointMm = 1.20f;
float HallKey::s_rtPressMm        = 0.20f;
float HallKey::s_rtReleaseMm      = 0.20f;
bool  HallKey::s_rtEnabled        = true;
HallKey HallManager::s_keys[NUM_KEYS];
int8_t  HallManager::s_lastActiveKey = -1;

HallKey::HallKey() : _keyIndex(0), _muxChannel(0), _hidKeyCode(0), _label("") {}
#endif

#if defined(STORE_STUB_MUX)
uint16_t muxReadChannel(uint8_t) { return 2048; }
#endif

#if defined(STORE_STUB_KBD_OUTPUT)
#include "keyboard_output.h"
namespace KeyboardOutput {
void init() {}
void setEnabled(bool, Reason) {}
bool isEnabled() { return false; }
Reason reason() { return Reason::DisabledDefault; }
const char* reasonName(Reason) { return "disabled_default"; }
void onPress(uint8_t, uint8_t) {}
void onRelease(uint8_t) {}
void suppressUntilRelease(uint8_t, bool) {}
void releaseAll(uint16_t) {}
void service() {}
uint16_t activeKeysMask() { return 0; }
uint16_t suppressedKeysMask() { return 0; }
Stats stats() { return Stats{ 0, 0, 0, 0, 0 }; }
void currentReport(uint8_t& modifiers, uint8_t usages[6]) {
    modifiers = 0;
    memset(usages, 0, 6);
}
} // namespace KeyboardOutput
#endif
