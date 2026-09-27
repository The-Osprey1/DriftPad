// Fake TinyUSB device stack + USB host for host tests of the keyboard output path.
//
// The firmware code under test and the REAL arduino-pico libraries (libraries/Keyboard,
// libraries/HID_Keyboard) are compiled against the headers in tests/firmware_host/usb_host/.
// This file supplies what those headers declare and models the behaviour that matters:
//
// - One HID IN endpoint. tud_hid_keyboard_report() queues a report only when the endpoint is
//   free and the link is up (mounted, not suspended); the endpoint stays busy until the host
//   polls it. The host polls on a fixed interval (default 1 ms), or never ("stalled").
// - A delivered report replaces the host's view of the keyboard entirely (boot-protocol reports
//   carry full state) and fires tud_hid_report_complete_cb(), as TinyUSB does.
// - Suspend: the host stops polling and, as an OS does across sleep, forgets pressed keys.
//   Unmount / bus reset: the in-flight report is lost and the host forgets pressed keys.
// - USBClass::HIDReady() follows cores/rp2040/USB.cpp: while mounted with a report in flight it
//   waits (up to 500 ms) for the host to poll. Instead of spinning, the fake clock jumps to the
//   next poll or to the timeout, and the time spent is recorded as blocked time.
#include <cstring>
#include <vector>
#include "Arduino.h"
#include "USB.h"
#include "tusb.h"

extern "C" void host_clock_advance_us(uint64_t us);
extern "C" uint64_t host_clock_now_us();

USBClass USB;

namespace {

struct Event {
    uint8_t  kind;          // 1 queued, 2 delivered, 3 lost in flight, 4 host cleared, 5 send refused
    uint8_t  modifiers;
    uint8_t  keys[6];
    uint64_t timeUs;
};

bool     s_mounted = true;
bool     s_suspended = false;
bool     s_hostPolls = true;
uint32_t s_pollIntervalUs = 1000;
bool     s_busy = false;
uint8_t  s_inflight[8];     // modifiers, reserved, keys[6]
uint64_t s_deliverAtUs = 0;
uint8_t  s_hostMods = 0;
uint8_t  s_hostKeys[6];
uint32_t s_queued = 0;
uint32_t s_delivered = 0;
uint32_t s_lost = 0;
uint32_t s_refused = 0;
uint64_t s_blockedUs = 0;
uint8_t  s_nextHidId = 0;
std::vector<Event> s_log;

void logEvent(uint8_t kind, const uint8_t* report8) {
    Event e;
    e.kind = kind;
    e.modifiers = report8 ? report8[0] : 0;
    for (int i = 0; i < 6; ++i) e.keys[i] = report8 ? report8[2 + i] : 0;
    e.timeUs = host_clock_now_us();
    s_log.push_back(e);
}

void hostForget() {
    s_hostMods = 0;
    memset(s_hostKeys, 0, sizeof(s_hostKeys));
    logEvent(4, nullptr);
}

uint64_t nextPollAfter(uint64_t t) {
    uint64_t iv = s_pollIntervalUs ? s_pollIntervalUs : 1;
    return (t / iv + 1) * iv;
}

void deliverIfDue() {
    if (!s_busy || !tud_ready() || !s_hostPolls) return;
    if (host_clock_now_us() < s_deliverAtUs) return;
    s_busy = false;
    s_hostMods = s_inflight[0];
    memcpy(s_hostKeys, s_inflight + 2, 6);
    s_delivered++;
    logEvent(2, s_inflight);
    tud_hid_report_complete_cb(0, s_inflight, 8);
}

} // namespace

// ---- TinyUSB surface -------------------------------------------------------------------------

void tud_task() { deliverIfDue(); }
bool tud_mounted() { return s_mounted; }
bool tud_suspended() { return s_suspended; }
bool tud_ready() { return s_mounted && !s_suspended; }
bool tud_hid_ready() { return tud_ready() && !s_busy; }

