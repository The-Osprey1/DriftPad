#ifndef HALL_H
#define HALL_H

#include <cstdint>
#include <cmath>
#include "pins.h"

/**
 * @file hall.h
 * @brief Analog Hall-effect switch management, calibration, and Rapid Trigger algorithm.
 *
 * Implements:
 * - 60Hz EMI comb filter on held keys plus a fast (alpha 0.95) path for motion and RT release.
 * - Dynamic baseline auto-zero tracking with low-pass motion conditioning.
 * - Magnetic polarity auto-detection and dynamic range auto-ranging.
 * - Rapid Trigger with directional hysteresis and quantization deadband tolerance.
 */

struct HallKeyConfig {
    uint8_t keyIndex;
    uint8_t muxChannel;
    uint8_t hidKeyCode;
    const char* label;
};

class HallKey {
public:
    HallKey();

    void init(uint8_t index, uint8_t channel, uint8_t keycode, const char* label);

    // Call during boot to establish resting baseline (unpressed)
    void calibrateRest(uint16_t sample);

    // Process new raw ADC sample (12-bit: 0 - 4095)
    // Returns true if state changed (KeyDown or KeyUp triggered)
    bool update(uint16_t rawAdc);

    // Getters and Setters
    uint8_t getKeyIndex() const { return _keyIndex; }
    uint8_t getMuxChannel() const { return _muxChannel; }
    uint8_t getHidKeyCode() const { return _hidKeyCode; }
    void setHidKeyCode(uint8_t code) { _hidKeyCode = code; }
    const char* getLabel() const { return _label; }
    void setLabel(const char* label) { _label = label; }
    bool isPressed() const { return _isPressed; }
    float getTravelMm() const { return _travelMm; }
    uint16_t getRawAdc() const { return _currentRaw; }
    uint16_t getFilteredRaw() const { return (uint16_t)(_filteredRaw + 0.5f); }
    uint16_t getRestBaseline() const { return (uint16_t)fmaxf(0.0f, fminf(4095.0f, _restBaseline + 0.5f)); }

    // Simulation / testing injection
    bool injectSimulatedTravel(float mm);

    // Cross-core edge counters for lock-free display rendering (Core 0 writes, Core 1 reads)
    uint8_t getPressCount() const { return _pressCount; }
    uint8_t getReleaseCount() const { return _releaseCount; }

    // Settings
    static void setActuationPoint(float mm) {
        if (mm < 0.25f) mm = 0.25f;
        if (mm > 3.80f) mm = 3.80f;
        s_actuationPointMm = mm;
    }
    static float getActuationPoint() { return s_actuationPointMm; }

    static void setRapidTrigger(bool enabled) { s_rtEnabled = enabled; }
    static bool isRapidTrigger() { return s_rtEnabled; }
    static void setRtEnabled(bool enabled) { s_rtEnabled = enabled; }
    static bool isRtEnabled() { return s_rtEnabled; }

    // Below 0.10mm, 10-count 60Hz EMI plus 3-count thermal noise causes false RT releases
    // (tests/test_adversarial_m2.py ADV-02). Mirrored by HallKeyDSP.RT_SENS_MIN_MM.
    static constexpr float RT_SENS_MIN_MM = 0.10f;
    static constexpr float RT_SENS_MAX_MM = 2.00f;

    static void setRtSensitivity(float mm) {
        if (mm < RT_SENS_MIN_MM) mm = RT_SENS_MIN_MM;
        if (mm > RT_SENS_MAX_MM) mm = RT_SENS_MAX_MM;
        s_rtPressMm = mm;
        s_rtReleaseMm = mm;
    }
    static float getRtSensitivity() { return s_rtPressMm; }

private:
    bool runRapidTrigger();

    uint8_t _keyIndex;
    uint8_t _muxChannel;
    uint8_t _hidKeyCode;
    const char* _label;

    uint16_t _currentRaw;
    float    _filteredRaw;
    float    _restBaseline;
    float    _bottomRaw;
    float    _dynamicRange;

    bool     _polarityDetected;
    bool     _voltageIncreasesOnPress;

    float    _travelMm;
    float    _peakDepthMm;    // Deepest point reached during downward stroke
    float    _valleyDepthMm;  // Highest point reached during upward stroke
    bool     _isPressed;
    bool     _everActuated;
    volatile uint8_t _pressCount;
    volatile uint8_t _releaseCount;

    static constexpr float SWITCH_TOTAL_TRAVEL_MM  = 4.0f;
    static constexpr float TOP_DEADZONE_MM         = 0.20f;
    static constexpr float BOTTOM_DEADZONE_MM      = 0.15f;
    static constexpr float REST_DRIFT_THRESHOLD_MM = 0.15f;

    // 60Hz EMI comb filter and adaptive smoothing (mirrors HallKeyDSP)
    static constexpr int   HIST_LEN     = 18;
    static constexpr float ALPHA_FAST   = 0.95f;  // motion / RT release: track raw
    static constexpr float ALPHA_HELD   = 0.25f;  // held key: smooth the comb-filtered signal
    static constexpr float ALPHA_MOVING = 0.90f;  // recently changed state, not yet held
    static constexpr uint16_t HELD_SAMPLES = 30;
    // Start "long unpressed" so the comb filter is active from boot
    static constexpr uint16_t INITIAL_UNPRESSED_SAMPLES = 100;
    float    _prevRaw;
    float    _dHist[HIST_LEN];
    float    _rawHist[HIST_LEN];
    uint8_t  _dIdx;
    uint8_t  _hIdx;

    // Auto-zero baseline tracking
    static constexpr float BETA     = 0.20f;
    static constexpr float MAX_STEP = 2.0f;
    float    _driftTravel;
    float    _baselineErrFilt;

    // Held state sample counters
    uint16_t _pressSamples;
    uint16_t _unpressedSamples;
    uint16_t _stationaryUnpressedMs;
    bool     _recoveringBaseline;
    uint8_t  _motionSamples;
    bool     _humanContact;


    // Global settings across all keys
    static float s_actuationPointMm;
    static float s_rtPressMm;
    static float s_rtReleaseMm;
    static bool  s_rtEnabled;
};

// Manages all 16 Hall keys
class HallManager {
public:
    static void init();
    static void calibrateAllRestBaselines(uint16_t samplesPerKey = 64);
    static void updateAll();

    static HallKey& getKey(uint8_t index) { return s_keys[index]; }
    static uint8_t getPressedCount();
    static int8_t getLastActiveKey();
    static void setHidEnabled(bool en);
    static bool isHidEnabled();

private:
    static HallKey s_keys[NUM_KEYS];
    static int8_t s_lastActiveKey;
};

#endif // HALL_H