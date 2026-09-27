#include "keyboard_output.h"
#include "keyboard_output_hal.h"
#include "keycodes.h"
#include "pins.h"

// Ownership between physical keys and the USB keyboard report (see keyboard_output.h).
//
// The library is only ever driven with raw codes (136 + usage, 128 + modifier bit), so its
// ASCII map and its implicit Shift/AltGr handling never apply: HID_Keyboard::release('A') would
// clear left shift even while a Shift key is held. Reference counts decide when a usage or a
// modifier bit is pressed (first owner) or released (last owner).
//
// Delivery: arduino-pico drops a report silently when USB.HIDReady() is false but keeps the
// change in its internal report. Readiness is checked through the HAL before every library call;
// a change made while not ready marks the report pending and service() re-sends the full current
// report later with Keyboard.release(136). Code 136 is usage 0: release() clears nothing, then
// sends the report unchanged (HID_Keyboard.cpp, release()), so it is a pure "send again".

namespace KeyboardOutput {
namespace {

constexpr uint8_t MAX_USAGES        = 6;     // arduino-pico KeyReport.keys[6]
constexpr uint8_t RAW_USAGE_BASE    = 136;   // press(136 + usage): usage, no ASCII map
constexpr uint8_t RAW_MODIFIER_BASE = 128;   // press(128 + bit): modifier bit
constexpr uint8_t RESEND_CODE       = RAW_USAGE_BASE;   // release(136): re-send current report
constexpr uint16_t ALL_KEYS = (uint16_t)((1u << NUM_KEYS) - 1);

bool   s_enabled = false;
Reason s_reason = Reason::DisabledDefault;

// Per physical key (bit i = key i)
uint16_t  s_pressedMask = 0;       // down, from HallManager edges
uint16_t  s_ownedMask = 0;         // its captured action is part of the report
uint16_t  s_softSuppressed = 0;    // no output until its next release edge (or seen at rest)
uint16_t  s_hardSuppressed = 0;    // no output until seen at rest (pressedNow = true)
HidAction s_captured[NUM_KEYS];

// Reference counts. At most MAX_USAGES distinct usages are ever owned (the rollover rule), so a
// small table replaces a 256-entry array; count 0 marks a free entry.
uint8_t s_modifierRefs[8];
struct UsageRef {
    uint8_t usage;
    uint8_t count;
};
UsageRef s_usageRefs[MAX_USAGES];

// Mirror of the library's internal KeyReport: what the next report will contain, including the
// slot order (the library fills the first free slot).
uint8_t s_libModifiers = 0;
uint8_t s_libKeys[MAX_USAGES];

// The report as last delivered to the host
uint8_t s_hostModifiers = 0;
uint8_t s_hostKeys[MAX_USAGES];
bool    s_pending = false;

Stats s_stats;

uint8_t usageRefCount(uint8_t usage) {
    for (uint8_t i = 0; i < MAX_USAGES; ++i) {
        if (s_usageRefs[i].count != 0 && s_usageRefs[i].usage == usage) return s_usageRefs[i].count;
    }
    return 0;
}

uint8_t distinctUsages() {
    uint8_t n = 0;
    for (uint8_t i = 0; i < MAX_USAGES; ++i) {
        if (s_usageRefs[i].count != 0) ++n;
    }
    return n;
}

// Returns the new count (1 = first owner)
uint8_t usageRefAdd(uint8_t usage) {
    for (uint8_t i = 0; i < MAX_USAGES; ++i) {
        if (s_usageRefs[i].count != 0 && s_usageRefs[i].usage == usage) return ++s_usageRefs[i].count;
    }
    for (uint8_t i = 0; i < MAX_USAGES; ++i) {
        if (s_usageRefs[i].count == 0) {
            s_usageRefs[i].usage = usage;
            s_usageRefs[i].count = 1;
            return 1;
        }
    }
    return 0;   // unreachable: callers check the rollover limit first
}

// Returns the remaining count (0 = last owner gone)
uint8_t usageRefRemove(uint8_t usage) {
    for (uint8_t i = 0; i < MAX_USAGES; ++i) {
        if (s_usageRefs[i].count != 0 && s_usageRefs[i].usage == usage) return --s_usageRefs[i].count;
    }
    return 0;
}

void copyLibraryToHost() {
    s_hostModifiers = s_libModifiers;
    for (uint8_t i = 0; i < MAX_USAGES; ++i) s_hostKeys[i] = s_libKeys[i];
}

// Accounts for one library call. `ready` is the readiness checked just before it; `sent` is
// whether the library attempted a report at all.
void accountReport(bool ready, bool sent) {
    if (ready && sent) {
        copyLibraryToHost();
        s_pending = false;
        s_stats.reportsSent++;
    } else {
        s_pending = true;
        s_stats.reportsDeferred++;
    }
}

void libraryPress(uint8_t code) {
    bool ready = hidReady();
    if (code >= RAW_USAGE_BASE) {
        uint8_t usage = (uint8_t)(code - RAW_USAGE_BASE);
        for (uint8_t i = 0; i < MAX_USAGES; ++i) {
            if (s_libKeys[i] == 0) {
                s_libKeys[i] = usage;
                break;
            }
        }
    } else {
        s_libModifiers |= (uint8_t)(1u << (code - RAW_MODIFIER_BASE));
    }
    // With all 6 usage slots taken, HID_Keyboard::press(128 + bit) sets the modifier but returns 0
    // before sendReport() (usage 0 is "not present" and there is no free slot for it). Push the
    // report out explicitly so the modifier is not left unsent.
    bool sent = hidPress(code) || hidRelease(RESEND_CODE);
    accountReport(ready, sent);
}

void libraryRelease(uint8_t code) {
    bool ready = hidReady();
    if (code >= RAW_USAGE_BASE) {
        uint8_t usage = (uint8_t)(code - RAW_USAGE_BASE);
        for (uint8_t i = 0; i < MAX_USAGES; ++i) {
            if (s_libKeys[i] == usage) s_libKeys[i] = 0;
        }
    } else {
        s_libModifiers &= (uint8_t)~(1u << (code - RAW_MODIFIER_BASE));
    }
    bool sent = hidRelease(code);
    accountReport(ready, sent);
}

void libraryReleaseAll() {
    bool ready = hidReady();
    s_libModifiers = 0;
    for (uint8_t i = 0; i < MAX_USAGES; ++i) s_libKeys[i] = 0;
    hidReleaseAll();
    accountReport(ready, true);
}

void releaseOwned(uint8_t physKey) {
    uint16_t bit = (uint16_t)(1u << physKey);
    if (!(s_ownedMask & bit)) return;
    s_ownedMask &= (uint16_t)~bit;
    const HidAction& a = s_captured[physKey];
    // Key up before its modifiers, the order a host expects from a real keyboard
    if (a.usage != 0 && usageRefRemove(a.usage) == 0) {
        libraryRelease((uint8_t)(RAW_USAGE_BASE + a.usage));
    }
    for (uint8_t b = 0; b < 8; ++b) {
        if ((a.modifiers & (1u << b)) && s_modifierRefs[b] > 0 && --s_modifierRefs[b] == 0) {
            libraryRelease((uint8_t)(RAW_MODIFIER_BASE + b));
        }
    }
}

// Releases everything in one library report and forgets every capture
void releaseEverything() {
    s_ownedMask = 0;
    for (uint8_t b = 0; b < 8; ++b) s_modifierRefs[b] = 0;
    for (uint8_t i = 0; i < MAX_USAGES; ++i) s_usageRefs[i] = UsageRef{0, 0};
    libraryReleaseAll();
}

} // namespace

void init() {
    s_enabled = false;
    s_reason = Reason::DisabledDefault;
    s_pressedMask = 0;
    s_ownedMask = 0;
    s_softSuppressed = 0;
    s_hardSuppressed = 0;
    for (uint8_t k = 0; k < NUM_KEYS; ++k) s_captured[k] = HidAction{0, 0, false};
    for (uint8_t b = 0; b < 8; ++b) s_modifierRefs[b] = 0;
    for (uint8_t i = 0; i < MAX_USAGES; ++i) {
        s_usageRefs[i] = UsageRef{0, 0};
        s_libKeys[i] = 0;
        s_hostKeys[i] = 0;
    }
    s_libModifiers = 0;
    s_hostModifiers = 0;
    s_pending = false;
    s_stats = Stats{0, 0, 0, 0, 0};

    hidInit();
    libraryReleaseAll();   // the host starts from an empty report (deferred if USB is not up yet)
}

void setEnabled(bool enabled, Reason reason) {
    s_reason = reason;
    if (enabled == s_enabled) return;
    s_enabled = enabled;
    if (!enabled) {
        releaseEverything();
    } else {
        // Keys already down never press on enable; they wait for their own release
        s_softSuppressed |= s_pressedMask;
    }
}

bool isEnabled() {
    return s_enabled;
}

Reason reason() {
    return s_reason;
}

const char* reasonName(Reason r) {
    switch (r) {
        case Reason::Enabled:               return "enabled";
        case Reason::DisabledDefault:       return "disabled_default";
        case Reason::CalibrationMissing:    return "calibration_missing";
        case Reason::CalibrationInvalid:    return "calibration_invalid";
        case Reason::CalibrationInProgress: return "calibration_in_progress";
        case Reason::UserDisabled:          return "user_disabled";
        case Reason::Forced:                return "forced";
    }
    return "unknown";
}

void onPress(uint8_t physKey, uint8_t code) {
    if (physKey >= NUM_KEYS) return;
    uint16_t bit = (uint16_t)(1u << physKey);
    if (s_pressedMask & bit) return;   // edges alternate; a repeated press changes nothing
    s_pressedMask |= bit;

    if (!s_enabled || ((s_softSuppressed | s_hardSuppressed) & bit)) return;

    HidAction a = keycodeResolve(code);
    if (!a.valid) {
        if (code != 0) s_stats.invalidCode++;   // code 0 is "None": assigned to do nothing
        return;
    }
    // Rollover: a 7th distinct usage is blocked for this whole press, modifiers included, and is
    // never sent later. Actions that only carry modifiers need no slot and never overflow.
    if (a.usage != 0 && usageRefCount(a.usage) == 0 && distinctUsages() >= MAX_USAGES) {
        s_stats.overflowBlocked++;
        return;
    }

    s_captured[physKey] = a;
    s_ownedMask |= bit;
    // Modifiers before the key, so the host applies them to it
    for (uint8_t b = 0; b < 8; ++b) {
        if ((a.modifiers & (1u << b)) && s_modifierRefs[b]++ == 0) {
            libraryPress((uint8_t)(RAW_MODIFIER_BASE + b));
        }
    }
    if (a.usage != 0 && usageRefAdd(a.usage) == 1) {
        libraryPress((uint8_t)(RAW_USAGE_BASE + a.usage));
    }
}

void onRelease(uint8_t physKey) {
    if (physKey >= NUM_KEYS) return;
    uint16_t bit = (uint16_t)(1u << physKey);
    s_pressedMask &= (uint16_t)~bit;
    s_softSuppressed &= (uint16_t)~bit;
    releaseOwned(physKey);
}

void onAtRest(uint8_t physKey) {
    if (physKey >= NUM_KEYS) return;
    uint16_t bit = (uint16_t)(1u << physKey);
    if (s_pressedMask & bit) return;
    s_softSuppressed &= (uint16_t)~bit;
    s_hardSuppressed &= (uint16_t)~bit;
}

void suppressUntilRelease(uint8_t physKey, bool pressedNow) {
    if (physKey >= NUM_KEYS) return;
    uint16_t bit = (uint16_t)(1u << physKey);
    releaseOwned(physKey);
    if (pressedNow) {
        s_hardSuppressed |= bit;
    } else if (s_pressedMask & bit) {
        s_softSuppressed |= bit;
    }
}

void releaseAll(uint16_t pressedMask) {
    releaseEverything();
    s_softSuppressed |= (uint16_t)((pressedMask | s_pressedMask) & ALL_KEYS);
}

void service() {
    if (hidTakeResumed()) {
        s_pending = true;   // the host may have dropped key state while the link was down
    }
    if (!s_pending || !hidReady()) return;
    if (hidRelease(RESEND_CODE)) {
        copyLibraryToHost();
        s_pending = false;
        s_stats.resyncs++;
        s_stats.reportsSent++;
    }
}

uint16_t activeKeysMask() {
    return s_ownedMask;
}

uint16_t suppressedKeysMask() {
    return (uint16_t)(s_softSuppressed | s_hardSuppressed);
}

Stats stats() {
    return s_stats;
}

void currentReport(uint8_t& modifiers, uint8_t usages[6]) {
    modifiers = s_hostModifiers;
    for (uint8_t i = 0; i < MAX_USAGES; ++i) usages[i] = s_hostKeys[i];
}

bool reportPending() {
    return s_pending;
}

uint16_t pressedKeysMask() {
    return s_pressedMask;
}

bool ownedAction(uint8_t physKey, uint8_t& modifiers, uint8_t& usage) {
    if (physKey >= NUM_KEYS || !(s_ownedMask & (1u << physKey))) return false;
    modifiers = s_captured[physKey].modifiers;
    usage = s_captured[physKey].usage;
    return true;
}

} // namespace KeyboardOutput
