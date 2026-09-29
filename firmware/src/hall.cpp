#include "hall.h"
#include "mux.h"
#include "keyboard_output.h"
#include <Arduino.h>
#include <cmath>

// Static configuration defaults
float HallKey::s_actuationPointMm = 1.20f;
float HallKey::s_rtPressMm        = 0.20f;
float HallKey::s_rtReleaseMm      = 0.20f;
bool  HallKey::s_rtEnabled        = true;

HallKey HallManager::s_keys[NUM_KEYS];
int8_t HallManager::s_lastActiveKey = -1;
uint16_t HallManager::s_lastRaw[NUM_KEYS];
uint16_t HallManager::s_routedMask = 0;
uint16_t HallManager::s_simMask = 0;
uint32_t HallManager::s_simLastMs[NUM_KEYS];
uint16_t HallManager::s_faultMask = 0;

// Arduino Keyboard codes for the power-up keymap (same values as KEY_* in <Keyboard.h>).
// configApplyToHardware() replaces them with the stored keymap.
static constexpr uint8_t CODE_ESC    = 0xB1;
static constexpr uint8_t CODE_RETURN = 0xB0;
static constexpr uint8_t CODE_F13    = 0xF0;
static constexpr uint8_t CODE_F14    = 0xF1;
static constexpr uint8_t CODE_F15    = 0xF2;
static constexpr uint8_t CODE_F16    = 0xF3;

static const HallKeyConfig DEFAULT_CONFIGS[NUM_KEYS] = {
    { 0, KEY_MUX_CHANNELS[0],  CODE_ESC,    "ESC" },
    { 1, KEY_MUX_CHANNELS[1],  '7',         "7"   },
    { 2, KEY_MUX_CHANNELS[2],  '8',         "8"   },
    { 3, KEY_MUX_CHANNELS[3],  '9',         "9"   },
    { 4, KEY_MUX_CHANNELS[4],  CODE_F13,    "M1"  },
    { 5, KEY_MUX_CHANNELS[5],  '4',         "4"   },
    { 6, KEY_MUX_CHANNELS[6],  '5',         "5"   },
    { 7, KEY_MUX_CHANNELS[7],  '6',         "6"   },
    { 8, KEY_MUX_CHANNELS[8],  CODE_F14,    "M2"  },
    { 9, KEY_MUX_CHANNELS[9],  '1',         "1"   },
    {10, KEY_MUX_CHANNELS[10], '2',         "2"   },
    {11, KEY_MUX_CHANNELS[11], '3',         "3"   },
    {12, KEY_MUX_CHANNELS[12], CODE_F15,    "M3"  },
    {13, KEY_MUX_CHANNELS[13], CODE_F16,    "M4"  },
    {14, KEY_MUX_CHANNELS[14], '0',         "0"   },
    {15, KEY_MUX_CHANNELS[15], CODE_RETURN, "ENT" }
};

HallKey::HallKey()
    : _keyIndex(0), _muxChannel(0), _hidKeyCode(0), _label(""),
      _currentRaw(2048), _filteredRaw(2048.0f), _restBaseline(2048.0f),
      _bottomRaw(3048.0f), _dynamicRange(1000.0f), _polarityDetected(false),
      _voltageIncreasesOnPress(true), _travelMm(0.0f),
      _peakDepthMm(0.0f), _valleyDepthMm(0.0f),
      _isPressed(false), _everActuated(false),
      _pressCount(0), _releaseCount(0),
      _prevRaw(2048.0f), _dIdx(0), _hIdx(0),
      _driftTravel(0.0f), _baselineErrFilt(0.0f),
      _pressSamples(0), _unpressedSamples(INITIAL_UNPRESSED_SAMPLES),
      _stationaryUnpressedMs(0), _recoveringBaseline(false),
      _motionSamples(0), _humanContact(false) {
    for (int i = 0; i < HIST_LEN; ++i) {
        _dHist[i] = 0.0f;
        _rawHist[i] = 2048.0f;
    }
}

