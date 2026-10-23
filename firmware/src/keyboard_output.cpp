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
// Delivery (see keyboard_output.h): every library call that can send is counted as an attempt;
// the attempts are confirmed only by TinyUSB's transfer-complete count. The full state is re-sent
// with Keyboard.release(136): code 136 is usage 0, so release() clears nothing and then sends the
// current report unchanged (HID_Keyboard.cpp, release()).

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

// Delivery bookkeeping
bool     s_awaiting = false;         // attempts made that are not confirmed yet
uint32_t s_expectDelivered = 0;      // delivered count at which every attempt is confirmed
uint32_t s_attemptsAwaiting = 0;
uint32_t s_dropsAtAttempt = 0;       // link-down count when the unconfirmed batch started
uint32_t s_failedAtAttempt = 0;
uint32_t s_dropsSeen = 0;
bool     s_pending = false;          // host may be out of date: full-state re-send due

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

// Brackets one library call. The expected delivered count includes a report still in flight from
// before the batch (the endpoint holds one at a time, and the library call waits for it).
void beginAttempt() {
    uint32_t drops = hidLinkDownCount();
    if (!s_awaiting) {
        s_expectDelivered = hidDeliveredCount() + (hidEndpointFree() ? 0u : 1u);
        s_dropsAtAttempt = drops;
        s_failedAtAttempt = hidFailedCount();
        s_attemptsAwaiting = 0;
    }
}

void endAttempt(bool attempted) {
    if (attempted) {
        s_awaiting = true;
        s_expectDelivered++;
        s_attemptsAwaiting++;
        s_stats.reportsAttempted++;
    }
    if (!hidLinkUp()) {
        s_pending = true;   // the library skipped the send: HIDReady() is false without a link
    }
}

void libraryPress(uint8_t code) {
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
    beginAttempt();
    // With all 6 usage slots taken, HID_Keyboard::press(128 + bit) sets the modifier but returns 0
    // before sendReport() (usage 0 is "not present" and there is no free slot for it). Push the
    // report out explicitly so the modifier is not left unsent.
    bool attempted = hidPress(code) || hidRelease(RESEND_CODE);
    endAttempt(attempted);
}

void libraryRelease(uint8_t code) {
    if (code >= RAW_USAGE_BASE) {
        uint8_t usage = (uint8_t)(code - RAW_USAGE_BASE);
        for (uint8_t i = 0; i < MAX_USAGES; ++i) {
            if (s_libKeys[i] == usage) s_libKeys[i] = 0;
        }
    } else {
        s_libModifiers &= (uint8_t)~(1u << (code - RAW_MODIFIER_BASE));
    }
    beginAttempt();
    endAttempt(hidRelease(code));
}

void libraryReleaseAll() {
    s_libModifiers = 0;
    for (uint8_t i = 0; i < MAX_USAGES; ++i) s_libKeys[i] = 0;
    beginAttempt();
    hidReleaseAll();
    endAttempt(true);
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
    }
    s_libModifiers = 0;
    s_awaiting = false;
    s_attemptsAwaiting = 0;
    s_pending = false;
    s_stats = Stats{0, 0, 0, 0, 0, 0, 0};

    hidInit();
    s_dropsSeen = hidLinkDownCount();
    libraryReleaseAll();   // the host starts from an empty report (re-sent once USB is up)
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
    uint32_t drops = hidLinkDownCount();
    if (s_awaiting) {
        if (drops != s_dropsAtAttempt || hidFailedCount() != s_failedAtAttempt) {
            // The link went down or a transfer failed with reports unconfirmed
            s_awaiting = false;
            s_pending = true;
            s_stats.lostReports += s_attemptsAwaiting;
        } else if ((int32_t)(hidDeliveredCount() - s_expectDelivered) >= 0) {
            s_awaiting = false;
            s_stats.reportsConfirmed += s_attemptsAwaiting;
        } else if (hidEndpointFree()) {
            // Idle with deliveries missing: the library skipped a send (its HIDReady() timed out)
            s_awaiting = false;
            s_pending = true;
            s_stats.lostReports += s_attemptsAwaiting;
        }
    }
    if (drops != s_dropsSeen) {
        // The host may have forgotten pressed keys (suspend, re-enumeration)
        s_stats.linkDrops += drops - s_dropsSeen;
        s_dropsSeen = drops;
        s_pending = true;
    }
    if (s_pending && !s_awaiting && hidEndpointFree()) {
        s_pending = false;
        beginAttempt();
        endAttempt(hidRelease(RESEND_CODE));
        s_stats.resyncs++;
    }
}

Delivery deliveryState() {
    if (s_pending) return Delivery::Pending;
    if (s_awaiting) return Delivery::InFlight;
    return Delivery::Confirmed;
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
    modifiers = s_libModifiers;
    for (uint8_t i = 0; i < MAX_USAGES; ++i) usages[i] = s_libKeys[i];
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
