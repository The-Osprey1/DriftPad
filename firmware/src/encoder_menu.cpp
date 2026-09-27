#include "encoder_menu.h"
#include "config.h"
#include "settings_limits.h"

namespace {

uint16_t stepClamped(uint16_t current, int32_t delta, uint16_t step, uint16_t lo, uint16_t hi) {
    int32_t v = (int32_t)current + delta * (int32_t)step;
    if (v < lo) v = lo;
    if (v > hi) v = hi;
    return (uint16_t)v;
}

} // namespace

bool encoderMenuApply(MenuMode page, int32_t delta) {
    if (delta == 0) return false;
    const DeviceSettings& cfg = configGet();

    switch (page) {
        case MenuMode::ADJUST_RT:
            return configSetRtSensCmm(stepClamped(cfg.rtSensCmm, delta, limits::ENCODER_RT_SENS_STEP_CMM,
                                                  limits::RT_SENS_MIN_CMM, limits::RT_SENS_MAX_CMM)) == ConfigStatus::Ok;
        case MenuMode::ADJUST_ACTUATION:
            return configSetActuationCmm(stepClamped(cfg.actuationCmm, delta, limits::ENCODER_ACTUATION_STEP_CMM,
                                                     limits::ACTUATION_MIN_CMM, limits::ACTUATION_MAX_CMM)) == ConfigStatus::Ok;
        case MenuMode::TOGGLE_RT:
            configSetRtEnabled(!cfg.rtEnabled);
            return true;
        case MenuMode::CYCLE_LAYER: {
            int8_t l = (int8_t)cfg.activeLayer + (delta > 0 ? 1 : -1);
            if (l < 0) l = NUM_LAYERS - 1;
            if (l >= NUM_LAYERS) l = 0;
            return configSetActiveLayer((uint8_t)l) == ConfigStatus::Ok;
        }
        default:
            return false;
    }
}
