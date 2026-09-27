#include "calibration.h"
#include "hall.h"

// Calibration lifecycle (contract section 5).
//
// Constants (calibration.h, namespace calib):
//   REST_MIN / REST_MAX (64 / 4031)   plausible rest reading: 64 counts clear of either ADC rail
//   RANGE_MIN (300)                   smallest bottom-out excursion accepted: 0.30 of the nominal
//                                     1000-count swing, well above EMI (20 counts) and rest noise
//   RAIL_LOW / RAIL_HIGH (16 / 4079)  a reading beyond these is a railed (shorted/open) sensor
//   REST_NOISE_P2P_MAX (120)          guided REST phase: peak-to-peak noise allowed at rest (60 Hz
//                                     EMI of 20 counts amplitude plus thermal noise, with margin)
//   REST_PHASE_MS (500)               guided REST phase length (30 cycles of 60 Hz EMI)
//   REST_MIN_SAMPLES (100)            ...and at least this many scans, in case scanning stalled
//   INACTIVITY_TIMEOUT_MS (120000)    guided TRAVEL phase gives up after 2 minutes without movement
//   ACTIVITY_COUNTS (40)              movement off rest that counts as activity (= tolerance floor)
//   BOOT_SAMPLES (64)                 sweeps averaged for the boot rest measurement
//   TOLERANCE_MIN_COUNTS (40)         rest tolerance floor: 0.16 mm on a 1000-count key, twice
//                                     the 60 Hz EMI amplitude
//   TOLERANCE_RANGE_PCT (5)           rest tolerance as a share of the key's range, if larger
//
// Plausibility checks the bottom-out point in the key's press direction: rest + polarity * range
// must lie inside [0, ADC_MAX] (a falling sensor at rest 3000 with a 1500-count range is fine).
//
// Nothing here touches KeyboardOutput. Whoever calls applyAtBoot/applyRuntime/quickRestRecalibrate
// or runs the guided procedure releases and suppresses keyboard output around it (see the
// integration notes); HallManager reconciles the reset state machines on its next scan.

namespace {

constexpr uint16_t ALL_KEYS = (uint16_t)((1u << NUM_KEYS) - 1);

bool isRailed(uint16_t raw) {
    return raw < calib::RAIL_LOW || raw > calib::RAIL_HIGH;
}

// Signed deviation of `raw` from `rest` in the press direction (> 0 = pressed further)
int32_t pressDeviation(uint16_t raw, uint16_t rest, int8_t polarity) {
    return ((int32_t)raw - (int32_t)rest) * (int32_t)polarity;
}

int32_t absI32(int32_t v) {
    return v < 0 ? -v : v;
}

// Applies one key's calibration and restarts its filters and state machine at `raw`
void applyKey(uint8_t i, const KeyCalibration& cal, uint16_t raw) {
    HallKey& key = HallManager::getKey(i);
    key.applyCalibration(cal);
    key.seedFilters(raw);
    key.resetStateMachine();
}

// ---- Guided calibration state ----
Calibration::Phase s_phase = Calibration::Phase::Idle;
uint32_t s_startMs = 0;
uint32_t s_lastScanMs = 0;
uint32_t s_lastActivityMs = 0;
bool     s_event = false;

uint16_t s_restOk = 0;
uint16_t s_restFailed = 0;
uint16_t s_travelDone = 0;

// REST phase accumulators
uint16_t s_restScans = 0;
uint32_t s_restSum[NUM_KEYS];
uint16_t s_restMin[NUM_KEYS];
uint16_t s_restMax[NUM_KEYS];
uint16_t s_restMean[NUM_KEYS];

// TRAVEL phase: largest excursion above and below the rest mean, and the press direction
// locked in when the key completed
uint16_t s_excUp[NUM_KEYS];
uint16_t s_excDown[NUM_KEYS];
int8_t   s_sign[NUM_KEYS];

void clearSession() {
    s_restOk = 0;
    s_restFailed = 0;
    s_travelDone = 0;
    s_restScans = 0;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        s_restSum[i] = 0;
        s_restMin[i] = 0xFFFF;
        s_restMax[i] = 0;
        s_restMean[i] = 0;
        s_excUp[i] = 0;
        s_excDown[i] = 0;
        s_sign[i] = 0;
    }
}

