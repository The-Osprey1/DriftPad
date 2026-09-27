#include "display_publish.h"

#include <cstring>
#include "hall.h"
#include "config.h"

void displayBuildSnapshot(display_link::Snapshot& out) {
    memset(&out, 0, sizeof(out));
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        HallKey& k = HallManager::getKey(i);
        display_link::KeyView& v = out.keys[i];
        v.travelMm = k.getTravelMm();
        v.pressCount = k.getPressCount();
        v.releaseCount = k.getReleaseCount();
        v.pressed = k.isPressed();
        strncpy(v.label, k.getLabel(), sizeof(v.label) - 1);
    }
    out.lastActiveKey = HallManager::getLastActiveKey();
    out.activeLayer = configGet().activeLayer;
    out.rapidTrigger = HallKey::isRapidTrigger();
    out.actuationMm = HallKey::getActuationPoint();
    out.rtSensMm = HallKey::getRtSensitivity();
}

void displayPublish() {
    display_link::Snapshot s;
    displayBuildSnapshot(s);
    display_link::publish(s);
}
