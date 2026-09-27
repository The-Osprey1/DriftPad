#ifndef KEYBOARD_OUTPUT_H
#define KEYBOARD_OUTPUT_H

#include <cstdint>

/**
 * @file keyboard_output.h
 * @brief Ownership model between physical keys and the USB keyboard report.
 *
 * - A physical key captures its HID action (modifiers + usage) when it is pressed and releases
 *   exactly that action, whatever the keymap says by then.
 * - Usages and modifier bits are reference counted, so duplicate outputs and shared modifiers stay
 *   down until the last owner releases them.
 * - At most 6 distinct usages (arduino-pico report size). A press that would need a 7th is blocked
 *   for that press: nothing is sent, now or later, and its release sends nothing.
 * - Enabling output never presses keys that are already held; they are suppressed until released.
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

struct Stats {
    uint32_t reportsSent;        // library calls that reached a ready HID interface
    uint32_t reportsDeferred;    // changes made while HID was not ready (re-sent later)
    uint32_t resyncs;            // deferred reports re-sent by service()
    uint32_t overflowBlocked;    // presses blocked by the 6-usage limit
    uint32_t invalidCode;        // presses whose captured code resolved to nothing
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

// The key's next press produces no output; cleared by the key's next release (or immediately
// if the key is not pressed and `pressedNow` is false).
void suppressUntilRelease(uint8_t physKey, bool pressedNow);

// Releases every owned output (host sees all keys up) and forgets the captures. Keys that are
// physically pressed at that moment are suppressed until their release.
void releaseAll(uint16_t pressedMask);

// Re-sends the current report if an earlier change could not be delivered. Call every loop.
void service();

uint16_t activeKeysMask();       // physical keys that currently own an output
uint16_t suppressedKeysMask();
Stats stats();

// Host-visible report as the firmware believes it was last delivered.
void currentReport(uint8_t& modifiers, uint8_t usages[6]);

// ---- Additions (S1) ------------------------------------------------------------------------

// HallManager reports a key that is released and physically at rest (travel within the top
// dead zone). Clears any suppression of a key that is not pressed. This is what ends a
// suppressUntilRelease(key, pressedNow=true): such a suppression survives the key's release
// edges (a Rapid Trigger release happens mid-stroke) and lasts until the key is seen at rest,
// so a key that was physically held cannot fire. A suppression set for a key this module
// already knew to be pressed (pressedNow=false, setEnabled(true), releaseAll()) also ends at
// its next release edge, as documented above.
void onAtRest(uint8_t physKey);

// True while a change has not reached the host yet (HID not ready); service() re-sends it.
bool reportPending();

// Keys that are down according to the edges received (whether or not they own an output).
uint16_t pressedKeysMask();

// The action a key captured at its press, if it currently owns one.
bool ownedAction(uint8_t physKey, uint8_t& modifiers, uint8_t& usage);

} // namespace KeyboardOutput

#endif // KEYBOARD_OUTPUT_H
