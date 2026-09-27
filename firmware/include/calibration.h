#ifndef CALIBRATION_H
#define CALIBRATION_H

#include <cstdint>
#include "pins.h"

/**
 * @file calibration.h
 * @brief Calibration data, plausibility rules, boot-time restore and guided calibration.
 *
 * Travel derived from calibration is an estimate (linear over the measured bottom-out range onto
 * a nominal 4.0 mm). It is not a physically validated distance.
 */

enum class CalState : uint8_t {
    Missing    = 0,   // never calibrated, or cleared by RESET ALL
    Valid      = 1,
    Invalid    = 2,   // stored data failed plausibility
    InProgress = 3,   // runtime only, never persisted
};

struct KeyCalibration {
    uint16_t restRaw;      // ADC counts at rest
    uint16_t rangeCounts;  // |bottom-out - rest| in ADC counts
    int8_t   polarity;     // +1 raw rises when pressed, -1 falls, 0 unknown
    uint8_t  flags;        // reserved, 0
};

struct CalibrationData {
    uint8_t        state;      // CalState
    uint8_t        reserved[3];
    KeyCalibration keys[NUM_KEYS];
};

namespace calib {
constexpr uint16_t REST_MIN           = 64;
constexpr uint16_t REST_MAX           = 4031;
constexpr uint16_t RANGE_MIN          = 300;
constexpr uint16_t RAIL_LOW           = 16;
constexpr uint16_t RAIL_HIGH          = 4079;
constexpr uint16_t REST_NOISE_P2P_MAX = 120;
constexpr uint16_t REST_PHASE_MS      = 500;
constexpr uint32_t INACTIVITY_TIMEOUT_MS = 120000;
constexpr uint16_t BOOT_SAMPLES       = 64;

// ---- Additions (S1), documented in calibration.cpp ----
constexpr uint16_t ADC_MAX               = 4095;  // 12-bit ADC full scale
constexpr uint16_t TOLERANCE_MIN_COUNTS  = 40;    // rest tolerance floor (boot, CALIBRATE, travel return)
constexpr uint16_t TOLERANCE_RANGE_PCT   = 5;     // ... or this share of the key's range, if larger
constexpr uint16_t REST_MIN_SAMPLES      = 100;   // REST phase lasts until this many scans too
constexpr uint16_t ACTIVITY_COUNTS       = TOLERANCE_MIN_COUNTS;  // travel-phase movement that resets the inactivity timer
} // namespace calib

// Rest tolerance for a key with this range: max(TOLERANCE_MIN_COUNTS, range * 5 / 100).
uint16_t calibrationTolerance(uint16_t rangeCounts);

const char* calStateName(CalState s);
bool calibrationKeyPlausible(const KeyCalibration& k);
// Returns Valid when all keys are plausible, Invalid when any key is not, Missing if state says so.
CalState calibrationEvaluate(const CalibrationData& d);
void calibrationClear(CalibrationData& d);   // -> Missing, keys zeroed

// Result of restoring calibration at power-up.
struct BootReport {
    CalState state;
    uint16_t heldMask;     // keys held at boot: stored rest kept, output suppressed until released
    uint16_t driftMask;    // rest moved away from the press direction beyond tolerance (adopted)
    uint16_t faultMask;    // railed sensor readings: no output from these keys
    uint16_t adoptedMask;  // rest re-measured within tolerance and adopted
};

namespace Calibration {

// Applies stored calibration to HallManager's keys using a fresh rest measurement.
// When `stored` is not Valid, falls back to the legacy behaviour (zero at the current reading,
// polarity auto-detect) and reports the state.
BootReport applyAtBoot(const CalibrationData& stored, const uint16_t measuredRest[NUM_KEYS]);

// Applies calibration while running (after CAL FINISH or REVERT): rest/polarity/range into every
// key, state machines reset to released, filters seeded from `currentRaw`. Returns the keys that
// are off-rest right now; the caller suppresses their keyboard output until they are released.
// A Missing/Invalid `d` leaves the running baselines untouched and returns 0.
uint16_t applyRuntime(const CalibrationData& d, const uint16_t currentRaw[NUM_KEYS]);

// Legacy CALIBRATE: re-zero rest baselines from `measuredRest` while keeping polarity and range.
// Fails (returns false, sets offRestMask) if any key is off-rest by more than the boot tolerance
// in the press direction relative to the current calibration.
bool quickRestRecalibrate(CalibrationData& data, const uint16_t measuredRest[NUM_KEYS], uint16_t& offRestMask);

enum class Phase : uint8_t { Idle = 0, Rest, Travel, Done, Failed, Cancelled };

struct Progress {
    Phase    phase;
    uint16_t restOkMask;
    uint16_t restFailedMask;
    uint16_t travelDoneMask;
    uint32_t elapsedMs;
};

const char* phaseName(Phase p);

// Starts guided calibration (caller must release keyboard output first). Returns false if busy.
bool begin(uint32_t nowMs);
bool isActive();
// Feed every scan while active.
void onScan(const uint16_t raw[NUM_KEYS], uint32_t nowMs);
Progress progress();
// True once an event line should be emitted for a phase or key change since the last call.
bool takeEvent();
// Completes calibration into `out` (state Valid). Returns false and leaves `out` untouched with
// missingMask set if any key has not finished the travel phase.
bool finish(CalibrationData& out, uint16_t& missingMask);
void cancel();

// ---- Additions (S1) ----
// Back to Idle, dropping any session without an event (host tests; optional after a finished
// session has been reported).
void reset();

} // namespace Calibration

#endif // CALIBRATION_H
