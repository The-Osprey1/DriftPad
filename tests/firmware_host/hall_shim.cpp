// C ABI over the real firmware HallKey (firmware/src/hall.cpp) for tests/test_firmware_parity.py.
// Compiled on the host together with hall.cpp and its keyboard output stack (mux_fake.cpp
// supplies the mux); private members are opened only to mirror
// HallKeyDSP(auto_polarity=False) and to read state the Python tests inspect.
#include <cstdint>
#include <cmath>
#define private public
#include "hall.h"
#undef private

extern "C" {

HallKey* hk_create(int autoPolarity) {
    HallKey::setActuationPoint(1.20f);
    HallKey::setRtSensitivity(0.20f);
    HallKey::setRapidTrigger(true);
    HallKey* k = new HallKey();
    k->init(0, 0, 0, "T");
    if (!autoPolarity) {
        k->_polarityDetected = true;
        k->_voltageIncreasesOnPress = true;
        k->_bottomRaw = k->_restBaseline + k->_dynamicRange;
    }
    return k;
}
void  hk_destroy(HallKey* k) { delete k; }
int   hk_update(HallKey* k, int raw) { return k->update((uint16_t)raw) ? 1 : 0; }
int   hk_inject(HallKey* k, float mm) { return k->injectSimulatedTravel(mm) ? 1 : 0; }
void  hk_set_actuation(float mm) { HallKey::setActuationPoint(mm); }
void  hk_set_rt_sens(float mm) { HallKey::setRtSensitivity(mm); }
void  hk_set_rt_enabled(int en) { HallKey::setRapidTrigger(en != 0); }
float hk_rt_press_mm() { return HallKey::s_rtPressMm; }
float hk_rt_release_mm() { return HallKey::s_rtReleaseMm; }
float hk_actuation_mm() { return HallKey::s_actuationPointMm; }
float hk_rt_sens_min_mm() { return HallKey::RT_SENS_MIN_MM; }
float hk_rt_sens_max_mm() { return HallKey::RT_SENS_MAX_MM; }
int   hk_is_pressed(HallKey* k) { return k->_isPressed ? 1 : 0; }
float hk_travel_mm(HallKey* k) { return k->_travelMm; }
float hk_rest_baseline(HallKey* k) { return k->_restBaseline; }
float hk_filtered_raw(HallKey* k) { return k->_filteredRaw; }
int   hk_polarity_detected(HallKey* k) { return k->_polarityDetected ? 1 : 0; }
int   hk_voltage_increases(HallKey* k) { return k->_voltageIncreasesOnPress ? 1 : 0; }
int   hk_unpressed_samples(HallKey* k) { return k->_unpressedSamples; }

}