void HallKey::init(uint8_t index, uint8_t channel, uint8_t keycode, const char* label) {
    _keyIndex = index;
    _muxChannel = channel;
    _hidKeyCode = keycode;
    _label = label;
    _currentRaw = 2048;
    _filteredRaw = 2048.0f;
    _restBaseline = 2048.0f;
    _bottomRaw = 3048.0f;
    _dynamicRange = 1000.0f;
    _polarityDetected = false;
    _voltageIncreasesOnPress = true;
    _travelMm = 0.0f;
    _peakDepthMm = 0.0f;
    _valleyDepthMm = 0.0f;
    _isPressed = false;
    _everActuated = false;
    // Edge counters remain monotonic across resets to prevent phantom flashes on the Core 1 renderer
    _prevRaw = 2048.0f;
    for (int i = 0; i < HIST_LEN; ++i) {
        _dHist[i] = 0.0f;
        _rawHist[i] = 2048.0f;
    }
    _dIdx = 0;
    _hIdx = 0;
    _driftTravel = 0.0f;
    _baselineErrFilt = 0.0f;
    _pressSamples = 0;
    _unpressedSamples = INITIAL_UNPRESSED_SAMPLES;
    _stationaryUnpressedMs = 0;
    _recoveringBaseline = false;
    _motionSamples = 0;
    _humanContact = false;
}

void HallKey::calibrateRest(uint16_t sample) {
    _restBaseline = (float)sample;
    _filteredRaw = (float)sample;
    _currentRaw = sample;
    _prevRaw = (float)sample;
    for (int i = 0; i < HIST_LEN; ++i) {
        _dHist[i] = 0.0f;
        _rawHist[i] = (float)sample;
    }
    _dIdx = 0;
    _hIdx = 0;
    _driftTravel = 0.0f;
    _baselineErrFilt = 0.0f;
    _pressSamples = 0;
    _unpressedSamples = INITIAL_UNPRESSED_SAMPLES;
    _stationaryUnpressedMs = 0;
    _recoveringBaseline = false;
    _motionSamples = 0;
    _humanContact = false;
    if (_restBaseline < 2048.0f) {
        _bottomRaw = _restBaseline + _dynamicRange;
    } else {
        _bottomRaw = _restBaseline - _dynamicRange;
    }
}

