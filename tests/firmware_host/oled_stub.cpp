// Host stand-in for firmware/src/oled.cpp (display + core 1). The display is not under test on
// the host; this keeps the menu page so encoder input runs the real encoderMenuApply(), records
// display calls for tests, and plays core 1 for the two requests with a result: a request is
// served at once, unless a test stalls "core 1" (oled_stub_stall) to reach display_timeout.
#include "oled.h"
#include "encoder_menu.h"

namespace {
MenuMode s_page = MenuMode::ADJUST_RT;
bool     s_fullscreen = true;
bool     s_sleeping = false;
bool     s_screensaver = false;
int8_t   s_anim = -1;
uint32_t s_wakes = 0;
bool     s_stalled = false;
uint32_t s_posted[2] = {0, 0};
uint32_t s_served[2] = {0, 0};
}

void oledInit() { s_page = MenuMode::ADJUST_RT; s_fullscreen = true; s_sleeping = false; s_screensaver = false; s_anim = -1; }
void oledCycleMenu() {
    s_page = (MenuMode)(((uint8_t)s_page + 1) % (uint8_t)MenuMode::COUNT);
}
bool oledAdjustCurrentSetting(int32_t delta) { return encoderMenuApply(s_page, delta); }
void oledSetFullScreen(bool enabled) { s_fullscreen = enabled; }
bool oledIsFullScreen() { return s_fullscreen; }
void oledTriggerScreensaver() { s_screensaver = true; s_sleeping = false; }
bool oledIsScreensaverActive() { return s_screensaver; }
void oledWake() { s_wakes++; s_sleeping = false; s_screensaver = false; }
void oledSleep() { s_sleeping = true; s_screensaver = false; }
bool oledIsSleeping() { return s_sleeping; }
void oledSetScreensaverAnim(int8_t idx) { s_anim = idx; }

uint32_t oledPost(OledRequest r) {
    const uint8_t i = (uint8_t)r;
    const uint32_t ticket = ++s_posted[i];
    if (!s_stalled) s_served[i] = ticket;
    return ticket;
}
bool oledRequestServed(OledRequest r, uint32_t ticket) {
    return ticket != 0 && (int32_t)(s_served[(uint8_t)r] - ticket) >= 0;
}
uint8_t oledBusScanResult(uint8_t* found, uint8_t max) {
    if (max > 0) found[0] = 0x3C;   // the OLED
    return 1;
}

extern "C" {
int oled_stub_page() { return (int)s_page; }
uint32_t oled_stub_wakes() { return s_wakes; }
int oled_stub_anim() { return s_anim; }
int oled_stub_sleeping() { return s_sleeping ? 1 : 0; }
// 1: "core 1" stops serving requests; 0: it serves everything posted so far and resumes
void oled_stub_stall(int on) {
    s_stalled = on != 0;
    if (!s_stalled) { s_served[0] = s_posted[0]; s_served[1] = s_posted[1]; }
}
}
