#include "display_publish.h"

#include <cstring>
#include "hall.h"
#include "config.h"
#include "keyboard_output.h"

void displayBuildSnapshot(display_link::Snapshot& out) {
    memset(&out, 0, sizeof(out));
    const bool trusted = calibrationEvaluate(configGet().calibration) == CalState::Valid &&
        KeyboardOutput::reason() != KeyboardOutput::Reason::CalibrationInProgress;
    const uint16_t faults = HallManager::faultMask();
    out.keyInputValid = trusted;
    out.faultMask = faults;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        HallKey& k = HallManager::getKey(i);
        display_link::KeyView& v = out.keys[i];
        v.pressCount = k.getPressCount();
        v.releaseCount = k.getReleaseCount();
        if (trusted && !(faults & (1u << i))) {
            v.travelMm = k.getTravelMm();
            v.pressed = k.isPressed();
        }
        strncpy(v.label, k.getLabel(), sizeof(v.label) - 1);
    }
    const int8_t last = HallManager::getLastActiveKey();
    out.lastActiveKey = trusted && last >= 0 && last < NUM_KEYS && !(faults & (1u << last)) ? last : -1;
    out.activeLayer = configGet().activeLayer;
    out.rapidTrigger = HallKey::isRapidTrigger();
    out.actuationMm = HallKey::getActuationPoint();
    out.rtSensMm = HallKey::getRtSensitivity();
    out.settingsDirty = configIsDirty();
    out.saveSeq = (uint8_t)configSettingsSeq();
    if (KeyboardOutput::isEnabled()) {
        out.outputStatus = display_link::OUTPUT_ON;
    } else {
        switch (KeyboardOutput::reason()) {
            case KeyboardOutput::Reason::CalibrationMissing:
            case KeyboardOutput::Reason::CalibrationInvalid:
                out.outputStatus = display_link::OUTPUT_NEEDS_CAL;
                break;
            case KeyboardOutput::Reason::CalibrationInProgress:
                out.outputStatus = display_link::OUTPUT_CALIBRATING;
                break;
            default:
                out.outputStatus = display_link::OUTPUT_OFF;
                break;
        }
    }
}

void displayPublish() {
    display_link::Snapshot s;
    displayBuildSnapshot(s);
    display_link::publish(s);
}
