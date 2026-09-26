#include "hall.h"
#include "mux.h"
#include <Arduino.h>
#include <Keyboard.h>
#include <cmath>

// Static configuration defaults
float HallKey::s_actuationPointMm = 1.20f;
float HallKey::s_rtPressMm        = 0.20f;
float HallKey::s_rtReleaseMm      = 0.20f;
bool  HallKey::s_rtEnabled        = true;

HallKey HallManager::s_keys[NUM_KEYS];
int8_t HallManager::s_lastActiveKey = -1;

// SAFETY: Runtime controllable HID output (defaults to false for breadboard safety)
// Can be toggled on-the-fly via SET_HID 1 / SET_HID 0 serial command.
static bool s_enableHidOutput = false;

static const HallKeyConfig DEFAULT_CONFIGS[NUM_KEYS] = {
    { 0, KEY_MUX_CHANNELS[0],  KEY_ESC,     "ESC" },
    { 1, KEY_MUX_CHANNELS[1],  '7',         "7"   },
    { 2, KEY_MUX_CHANNELS[2],  '8',         "8"   },
    { 3, KEY_MUX_CHANNELS[3],  '9',         "9"   },
    { 4, KEY_MUX_CHANNELS[4],  KEY_F13,     "M1"  },
    { 5, KEY_MUX_CHANNELS[5],  '4',         "4"   },
    { 6, KEY_MUX_CHANNELS[6],  '5',         "5"   },
    { 7, KEY_MUX_CHANNELS[7],  '6',         "6"   },
    { 8, KEY_MUX_CHANNELS[8],  KEY_F14,     "M2"  },
    { 9, KEY_MUX_CHANNELS[9],  '1',         "1"   },
    {10, KEY_MUX_CHANNELS[10], '2',         "2"   },
    {11, KEY_MUX_CHANNELS[11], '3',         "3"   },
    {12, KEY_MUX_CHANNELS[12], KEY_F15,     "M3"  },
    {13, KEY_MUX_CHANNELS[13], KEY_F16,     "M4"  },
    {14, KEY_MUX_CHANNELS[14], '0',         "0"   },
    {15, KEY_MUX_CHANNELS[15], KEY_RETURN,  "ENT" }
};

