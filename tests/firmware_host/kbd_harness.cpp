// C ABI for tests/test_keyboard_output.py: drives real key state machines (HallManager with a
// fake mux) into the real arduino-pico Keyboard library over the fake USB stack (usb_fake.cpp).
//
// Built twice:
//   KH_PREFIX_REVISION defined: the pre-fix firmware (hall.cpp of commit e2031e2, which called
//     Keyboard.press/release itself). Used to show that each regression scenario exposes a real
//     defect in the old implementation.
//   otherwise: the current firmware (hall.cpp -> KeyboardOutput -> device HAL -> library).
#include <cstring>
#include "Arduino.h"
#include "hall.h"
#include "pins.h"
#ifdef KH_PREFIX_REVISION
#include <Keyboard.h>
#else
#include "keyboard_output.h"
#endif

extern "C" void host_clock_set_us(uint64_t us);
extern "C" void host_clock_advance_us(uint64_t us);
extern "C" void usbfake_reset();
extern "C" void usbfake_run_task();
extern "C" void usbfake_clear_log();
extern "C" void mux_fake_set(uint8_t channel, uint16_t value);
extern "C" void mux_fake_set_all(uint16_t value);

namespace {
constexpr uint16_t REST_RAW = 2048;
constexpr float COUNTS_PER_MM = 250.0f;   // 1000 counts over the nominal 4.0 mm
}

extern "C" {

int kh_revision() {
#ifdef KH_PREFIX_REVISION
    return 0;
#else
    return 1;
#endif
}

// One 1 kHz scan: the key scan, the output service, then 1 ms passes and the USB task runs
void kh_scan(int n) {
    for (int i = 0; i < n; ++i) {
        HallManager::updateAll();
#ifndef KH_PREFIX_REVISION
        KeyboardOutput::service();
#endif
        host_clock_advance_us(1000);
        usbfake_run_task();
    }
}

void kh_reset() {
    host_clock_set_us(1000000);
    usbfake_reset();
    mux_fake_set_all(REST_RAW);
    HallManager::init();
    HallKey::setActuationPoint(1.20f);
    HallKey::setRtSensitivity(0.20f);
    HallKey::setRapidTrigger(true);
#ifdef KH_PREFIX_REVISION
    Keyboard.begin();
    Keyboard.releaseAll();
    HallManager::setHidEnabled(true);
#else
    KeyboardOutput::init();
    KeyboardOutput::setEnabled(true, KeyboardOutput::Reason::Enabled);
#endif
    kh_scan(40);
    usbfake_clear_log();   // scenarios see only their own reports
}

void kh_set_rt_sens(float mm) { HallKey::setRtSensitivity(mm); }

void kh_set_travel(int key, float mm) {
    float raw = REST_RAW + mm * COUNTS_PER_MM;
    mux_fake_set(KEY_MUX_CHANNELS[key], (uint16_t)(raw + 0.5f));
}

void kh_set_code(int key, int code) { HallManager::getKey((uint8_t)key).setHidKeyCode((uint8_t)code); }
int  kh_is_pressed(int key) { return HallManager::getKey((uint8_t)key).isPressed() ? 1 : 0; }

void kh_set_output(int enabled) {
#ifdef KH_PREFIX_REVISION
    HallManager::setHidEnabled(enabled != 0);
#else
    KeyboardOutput::setEnabled(enabled != 0, enabled ? KeyboardOutput::Reason::Enabled
                                                     : KeyboardOutput::Reason::UserDisabled);
#endif
}

// SIM-style injection: the pre-fix firmware fed it straight into the live state machine
void kh_sim(int key, float mm) {
#ifdef KH_PREFIX_REVISION
    HallManager::getKey((uint8_t)key).injectSimulatedTravel(mm);
#else
    HallManager::simSet((uint8_t)key, mm, millis());
#endif
}

void kh_sim_clear(int key) {
#ifndef KH_PREFIX_REVISION
    HallManager::simClear((uint8_t)key);
#else
    (void)key;
#endif
}

// ---- current revision only -------------------------------------------------------------------
#ifndef KH_PREFIX_REVISION
void kh_release_all() { KeyboardOutput::releaseAll(HallManager::pressedMask()); }
void kh_suppress(int key, int pressedNow) { KeyboardOutput::suppressUntilRelease((uint8_t)key, pressedNow != 0); }
int  kh_active_mask() { return KeyboardOutput::activeKeysMask(); }
int  kh_suppressed_mask() { return KeyboardOutput::suppressedKeysMask(); }
int  kh_pending() { return KeyboardOutput::reportPending() ? 1 : 0; }
int  kh_delivery_state() { return (int)KeyboardOutput::deliveryState(); }

// Desired host state = union of the actions owned by keys: out[0] modifiers, out[1..6] usages
// ascending, zero padded
void kh_desired(uint8_t* out7) {
    uint8_t mods = 0;
    uint8_t usages[NUM_KEYS];
    uint8_t n = 0;
    for (uint8_t k = 0; k < NUM_KEYS; ++k) {
        uint8_t m, u;
        if (!KeyboardOutput::ownedAction(k, m, u)) continue;
        mods |= m;
        if (u == 0) continue;
        bool seen = false;
        for (uint8_t i = 0; i < n; ++i) seen = seen || usages[i] == u;
        if (!seen) usages[n++] = u;
    }
    for (uint8_t i = 0; i < n; ++i)
        for (uint8_t j = i + 1; j < n; ++j)
            if (usages[j] < usages[i]) { uint8_t t = usages[i]; usages[i] = usages[j]; usages[j] = t; }
    memset(out7, 0, 7);
    out7[0] = mods;
    for (uint8_t i = 0; i < n && i < 6; ++i) out7[1 + i] = usages[i];
}

// reportsAttempted, reportsConfirmed, resyncs, overflowBlocked, invalidCode, linkDrops, lostReports
void kh_stats(uint32_t* out7) {
    KeyboardOutput::Stats s = KeyboardOutput::stats();
    out7[0] = s.reportsAttempted;
    out7[1] = s.reportsConfirmed;
    out7[2] = s.resyncs;
    out7[3] = s.overflowBlocked;
    out7[4] = s.invalidCode;
    out7[5] = s.linkDrops;
    out7[6] = s.lostReports;
}
#endif

}