bool tud_hid_keyboard_report(uint8_t, uint8_t modifier, const uint8_t keycode[6]) {
    if (!tud_hid_ready()) {
        s_refused++;
        logEvent(5, nullptr);
        return false;
    }
    s_inflight[0] = modifier;
    s_inflight[1] = 0;
    memcpy(s_inflight + 2, keycode, 6);
    s_busy = true;
    s_deliverAtUs = nextPollAfter(host_clock_now_us());
    s_queued++;
    logEvent(1, s_inflight);
    return true;
}

bool tud_hid_report(uint8_t, const void*, uint16_t) { return true; }   // consumer reports: unused

// ---- USBClass surface ------------------------------------------------------------------------

uint8_t USBClass::registerHIDDevice(const uint8_t*, size_t, int, uint32_t) { return s_nextHidId++; }
void USBClass::unregisterHIDDevice(unsigned int) {}
uint8_t USBClass::findHIDReportID(unsigned int localid) { return (uint8_t)(localid + 1); }
void USBClass::disconnect() {}
void USBClass::connect() {}

bool USBClass::HIDReady() {
    const uint64_t timeoutUs = 500000;
    uint64_t start = host_clock_now_us();
    tud_task();
    if (tud_ready() && s_busy) {
        uint64_t until = start + timeoutUs;
        if (s_hostPolls && s_deliverAtUs < until) until = s_deliverAtUs;
        if (until > host_clock_now_us()) {
            uint64_t wait = until - host_clock_now_us();
            s_blockedUs += wait;
            host_clock_advance_us(wait);
        }
        tud_task();
    }
    return tud_hid_ready();
}

// ---- Test control (C ABI) --------------------------------------------------------------------

extern "C" {

void usbfake_reset() {
    s_mounted = true;
    s_suspended = false;
    s_hostPolls = true;
    s_pollIntervalUs = 1000;
    s_busy = false;
    memset(s_inflight, 0, sizeof(s_inflight));
    s_deliverAtUs = 0;
    s_hostMods = 0;
    memset(s_hostKeys, 0, sizeof(s_hostKeys));
    s_queued = s_delivered = s_lost = s_refused = 0;
    s_blockedUs = 0;
    s_log.clear();
}

void usbfake_set_host_polls(int polls) { s_hostPolls = polls != 0; }
void usbfake_set_poll_interval_us(uint32_t us) { s_pollIntervalUs = us ? us : 1; }

// Advances time to let the host poll a pending report (as the USB IRQ task would)
void usbfake_run_task() { tud_task(); }

void usbfake_suspend() {
    if (!s_suspended) {
        s_suspended = true;
        hostForget();
    }
}

void usbfake_resume() { s_suspended = false; }

void usbfake_unmount() {
    if (s_busy) {
        s_busy = false;
        s_lost++;
        logEvent(3, s_inflight);
    }
    s_mounted = false;
    hostForget();
}

void usbfake_mount() { s_mounted = true; }

// The in-flight transfer ends with an error (TinyUSB reports it through tud_hid_report_failed_cb)
void usbfake_fail_inflight() {
    if (!s_busy) return;
    s_busy = false;
    s_lost++;
    logEvent(3, s_inflight);
    tud_hid_report_failed_cb(0, HID_REPORT_TYPE_INPUT, s_inflight, 0);
}

// Host's view: out[0] = modifiers, out[1..6] = keys (report order)
void usbfake_host_state(uint8_t* out7) {
    out7[0] = s_hostMods;
    memcpy(out7 + 1, s_hostKeys, 6);
}

int usbfake_busy() { return s_busy ? 1 : 0; }

// counters: queued, delivered, lost, refused, blocked_us (low 32 bits)
void usbfake_counters(uint32_t* out5) {
    out5[0] = s_queued;
    out5[1] = s_delivered;
    out5[2] = s_lost;
    out5[3] = s_refused;
    out5[4] = (uint32_t)s_blockedUs;
}

int usbfake_log_len() { return (int)s_log.size(); }

// out: kind, modifiers, keys[6] (8 bytes)
void usbfake_log_entry(int i, uint8_t* out8) {
    const Event& e = s_log[(size_t)i];
    out8[0] = e.kind;
    out8[1] = e.modifiers;
    memcpy(out8 + 2, e.keys, 6);
}

void usbfake_clear_log() { s_log.clear(); }

}