bool HallKey::update(uint16_t rawAdc) {
    // Kept in exact sync with HallKeyDSP.update() in tests/test_dsp_harness.py.
    // tests/test_firmware_parity.py compiles this file on the host and fails if they diverge.
    float rawVal = (float)rawAdc;
    _currentRaw = rawAdc;

    // 1. Instantaneous velocity and 60Hz EMI comb filter
    float instV = fabsf(rawVal - _prevRaw);
    _prevRaw = rawVal;

    // At 1kHz a 60Hz period is 16.67 samples, so raw[n-8]/raw[n-9] weighted 2/3 : 1/3
    // sits half a period back and cancels the 60Hz component when averaged with raw[n].
    _rawHist[_hIdx] = rawVal;
    float raw8 = _rawHist[((int)_hIdx - 8 + HIST_LEN) % HIST_LEN];
    float raw9 = _rawHist[((int)_hIdx - 9 + HIST_LEN) % HIST_LEN];
    _hIdx = (_hIdx + 1) % HIST_LEN;

    float combVal = 0.5f * (rawVal + (2.0f / 3.0f) * raw8 + (1.0f / 3.0f) * raw9);

    float d0 = rawVal - _filteredRaw;
    float d8 = _dHist[((int)_dIdx - 8 + HIST_LEN) % HIST_LEN];
    _dHist[_dIdx] = d0;
    _dIdx = (_dIdx + 1) % HIST_LEN;

    float corr8 = d0 * d8;

    bool isHeld = (_pressSamples > HELD_SAMPLES) || (_unpressedSamples > HELD_SAMPLES);

    // Upward motion while pressed bypasses the comb filter so RT releases stay low-latency,
    // unless the deviation anti-correlates with half a 60Hz period ago (EMI, not motion).
    bool isReleasing = false;
    if (_isPressed) {
        if (_voltageIncreasesOnPress) {
            isReleasing = (rawVal < _filteredRaw - 1.5f);
        } else {
            isReleasing = (rawVal > _filteredRaw + 1.5f);
        }
        if (corr8 < -2.0f) {
            isReleasing = false;
        }
    }

    float targetVal;
    float alpha;
    if (isReleasing) {
        targetVal = rawVal;
        alpha = ALPHA_FAST;
    } else if (!_isPressed && (instV > 10.0f || fabsf(d0) > 22.0f)) {
        targetVal = rawVal;
        alpha = ALPHA_FAST;
    } else if (isHeld) {
        targetVal = combVal;
        alpha = ALPHA_HELD;
    } else {
        targetVal = rawVal;
        alpha = ALPHA_MOVING;
    }

    _filteredRaw += alpha * (targetVal - _filteredRaw);

    // 2. Polarity Detection
    float delta = _filteredRaw - _restBaseline;
    if (!_polarityDetected && fabsf(delta) > 150.0f) {
        _voltageIncreasesOnPress = (delta > 0.0f);
        _polarityDetected = true;
        if (_voltageIncreasesOnPress) {
            _bottomRaw = _restBaseline + _dynamicRange;
        } else {
            _bottomRaw = _restBaseline - _dynamicRange;
        }
    }

    // 3. Magnetic Magnitude
    float mag = 0.0f;
    if (_polarityDetected) {
        if (_voltageIncreasesOnPress) {
            mag = (delta > 0.0f) ? delta : 0.0f;
        } else {
            mag = (delta < 0.0f) ? -delta : 0.0f;
        }
    } else {
        // While uncalibrated, excursion in EITHER direction represents potential travel
        mag = fabsf(delta);
    }

    // 4. Dynamic Range Calibration
    float dynRange = fabsf(_bottomRaw - _restBaseline);
    if (dynRange < (float)calib::RANGE_MIN) {
        dynRange = (float)calib::RANGE_MIN;
    }
    if (_polarityDetected && mag > dynRange) {
        dynRange = mag;
        if (_voltageIncreasesOnPress) {
            _bottomRaw = _restBaseline + dynRange;
        } else {
            _bottomRaw = _restBaseline - dynRange;
        }
    }
    _dynamicRange = dynRange;

    // 5. Travel Conversion (0.00mm to 4.00mm)
    float rawMm = (mag / dynRange) * SWITCH_TOTAL_TRAVEL_MM;
    if (rawMm < 0.0f) rawMm = 0.0f;
    if (rawMm > SWITCH_TOTAL_TRAVEL_MM) rawMm = SWITCH_TOTAL_TRAVEL_MM;
    _travelMm = rawMm;

    // Human contact approach velocity discriminator
    if (instV >= 0.5f) {
        if (_motionSamples < 255) _motionSamples++;
        if (_motionSamples >= 3 && _travelMm > 0.15f) {
            _humanContact = true;
        }
    } else if (instV < 0.2f) {
        _motionSamples = 0;
    }

    if (_travelMm < 0.10f) {
        _humanContact = false;
    }

    // 6. Auto-Zero Resting Baseline Drift Tracking
    _driftTravel += 0.05f * (_travelMm - _driftTravel);
    bool motionFreeze = (!_polarityDetected && instV >= 0.5f);
    if (_travelMm < 0.20f && _driftTravel < REST_DRIFT_THRESHOLD_MM && !_isPressed && !motionFreeze) {
        float err = _filteredRaw - _restBaseline;
        _baselineErrFilt += 0.04f * (err - _baselineErrFilt);
        if (fabsf(_baselineErrFilt) > 0.01f) {
            float absErr = fabsf(_baselineErrFilt) * BETA;
            if (absErr < 0.1f) absErr = 0.1f;
            if (absErr > MAX_STEP) absErr = MAX_STEP;
            float step = (_baselineErrFilt >= 0.0f) ? absErr : -absErr;
            _restBaseline += step;
        }
    }

    // Unpressed stationary drift recovery for positive steps (>=0.20mm, <0.80mm)
    // Gated by !_everActuated and !_humanContact to isolate human finger rest
    if (!_isPressed && !_everActuated && !_humanContact && instV < 0.5f && _travelMm < 0.80f) {
        if (_stationaryUnpressedMs < 65535) _stationaryUnpressedMs++;
        if (_stationaryUnpressedMs > 400 && _travelMm >= 0.20f) {
            _recoveringBaseline = true;
        }
    } else if (_travelMm >= 0.80f || instV >= 0.5f || _everActuated || _humanContact) {
        _stationaryUnpressedMs = 0;
    }

    if (_recoveringBaseline) {
        float err = _filteredRaw - _restBaseline;
        float absErr = fabsf(err) * BETA;
        if (absErr < 0.1f) absErr = 0.1f;
        if (absErr > MAX_STEP) absErr = MAX_STEP;
        float step = (err >= 0.0f) ? absErr : -absErr;
        _restBaseline += step;
        if (fabsf(_filteredRaw - _restBaseline) < 0.5f) {
            _recoveringBaseline = false;
            _stationaryUnpressedMs = 0;
        }
    }

    // Held state sample counters
    if (_isPressed) {
        if (_pressSamples < 65535) _pressSamples++;
        _unpressedSamples = 0;
    } else {
        if (_unpressedSamples < 65535) _unpressedSamples++;
        _pressSamples = 0;
    }

    return runRapidTrigger();
}