void finishRestPhase(uint32_t nowMs) {
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        uint16_t bit = (uint16_t)(1u << i);
        uint16_t mean = (uint16_t)((s_restSum[i] + s_restScans / 2) / s_restScans);
        s_restMean[i] = mean;
        bool noisy = (uint16_t)(s_restMax[i] - s_restMin[i]) > calib::REST_NOISE_P2P_MAX;
        bool railed = isRailed(s_restMin[i]) || isRailed(s_restMax[i]);
        bool implausible = mean < calib::REST_MIN || mean > calib::REST_MAX;
        if (noisy || railed || implausible) {
            s_restFailed |= bit;
        } else {
            s_restOk |= bit;
        }
    }
    s_phase = s_restFailed ? Calibration::Phase::Failed : Calibration::Phase::Travel;
    s_lastActivityMs = nowMs;
    s_event = true;
}

} // namespace

const char* calStateName(CalState s) {
    switch (s) {
        case CalState::Missing:    return "missing";
        case CalState::Valid:      return "valid";
        case CalState::Invalid:    return "invalid";
        case CalState::InProgress: return "in_progress";
    }
    return "invalid";
}

uint16_t calibrationTolerance(uint16_t rangeCounts) {
    uint16_t share = (uint16_t)((uint32_t)rangeCounts * calib::TOLERANCE_RANGE_PCT / 100);
    return share > calib::TOLERANCE_MIN_COUNTS ? share : calib::TOLERANCE_MIN_COUNTS;
}

bool calibrationKeyPlausible(const KeyCalibration& k) {
    if (k.restRaw < calib::REST_MIN || k.restRaw > calib::REST_MAX) return false;
    if (k.rangeCounts < calib::RANGE_MIN || k.rangeCounts > calib::ADC_MAX) return false;
    if (k.polarity != 1 && k.polarity != -1) return false;
    int32_t bottom = (int32_t)k.restRaw + (int32_t)k.polarity * (int32_t)k.rangeCounts;
    return bottom >= 0 && bottom <= (int32_t)calib::ADC_MAX;
}

CalState calibrationEvaluate(const CalibrationData& d) {
    if (d.state == (uint8_t)CalState::Missing) return CalState::Missing;
    // Only data saved as Valid can be valid; a stored Invalid/InProgress/unknown state is not
    // trusted even if the numbers happen to pass.
    if (d.state != (uint8_t)CalState::Valid) return CalState::Invalid;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        if (!calibrationKeyPlausible(d.keys[i])) return CalState::Invalid;
    }
    return CalState::Valid;
}

void calibrationClear(CalibrationData& d) {
    d.state = (uint8_t)CalState::Missing;
    for (uint8_t r = 0; r < sizeof(d.reserved); ++r) d.reserved[r] = 0;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        d.keys[i] = KeyCalibration{0, 0, 0, 0};
    }
}

