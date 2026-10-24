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
        case MenuMode::KNOB: {
            const uint8_t layer = cfg.activeLayer < NUM_LAYERS ? cfg.activeLayer : 0;
            int8_t m = (int8_t)cfg.knobMode[layer] + (delta > 0 ? 1 : -1);
            if (m < 0) m = limits::KNOB_MODE_COUNT - 1;
            if (m >= (int8_t)limits::KNOB_MODE_COUNT) m = 0;
            return configSetKnobMode(layer, (uint8_t)m) == ConfigStatus::Ok;
        }
        case MenuMode::THEME: {
            int8_t t = (int8_t)cfg.theme + (delta > 0 ? 1 : -1);
            if (t < 0) t = limits::THEME_COUNT - 1;
            if (t >= (int8_t)limits::THEME_COUNT) t = 0;
            return configSetTheme((uint8_t)t) == ConfigStatus::Ok;
        }
        default:
            return false;
    }
}