// 7. Rapid Trigger state machine on the current _travelMm. Shared by real samples and SIM
// injection so simulated presses behave exactly like physical ones.
bool HallKey::runRapidTrigger() {
    bool stateChanged = false;
    float countResMm = SWITCH_TOTAL_TRAVEL_MM / _dynamicRange;
    float quantTol = 0.85f * countResMm;

    if (!_isPressed) {
        bool shouldActuate = false;

        if (!_everActuated) {
            // Initial press crossing fixed threshold
            if (_travelMm >= s_actuationPointMm) {
                shouldActuate = true;
            }
        } else {
            // Key already actuated in current stroke
            if (s_rtEnabled) {
                if ((_travelMm - _valleyDepthMm >= s_rtPressMm - quantTol) && (_travelMm > TOP_DEADZONE_MM)) {
                    shouldActuate = true;
                }
            } else {
                if (_travelMm >= s_actuationPointMm) {
                    shouldActuate = true;
                }
            }
        }

        if (shouldActuate) {
            _isPressed = true;
            _pressCount++;
            _everActuated = true;
            _peakDepthMm = _travelMm;
            // Both held counters restart on a transition. update() tests them before it updates
            // them, so a stale _unpressedSamples would run the comb filter over pre-press history
            // on the next sample and fake a Rapid Trigger release (TC-18).
            _pressSamples = 0;
            _unpressedSamples = 0;
            stateChanged = true;
        } else {
            if (_travelMm < _valleyDepthMm) {
                _valleyDepthMm = _travelMm;
            }
            if (_travelMm <= TOP_DEADZONE_MM) {
                _everActuated = false;
                _valleyDepthMm = 0.0f;
            }
        }
    } else {
        if (_travelMm > _peakDepthMm) {
            _peakDepthMm = _travelMm;
        }

        bool shouldRelease = false;

        if (_travelMm <= TOP_DEADZONE_MM) {
            shouldRelease = true;
        } else if (s_rtEnabled && (_peakDepthMm - _travelMm >= s_rtReleaseMm - quantTol)) {
            shouldRelease = true;
        } else if (!s_rtEnabled && (_travelMm < (s_actuationPointMm - 0.20f))) {
            shouldRelease = true;
        }

        if (shouldRelease) {
            _isPressed = false;
            _releaseCount++;
            _valleyDepthMm = _travelMm;
            _unpressedSamples = 0;
            _pressSamples = 0;
            stateChanged = true;
        }
    }

    return stateChanged;
}