namespace Calibration {

BootReport applyAtBoot(const CalibrationData& stored, const uint16_t measuredRest[NUM_KEYS]) {
    BootReport r = {calibrationEvaluate(stored), 0, 0, 0, 0};

    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        uint16_t bit = (uint16_t)(1u << i);
        uint16_t m = measuredRest[i];
        bool railed = isRailed(m);
        if (railed) r.faultMask |= bit;

        if (r.state != CalState::Valid) {
            // Legacy behaviour: zero at the current reading, polarity found on the first press
            HallKey& key = HallManager::getKey(i);
            key.resetCalibration();
            key.calibrateRest(m);
            key.resetStateMachine();
            continue;
        }

        const KeyCalibration& cal = stored.keys[i];
        KeyCalibration applied = cal;
        int32_t dev = pressDeviation(m, cal.restRaw, cal.polarity);
        int32_t tol = calibrationTolerance(cal.rangeCounts);
        if (railed) {
            // Stored rest kept; the key is excluded from output via the fault mask
        } else if (dev > tol) {
            // Pressed at power-up: keep the stored rest so the press reads as travel, and let
            // the caller suppress its output until it is seen at rest
            r.heldMask |= bit;
        } else {
            applied.restRaw = m;
            if (dev < -tol) {
                r.driftMask |= bit;     // moved away from the press direction: adopt, but report
            } else {
                r.adoptedMask |= bit;   // normal drift re-zero
            }
        }
        applyKey(i, applied, m);
    }

    HallManager::setFaultMask(r.faultMask);
    return r;
}

uint16_t applyRuntime(const CalibrationData& d, const uint16_t currentRaw[NUM_KEYS]) {
    if (calibrationEvaluate(d) != CalState::Valid) return 0;
    uint16_t offRest = 0;
    uint16_t faults = 0;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        uint16_t bit = (uint16_t)(1u << i);
        const KeyCalibration& cal = d.keys[i];
        uint16_t raw = currentRaw[i];
        applyKey(i, cal, raw);
        if (isRailed(raw)) faults |= bit;
        if (pressDeviation(raw, cal.restRaw, cal.polarity) > (int32_t)calibrationTolerance(cal.rangeCounts)) {
            offRest |= bit;
        }
    }
    HallManager::setFaultMask(faults);
    return offRest;
}

bool quickRestRecalibrate(CalibrationData& data, const uint16_t measuredRest[NUM_KEYS], uint16_t& offRestMask) {
    offRestMask = 0;
    bool valid = calibrationEvaluate(data) == CalState::Valid;

    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        uint16_t bit = (uint16_t)(1u << i);
        uint16_t m = measuredRest[i];
        if (m < calib::REST_MIN || m > calib::REST_MAX) {
            offRestMask |= bit;   // cannot become a plausible rest
            continue;
        }
        uint16_t rest;
        int8_t polarity;
        uint16_t range;
        if (valid) {
            rest = data.keys[i].restRaw;
            polarity = data.keys[i].polarity;
            range = data.keys[i].rangeCounts;
        } else {
            // No trusted calibration: compare against the running baseline instead
            HallKey& key = HallManager::getKey(i);
            rest = key.getRestBaseline();
            polarity = key.getPolarity();
            range = key.getRangeCounts();
        }
        int32_t tol = calibrationTolerance(range);
        int32_t dev = (int32_t)m - (int32_t)rest;
        // Unknown polarity: an excursion either way may be a press
        bool off = (polarity != 0) ? (dev * polarity > tol) : (absI32(dev) > tol);
        if (off) offRestMask |= bit;
    }
    if (offRestMask != 0) return false;

    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        uint16_t m = measuredRest[i];
        if (valid) {
            data.keys[i].restRaw = m;
            applyKey(i, data.keys[i], m);
        } else {
            HallKey& key = HallManager::getKey(i);
            key.calibrateRest(m);   // keeps polarity and range, as v1 CALIBRATE did
            key.resetStateMachine();
        }
    }
    return true;
}

const char* phaseName(Phase p) {
    switch (p) {
        case Phase::Idle:      return "idle";
        case Phase::Rest:      return "rest";
        case Phase::Travel:    return "travel";
        case Phase::Done:      return "done";
        case Phase::Failed:    return "failed";
        case Phase::Cancelled: return "cancelled";
    }
    return "idle";
}

bool begin(uint32_t nowMs) {
    if (isActive()) return false;
    clearSession();
    s_phase = Phase::Rest;
    s_startMs = nowMs;
    s_lastScanMs = nowMs;
    s_lastActivityMs = nowMs;
    s_event = true;
    return true;
}

