// Host stand-in for firmware/src/oled.cpp (display + core 1). The display is not under test on
// the host; this keeps the menu page so encoder input runs the real encoderMenuApply(), and
// records display calls for tests.
#include "oled.h"
#include "encoder_menu.h"

namespace {
MenuMode s_page = MenuMode::ADJUST_RT;
bool     s_fullscreen = true;
bool     s_sleeping = false;
bool     s_screensaver = false;
int8_t   s_anim = -1;
uint32_t s_wakes = 0;
}

void oledInit() { s_page = MenuMode::ADJUST_RT; s_fullscreen = true; s_sleeping = false; s_screensaver = false; s_anim = -1; }
void oledUpdate(bool) {}
void oledCycleMenu() {
    s_page = (MenuMode)(((uint8_t)s_page + 1) % (uint8_t)MenuMode::COUNT);
}
bool oledAdjustCurrentSetting(int32_t delta) { return encoderMenuApply(s_page, delta); }
void oledTestPattern() {}
uint8_t oledScanBus(uint8_t* found, uint8_t max) {
    if (max > 0) found[0] = 0x3C;   // the OLED
    return 1;
}
void oledSetFullScreen(bool enabled) { s_fullscreen = enabled; }
bool oledIsFullScreen() { return s_fullscreen; }
void oledTriggerScreensaver() { s_screensaver = true; s_sleeping = false; }
bool oledIsScreensaverActive() { return s_screensaver; }
void oledWake() { s_wakes++; s_sleeping = false; s_screensaver = false; }
void oledSleep() { s_sleeping = true; s_screensaver = false; }
bool oledIsSleeping() { return s_sleeping; }
void oledSetScreensaverAnim(int8_t idx) { s_anim = idx; }

extern "C" {
int oled_stub_page() { return (int)s_page; }
uint32_t oled_stub_wakes() { return s_wakes; }
int oled_stub_anim() { return s_anim; }
int oled_stub_sleeping() { return s_sleeping ? 1 : 0; }
}