bool HallKey::injectSimulatedTravel(float mm) {
    if (mm < 0.0f) mm = 0.0f;
    if (mm > SWITCH_TOTAL_TRAVEL_MM) mm = SWITCH_TOTAL_TRAVEL_MM;
    _travelMm = mm;
    return runRapidTrigger();
}

void HallKey::applyCalibration(const KeyCalibration& cal) {
    _restBaseline = (float)cal.restRaw;
    _dynamicRange = (float)cal.rangeCounts;
    if (cal.polarity != 0) {
        _polarityDetected = true;
        _voltageIncreasesOnPress = (cal.polarity > 0);
    } else {
        _polarityDetected = false;
        _voltageIncreasesOnPress = true;
    }
    if (_voltageIncreasesOnPress) {
        _bottomRaw = _restBaseline + _dynamicRange;
    } else {
        _bottomRaw = _restBaseline - _dynamicRange;
    }
}

KeyCalibration HallKey::exportCalibration() const {
    KeyCalibration cal;
    cal.restRaw = getRestBaseline();
    cal.rangeCounts = getRangeCounts();
    cal.polarity = getPolarity();
    cal.flags = 0;
    return cal;
}

void HallKey::resetCalibration() {
    _polarityDetected = false;
    _voltageIncreasesOnPress = true;
    _dynamicRange = 1000.0f;
    _bottomRaw = _restBaseline + _dynamicRange;
}

int8_t HallKey::getPolarity() const {
    if (!_polarityDetected) return 0;
    return _voltageIncreasesOnPress ? 1 : -1;
}

uint16_t HallKey::getRangeCounts() const {
    return (uint16_t)fminf(4095.0f, fabsf(_bottomRaw - _restBaseline) + 0.5f);
}

void HallKey::seedFilters(uint16_t raw) {
    _currentRaw = raw;
    _filteredRaw = (float)raw;
    _prevRaw = (float)raw;
    for (int i = 0; i < HIST_LEN; ++i) {
        _dHist[i] = 0.0f;
        _rawHist[i] = (float)raw;
    }
    _dIdx = 0;
    _hIdx = 0;
    _driftTravel = 0.0f;
    _baselineErrFilt = 0.0f;
    _stationaryUnpressedMs = 0;
    _recoveringBaseline = false;
    _motionSamples = 0;
    _humanContact = false;
}

void HallKey::resetStateMachine() {
    if (_isPressed) {
        _releaseCount++;
    }
    _isPressed = false;
    _everActuated = false;
    _peakDepthMm = 0.0f;
    _valleyDepthMm = 0.0f;
    _travelMm = 0.0f;
    _pressSamples = 0;
    _unpressedSamples = INITIAL_UNPRESSED_SAMPLES;
}

void HallManager::init() {
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        s_keys[i].init(
            DEFAULT_CONFIGS[i].keyIndex,
            DEFAULT_CONFIGS[i].muxChannel,
            DEFAULT_CONFIGS[i].hidKeyCode,
            DEFAULT_CONFIGS[i].label
        );
        s_lastRaw[i] = 2048;
        s_simLastMs[i] = 0;
    }
    s_lastActiveKey = -1;
    s_routedMask = 0;
    s_simMask = 0;
    s_faultMask = 0;
}

void HallManager::calibrateAllRestBaselines(uint16_t samplesPerKey) {
    uint32_t accum[NUM_KEYS] = {0};

    for (uint16_t s = 0; s < samplesPerKey; ++s) {
        for (uint8_t i = 0; i < NUM_KEYS; ++i) {
            accum[i] += muxReadChannel(s_keys[i].getMuxChannel());
        }
        delayMicroseconds(50);
    }

    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        s_keys[i].calibrateRest((uint16_t)(accum[i] / samplesPerKey));
    }
}

