#ifndef KEYBOARD_OUTPUT_H
#define KEYBOARD_OUTPUT_H

#include <cstdint>

/**
 * @file keyboard_output.h
 * @brief Ownership model between physical keys and the USB keyboard report.
 *
 * Ownership
 * - A physical key captures its HID action (modifiers + usage) when it is pressed and releases
 *   exactly that action, whatever the keymap says by then (remap, layer change, RESET).
 * - Usages and modifier bits are reference counted, so duplicate outputs (two keys -> Down) and
 *   shared modifiers (a Shift key plus a key whose character implies Shift) stay down until the
 *   last owner releases them.
 * - At most 6 distinct usages (arduino-pico report size). A press that would need a 7th is blocked
 *   for that press, modifiers included: nothing is sent, now or later, and its release sends
 *   nothing. Modifier-only actions need no slot and never overflow.
 * - Enabling output never presses keys that are already held; they are suppressed until released.
 *
 * Delivery and reconciliation
 * - The desired host state is the union of the actions keys own. Every HID report carries that
 *   full state, so re-sending it is harmless.
 * - An attempted report is not assumed to reach the host. It is confirmed only when the TinyUSB
 *   transfer-complete count reaches it while the link stays up. It is presumed lost when the link
 *   drops (unmount, suspend, bus reset), when a transfer fails, or when the endpoint is idle again
 *   without the delivery having been counted (the library skipped the send).
 * - Any presumed loss, and any link drop even with nothing in flight (a sleeping host forgets
 *   pressed keys), makes the full current state pending. service() re-sends it as soon as the link
 *   is up and the endpoint is free, and then waits for its confirmation in turn.
 * - service() never blocks. The library calls made on key edges may block while the previous
 *   report waits for the host (bounded by the library's 500 ms HIDReady() timeout).
 *
 * Core 0 only. Not thread safe.
 */
namespace KeyboardOutput {

enum class Reason : uint8_t {
    Enabled = 0,
    DisabledDefault,        // prototype safety: not enabled at boot
    CalibrationMissing,
    CalibrationInvalid,
    CalibrationInProgress,
    UserDisabled,
    Forced,                 // enabled with FORCE while calibration is not valid
};

enum class Delivery : uint8_t {
    Confirmed = 0,          // the host has collected the last report (or nothing was ever sent)
    InFlight,               // attempted, not yet confirmed
    Pending,                // the host may be out of date; a full-state re-send is due
};

struct Stats {
    uint32_t reportsAttempted;   // library calls that could send a report (includes re-sends)
    uint32_t reportsConfirmed;   // attempts later confirmed by the transfer-complete count
    uint32_t resyncs;            // full-state re-sends made by service()
    uint32_t overflowBlocked;    // presses blocked by the 6-usage limit
    uint32_t invalidCode;        // presses whose captured code resolved to nothing
    uint32_t linkDrops;          // link down events seen
    uint32_t lostReports;        // attempts presumed lost (never collected)
};

void init();

// Enabling suppresses every key that is currently pressed until it is released.
// Disabling releases everything. `reason` is reported by INFO/STATUS.
void setEnabled(bool enabled, Reason reason);
bool isEnabled();
Reason reason();
const char* reasonName(Reason r);

// Physical key edges from HallManager. `code` is the Arduino key code mapped to the key at the
// moment of the press; it is captured and used again on release.
void onPress(uint8_t physKey, uint8_t code);
void onRelease(uint8_t physKey);

// The key produces no output until it is released. pressedNow = true (held at boot, leaving SIM):
// the suppression lasts until the key is seen at rest (onAtRest), surviving Rapid Trigger release
// edges in mid-stroke. pressedNow = false: it ends at the key's next release edge.
void suppressUntilRelease(uint8_t physKey, bool pressedNow);

// HallManager reports a key that is released and inside the top dead zone.
void onAtRest(uint8_t physKey);

// Releases every owned output (host sees all keys up) and forgets the captures. Keys that are
// physically pressed at that moment are suppressed until their release.
void releaseAll(uint16_t pressedMask);

// Delivery bookkeeping and full-state re-send. Call every loop; never blocks.
void service();

Delivery deliveryState();
bool reportPending();            // deliveryState() == Pending

uint16_t activeKeysMask();       // physical keys that currently own an output
uint16_t suppressedKeysMask();
uint16_t pressedKeysMask();      // keys that are down according to the edges received
Stats stats();

// The action a key captured at its press, if it currently owns one.
bool ownedAction(uint8_t physKey, uint8_t& modifiers, uint8_t& usage);

// The report the library will send next (the last attempted state). Whether the host has it is
// deliveryState().
void currentReport(uint8_t& modifiers, uint8_t usages[6]);

} // namespace KeyboardOutput

#endif // KEYBOARD_OUTPUT_H