bool isActive() {
    return s_phase == Phase::Rest || s_phase == Phase::Travel;
}

void onScan(const uint16_t raw[NUM_KEYS], uint32_t nowMs) {
    if (!isActive()) return;
    s_lastScanMs = nowMs;

    if (s_phase == Phase::Rest) {
        for (uint8_t i = 0; i < NUM_KEYS; ++i) {
            uint16_t v = raw[i];
            s_restSum[i] += v;
            if (v < s_restMin[i]) s_restMin[i] = v;
            if (v > s_restMax[i]) s_restMax[i] = v;
        }
        if (s_restScans < 0xFFFF) s_restScans++;
        if ((uint32_t)(nowMs - s_startMs) >= calib::REST_PHASE_MS && s_restScans >= calib::REST_MIN_SAMPLES) {
            finishRestPhase(nowMs);
        }
        return;
    }

    // TRAVEL: each key must reach RANGE_MIN away from its rest mean and come back within the
    // rest tolerance of that range
    bool moving = false;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        uint16_t bit = (uint16_t)(1u << i);
        int32_t dev = (int32_t)raw[i] - (int32_t)s_restMean[i];
        uint16_t absDev = (uint16_t)absI32(dev);
        if (dev > 0 && absDev > s_excUp[i]) s_excUp[i] = absDev;
        if (dev < 0 && absDev > s_excDown[i]) s_excDown[i] = absDev;
        if (absDev > calib::ACTIVITY_COUNTS) moving = true;

        if (!(s_travelDone & bit)) {
            bool up = s_excUp[i] >= s_excDown[i];
            uint16_t exc = up ? s_excUp[i] : s_excDown[i];
            if (exc >= calib::RANGE_MIN && absDev <= calibrationTolerance(exc)) {
                s_travelDone |= bit;
                s_sign[i] = up ? 1 : -1;
                s_event = true;
            }
        }
    }
    if (moving) {
        s_lastActivityMs = nowMs;
    } else if ((uint32_t)(nowMs - s_lastActivityMs) >= calib::INACTIVITY_TIMEOUT_MS) {
        s_phase = Phase::Cancelled;
        s_event = true;
    }
}

Progress progress() {
    Progress p;
    p.phase = s_phase;
    p.restOkMask = s_restOk;
    p.restFailedMask = s_restFailed;
    p.travelDoneMask = s_travelDone;
    p.elapsedMs = (s_phase == Phase::Idle) ? 0 : (uint32_t)(s_lastScanMs - s_startMs);
    return p;
}

bool takeEvent() {
    bool e = s_event;
    s_event = false;
    return e;
}

bool finish(CalibrationData& out, uint16_t& missingMask) {
    missingMask = (uint16_t)(~s_travelDone & ALL_KEYS);
    if (s_phase != Phase::Travel || missingMask != 0) return false;

    CalibrationData d;
    d.state = (uint8_t)CalState::Valid;
    d.reserved[0] = d.reserved[1] = d.reserved[2] = 0;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        d.keys[i].restRaw = s_restMean[i];
        d.keys[i].rangeCounts = (s_sign[i] > 0) ? s_excUp[i] : s_excDown[i];
        d.keys[i].polarity = s_sign[i];
        d.keys[i].flags = 0;
    }
    // Every sample lies inside the ADC range, so rest +- range does too; checked anyway so a
    // finished calibration can never be one that the loader would reject
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        if (!calibrationKeyPlausible(d.keys[i])) missingMask |= (uint16_t)(1u << i);
    }
    if (missingMask != 0) return false;

    out = d;
    s_phase = Phase::Done;
    s_event = true;
    return true;
}

void cancel() {
    if (!isActive()) return;
    s_phase = Phase::Cancelled;
    s_event = true;
}

void reset() {
    clearSession();
    s_phase = Phase::Idle;
    s_startMs = 0;
    s_lastScanMs = 0;
    s_lastActivityMs = 0;
    s_event = false;
}

} // namespace Calibration