void HallManager::measureRest(uint16_t out[NUM_KEYS], uint16_t samples) {
    if (samples == 0) samples = 1;
    uint32_t accum[NUM_KEYS] = {0};

    for (uint16_t s = 0; s < samples; ++s) {
        for (uint8_t i = 0; i < NUM_KEYS; ++i) {
            accum[i] += muxReadChannel(s_keys[i].getMuxChannel());
        }
        delayMicroseconds(50);
    }

    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        out[i] = (uint16_t)((accum[i] + samples / 2) / samples);
    }
}

void HallManager::updateAll() {
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        HallKey& key = s_keys[i];
        uint16_t bit = (uint16_t)(1u << i);
        uint16_t raw = muxReadChannel(key.getMuxChannel());
        s_lastRaw[i] = raw;

        // SIM owns this key's travel: the reading is recorded (RAW capture, calibration) but not fed
        if (s_simMask & bit) continue;

        if (key.update(raw)) {
            if (key.isPressed()) {
                s_lastActiveKey = (int8_t)i;
            }
        }

        if (s_faultMask & bit) continue;

        // Route by level rather than by update()'s edge flag, so a state machine reset elsewhere
        // (calibration apply, SIM exit) is reconciled here: a key reset while KeyboardOutput held
        // it pressed gets its release on the next scan unless it pressed again in this update.
        bool pressed = key.isPressed();
        if (pressed && !(s_routedMask & bit)) {
            s_routedMask |= bit;
            KeyboardOutput::onPress(i, key.getHidKeyCode());
        } else if (!pressed && (s_routedMask & bit)) {
            s_routedMask &= (uint16_t)~bit;
            KeyboardOutput::onRelease(i);
        }
        if ((KeyboardOutput::suppressedKeysMask() & bit) && key.isAtRest()) {
            KeyboardOutput::onAtRest(i);
        }
    }
}

const uint16_t* HallManager::lastRaw() {
    return s_lastRaw;
}

uint8_t HallManager::getPressedCount() {
    uint8_t count = 0;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        if (s_keys[i].isPressed()) ++count;
    }
    return count;
}

int8_t HallManager::getLastActiveKey() {
    return s_lastActiveKey;
}

uint16_t HallManager::pressedMask() {
    uint16_t mask = 0;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        if (s_keys[i].isPressed()) mask |= (uint16_t)(1u << i);
    }
    return mask;
}

bool HallManager::simSet(uint8_t key, float mm, uint32_t nowMs) {
    if (key >= NUM_KEYS) return false;
    uint16_t bit = (uint16_t)(1u << key);
    if (!(s_simMask & bit)) {
        s_simMask |= bit;
        if (s_routedMask & bit) {
            s_routedMask &= (uint16_t)~bit;
            KeyboardOutput::onRelease(key);
        }
    }
    s_simLastMs[key] = nowMs;
    s_keys[key].injectSimulatedTravel(mm);
    return true;
}

void HallManager::simClear(uint8_t key) {
    if (key >= NUM_KEYS) return;
    uint16_t bit = (uint16_t)(1u << key);
    if (!(s_simMask & bit)) return;
    s_simMask &= (uint16_t)~bit;
    HallKey& k = s_keys[key];
    k.seedFilters(s_lastRaw[key]);
    k.resetStateMachine();
    KeyboardOutput::suppressUntilRelease(key, true);
}

void HallManager::simClearAll() {
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        simClear(i);
    }
}

void HallManager::simService(uint32_t nowMs) {
    if (s_simMask == 0) return;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        if ((s_simMask & (1u << i)) && (uint32_t)(nowMs - s_simLastMs[i]) >= SIM_TIMEOUT_MS) {
            simClear(i);
        }
    }
}

uint16_t HallManager::simMask() {
    return s_simMask;
}

void HallManager::setFaultMask(uint16_t mask) {
    uint16_t newlyFaulted = (uint16_t)(mask & ~s_faultMask & s_routedMask);
    s_faultMask = mask;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        if (newlyFaulted & (1u << i)) {
            s_routedMask &= (uint16_t)~(1u << i);
            KeyboardOutput::onRelease(i);
        }
    }
}

uint16_t HallManager::faultMask() {
    return s_faultMask;
}
