// The pre-fix firmware's display API (oled.h at e2031e2) as no-ops, for defect-reproduction
// builds of the old main.cpp. The display itself is never under test there.
#include "oled.h"

void oledInit() {}
void oledUpdate(bool) {}
void oledCycleMenu() {}
bool oledAdjustCurrentSetting(int32_t) { return false; }
void oledTestPattern() {}
void oledScanBus() {}
void oledSetFullScreen(bool) {}
bool oledIsFullScreen() { return true; }
void oledTriggerScreensaver() {}
bool oledIsScreensaverActive() { return false; }
void oledWake() {}
void oledSleep() {}
bool oledIsSleeping() { return false; }
void oledSetScreensaverAnim(int8_t) {}