HallKey::HallKey()
    : _keyIndex(0), _muxChannel(0), _hidKeyCode(0), _label(""),
      _currentRaw(2048), _filteredRaw(2048.0f), _restBaseline(2048.0f),
      _bottomRaw(3048.0f), _dynamicRange(1000.0f), _polarityDetected(false),
      _voltageIncreasesOnPress(true), _travelMm(0.0f),
      _peakDepthMm(0.0f), _valleyDepthMm(0.0f),
      _isPressed(false), _everActuated(false),
      _pressCount(0), _releaseCount(0),
      _prevRaw(2048.0f), _dIdx(0), _swungPos(false), _swungNeg(false),
      _driftTravel(0.0f), _baselineErrFilt(0.0f),
      _pressSamples(0), _unpressedSamples(0), _noiseEnv(0.0f),
      _stationaryUnpressedMs(0), _recoveringBaseline(false),
      _chatterGuard(0), _motionSamples(0), _humanContact(false) {
    for (int i = 0; i < 18; ++i) {
        _dHist[i] = 0.0f;
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
    _pressCount = 0;
    _releaseCount = 0;
    _prevRaw = 2048.0f;
    for (int i = 0; i < 18; ++i) {
        _dHist[i] = 0.0f;
    }
    _dIdx = 0;
    _swungPos = false;
    _swungNeg = false;
    _driftTravel = 0.0f;
    _baselineErrFilt = 0.0f;
    _pressSamples = 0;
    _unpressedSamples = 0;
    _noiseEnv = 0.0f;
    _stationaryUnpressedMs = 0;
    _recoveringBaseline = false;
    _chatterGuard = 0;
    _motionSamples = 0;
    _humanContact = false;
}

void HallKey::calibrateRest(uint16_t sample) {
    _restBaseline = (float)sample;
    _filteredRaw = (float)sample;
    _currentRaw = sample;
    _prevRaw = (float)sample;
    for (int i = 0; i < 18; ++i) {
        _dHist[i] = 0.0f;
    }
    _dIdx = 0;
    _swungPos = false;
    _swungNeg = false;
    _driftTravel = 0.0f;
    _baselineErrFilt = 0.0f;
    _pressSamples = 0;
    _unpressedSamples = 0;
    _noiseEnv = 0.0f;
    _stationaryUnpressedMs = 0;
    _recoveringBaseline = false;
    _chatterGuard = 0;
    _motionSamples = 0;
    _humanContact = false;
    if (_restBaseline < 2048.0f) {
        _bottomRaw = _restBaseline + _dynamicRange;
    } else {
        _bottomRaw = _restBaseline - _dynamicRange;
    }
}

bool HallKey::update(uint16_t rawAdc) {
    float rawVal = (float)rawAdc;
    _currentRaw = rawAdc;

    // 1. Instantaneous velocity and 60Hz EMI correlation filter
    float instV = fabsf(rawVal - _prevRaw);
    _prevRaw = rawVal;

    float d0 = rawVal - _filteredRaw;
    int idx8 = ((int)_dIdx - 8 + 18) % 18;
    int idx17 = ((int)_dIdx - 17 + 18) % 18;
    float d8 = _dHist[idx8];
    float d17 = _dHist[idx17];
    _dHist[_dIdx] = d0;
    _dIdx = (_dIdx + 1) % 18;

    float corr8 = d0 * d8;
    float corr17 = d0 * d17;

    bool isEmi = (fabsf(d0) < 45.0f) && (
        (corr8 < -2.0f && (corr17 > 0.0f || fabsf(d17) < 8.0f)) ||
        (corr8 < -1.0f && instV <= 8.5f) ||
        (_noiseEnv > 4.0f && fabsf(d0) < _noiseEnv * 1.5f && instV <= 15.0f)
    );

    float alpha;
    if (isEmi) {
        alpha = ALPHA_MIN;
    } else {
        float vEst = fabsf(d0);
        float vRatio = (V_THRESH > 0.0f) ? (vEst / V_THRESH) : 1.0f;
        if (vRatio > 1.0f) vRatio = 1.0f;
        alpha = ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * vRatio;
    }

    _filteredRaw += alpha * (rawVal - _filteredRaw);

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
    if (dynRange < 600.0f) {
        dynRange = 600.0f;
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

    // State tracking and noise envelope estimation
    if (_isPressed) {
        if (_pressSamples < 65535) _pressSamples++;
        _unpressedSamples = 0;
    } else {
        if (_unpressedSamples < 65535) _unpressedSamples++;
        _pressSamples = 0;
    }

    bool isOsc = (fabsf(d0) > 3.0f && fabsf(d8) > 3.0f && corr8 < -10.0f && corr17 > -5.0f);
    if (isOsc || _chatterGuard > 0) {
        float envTarget = fmaxf(fabsf(d0), fabsf(d8));
        if (envTarget > _noiseEnv) {
            _noiseEnv += 0.35f * (envTarget - _noiseEnv);
        } else {
            _noiseEnv += 0.005f * (envTarget - _noiseEnv);
        }
    } else {
        _noiseEnv += 0.002f * (0.0f - _noiseEnv);
    }

    if (_chatterGuard > 0) _chatterGuard--;

    float noiseMm = (_noiseEnv / _dynamicRange) * SWITCH_TOTAL_TRAVEL_MM;
    float ratchetDeadband = 1.5f * noiseMm;
    float effRelease      = fmaxf(s_rtReleaseMm, 2.5f * noiseMm);
    float valleyDeadband  = 1.5f * noiseMm;
    float effPress        = fmaxf(s_rtPressMm, 2.5f * noiseMm);

    // 7. Rapid Trigger State Machine
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
                if ((_travelMm - _valleyDepthMm >= effPress - quantTol) && (_travelMm > TOP_DEADZONE_MM)) {
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
            if (_unpressedSamples < 20) {
                _chatterGuard = 40;
                _noiseEnv = fmaxf(_noiseEnv, 18.0f);
            }
            _pressSamples = 0;
            if (s_enableHidOutput) {
                Keyboard.press(_hidKeyCode);
            }
            stateChanged = true;
        } else {
            if (_travelMm < _valleyDepthMm - valleyDeadband) {
                _valleyDepthMm = _travelMm;
            }
            if (_travelMm <= TOP_DEADZONE_MM) {
                _everActuated = false;
                _valleyDepthMm = 0.0f;
            }
        }
    } else {
        if (_travelMm > _peakDepthMm + ratchetDeadband) {
            _peakDepthMm = _travelMm;
        }

        bool shouldRelease = false;

        if (_travelMm <= TOP_DEADZONE_MM) {
            shouldRelease = true;
        } else if (s_rtEnabled && (_peakDepthMm - _travelMm >= effRelease - quantTol)) {
            shouldRelease = true;
        } else if (!s_rtEnabled && (_travelMm < (s_actuationPointMm - 0.20f))) {
            shouldRelease = true;
        }

        if (shouldRelease) {
            _isPressed = false;
            _releaseCount++;
            _valleyDepthMm = _travelMm;
            if (_pressSamples < 20) {
                _chatterGuard = 40;
                _noiseEnv = fmaxf(_noiseEnv, 18.0f);
            }
            _unpressedSamples = 0;
            if (s_enableHidOutput) {
                Keyboard.release(_hidKeyCode);
            }
            stateChanged = true;
        }
    }

    return stateChanged;
}

bool HallKey::injectSimulatedTravel(float mm) {
    if (mm < 0.0f) mm = 0.0f;
    if (mm > SWITCH_TOTAL_TRAVEL_MM) mm = SWITCH_TOTAL_TRAVEL_MM;
    _travelMm = mm;

    bool stateChanged = false;
    float countResMm = SWITCH_TOTAL_TRAVEL_MM / _dynamicRange;
    float quantTol = 0.85f * countResMm;

    if (!_isPressed) {
        bool shouldActuate = false;

        if (!_everActuated) {
            if (_travelMm >= s_actuationPointMm) {
                shouldActuate = true;
            }
        } else {
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
            if (s_enableHidOutput) {
                Keyboard.press(_hidKeyCode);
            }
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
            if (s_enableHidOutput) {
                Keyboard.release(_hidKeyCode);
            }
            stateChanged = true;
        }
    }

    return stateChanged;
}

void HallManager::init() {
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        s_keys[i].init(
            DEFAULT_CONFIGS[i].keyIndex,
            DEFAULT_CONFIGS[i].muxChannel,
            DEFAULT_CONFIGS[i].hidKeyCode,
            DEFAULT_CONFIGS[i].label
        );
    }
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

void HallManager::updateAll() {
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        uint16_t raw = muxReadChannel(s_keys[i].getMuxChannel());
        if (s_keys[i].update(raw)) {
            if (s_keys[i].isPressed()) {
                s_lastActiveKey = (int8_t)i;
            }
        }
    }
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

void HallManager::setHidEnabled(bool en) {
    s_enableHidOutput = en;
    if (!en) {
        Keyboard.releaseAll();
    }
}

bool HallManager::isHidEnabled() {
    return s_enableHidOutput;
}
