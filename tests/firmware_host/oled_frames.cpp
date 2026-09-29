// Renders the real oled.cpp screens on the host into a 128x64 framebuffer, with the real
// Adafruit_GFX doing the drawing (drivers are stubbed in gfx_shim/). oled.cpp is included so the
// harness can call its render functions directly; Wire and the panel do nothing.
#include "oled.cpp"

#include <cstdio>

TwoWire Wire;
bool encoderMenuApply(MenuMode, int32_t) { return false; }

extern "C" {
void host_clock_set_us(uint64_t);
void host_clock_advance_us(uint64_t);

// Scenes: 0 standby, 1 key travelling, 2 two keys actuated, 3 ENT bottomed out, 4 standby with
// calibration missing, 5 key travelling with output off, 6/7 held key backing off with Rapid Trigger
// on/off,
// 10..13 tuning menu pages, 20 splash, 30..35 screensaver animation N (its frame 40)
int oled_scene(int id, uint8_t* out) {
    static bool started = false;
    if (!started) {
        started = true;
        host_clock_set_us(100000000ULL);
        initDisplayHardware();
    }
    display_link::Snapshot s;
    memset(&s, 0, sizeof s);
    static const char* labels[16] = {"7", "8", "9", "/", "4", "5", "6", "*",
                                     "1", "2", "3", "-", "0", ".", "ENT", "+"};
    for (int i = 0; i < 16; i++) strcpy(s.keys[i].label, labels[i]);
    s.lastActiveKey = -1;
    s.rapidTrigger = true;
    s.actuationMm = 1.2f;
    s.rtSensMm = 0.2f;

    s_screensaverActive = false;
    s_menuLastActive = millis() - 10000;
    s_gridCountersSynced = false;
    s_focusKey = -1;
    // Scenes are steady-state frames: no card reveal or press flourish under way
    const bool sceneHasFocus = id == 1 || id == 2 || id == 3 || id == 5 || id == 6 || id == 7 || id == 8 || id == 9;
    s_prevHadFocus = sceneHasFocus;
    s_revealFrames = 0;
    s_cardPunch = 0;
    s_prevFocusActuated = id == 2 || id == 3 || id == 6 || id == 7 || id == 9;
    memset(s_focusSeenPress, 0, sizeof s_focusSeenPress);
    memset(s_lastPressCount, 0, sizeof s_lastPressCount);
    memset(s_lastReleaseCount, 0, sizeof s_lastReleaseCount);

    if (id == 8 || id == 9) {
        // the widest 4-character legends: a travelling key (8) and an actuated one (9)
        strcpy(s.keys[5].label, "WWWW");
        s.keys[5].travelMm = id == 8 ? 0.7f : 1.85f;
        s.keys[5].pressed = id == 9;
        s.keys[5].pressCount = id == 9 ? 1 : 0;
        s.lastActiveKey = 5;
    } else if (id == 6 || id == 7) {
        // key 5 held at 3.0 mm, then back up to 2.4 mm (Rapid Trigger release point: 3.0 - RT)
        s.rapidTrigger = id == 6;
        s.keys[5].pressed = true; s.keys[5].pressCount = 1; s.lastActiveKey = 5;
        s.keys[5].travelMm = 3.0f;
        display_link::publish(s);
        display_link::read(s_view);
        s_haveView = true;
        s_menuVisible = false; s_modeTransition = false;
        renderFullScreen();
        s.keys[5].travelMm = 2.4f;
    } else if (id == 4) {
        s.outputStatus = display_link::OUTPUT_NEEDS_CAL;
    } else if (id == 5) {
        s.outputStatus = display_link::OUTPUT_OFF;
        s.keys[5].travelMm = 0.7f; s.lastActiveKey = 5;
    } else if (id == 1) {
        s.keys[5].travelMm = 0.7f; s.keys[6].travelMm = 0.3f; s.lastActiveKey = 5;
    } else if (id == 2) {
        s.keys[5].travelMm = 1.85f; s.keys[5].pressed = true; s.keys[5].pressCount = 1;
        s.keys[13].travelMm = 3.9f; s.keys[13].pressed = true; s.keys[13].pressCount = 1;
        s.lastActiveKey = 5;
    } else if (id == 3) {
        s.keys[14].travelMm = 4.0f; s.keys[14].pressed = true; s.keys[14].pressCount = 1;
        s.lastActiveKey = 14;
    } else if (id >= 10 && id <= 13) {
        s.activeLayer = id == 13 ? 1 : 0;
        s_currentMenu = (MenuMode)(id - 10);
        s_menuLastActive = millis();
    }

    s_menuVisible = id >= 10 && id <= 13;   // scenes show their screen, not a wipe towards it
    s_modeTransition = false;
    display_link::publish(s);
    display_link::read(s_view);
    s_haveView = true;
    s_display.clearDisplay();
    if (id >= 30 && id <= 35) {
        s_screensaverActive = true;
        s_screensaverStartTime = millis();
        s_forcedAnim = (int8_t)(id - 30);
        s_ssShownAnim = -1;
        s_ssIncomingAnim = -1;
        for (int f = 0; f < 40; f++) renderScreensaver();
    } else if (id == 20) {
        s_fullScreenMode = true;
        drawSplash();
    } else {
        renderFullScreen();
    }
    memcpy(out, s_display.getBuffer(), 128 * 64 / 8);
    return 0;
}

int oled_text_wrap_enabled() { return s_display.textWrapEnabled() ? 1 : 0; }

// Idle dimming through the real loop1(): publishes a snapshot, advances the clock by dt_ms and
// runs one pass, then returns the contrast the panel was last given (touch != 0 presses a key).
// Puts the display's idle state back to "awake, just now, intro over" at the current fake time
void oled_idle_reset() {
    s_initialized = true;
    s_lastActivityTime = millis();
    s_isDimmed = false;
    s_screensaverActive = false;
    s_displaySleeping = false;
    s_introDone = true;
    s_haveView = false;
    s_forcedAnim = -1;
    s_forceRender = false;
    s_testPatternUntil = 0;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) s_activityRefTravel[i] = 0.0f;
    display_link::reset();
    s_display.ssd1306_command(SSD1306_SETCONTRAST);
    s_display.ssd1306_command(CONTRAST_FULL);
    s_display.ssd1306_command(SSD1306_SETPRECHARGE);
    s_display.ssd1306_command(PRECHARGE_FULL);
    s_display.ssd1306_command(SSD1306_SETVCOMDETECT);
    s_display.ssd1306_command(VCOMH_FULL);
}

int oled_idle_step(uint32_t dt_ms, int touch) {    display_link::Snapshot s;
    memset(&s, 0, sizeof s);
    s.lastActiveKey = -1;
    if (touch) { s.keys[0].travelMm = 2.0f; s.keys[0].pressed = true; }
    display_link::publish(s);
    host_clock_advance_us((uint64_t)dt_ms * 1000);
    loop1();
    return s_display.lastContrast;
}
// Key-map afterglow: renders one key-screen frame with key 5 held (held != 0) or released, without
// resetting the display state between calls, and returns the ink in that key's cell.
int oled_glow_step(int held) {
    static bool ready = false;
    if (!ready) {
        ready = true;
        s_gridCountersSynced = false;
        s_menuLastActive = millis() - 10000;
        s_haveView = true;
    }
    static uint8_t presses = 0;
    s_menuVisible = false;
    s_modeTransition = false;
    s_menuLastActive = 0;
    host_clock_set_us(100000000ULL);   // fixed time: the standby scan line sits away from key 5
    display_link::Snapshot s;
    memset(&s, 0, sizeof s);
    s.lastActiveKey = held ? 5 : -1;
    s.rapidTrigger = true;
    s.actuationMm = 1.2f;
    s.rtSensMm = 0.2f;
    if (held) { s.keys[5].travelMm = 2.0f; s.keys[5].pressed = true; s.keys[5].pressCount = (uint8_t)(presses = 1); }
    else s.keys[5].pressCount = presses;
    display_link::publish(s);
    display_link::read(s_view);
    s_screensaverActive = false;
    if (!held) s_focusKey = -1;   // the map itself is under test, not the focus marker
    renderFullScreen();
    int ink = 0;
    int16_t cx = MAP_X + (5 % 4) * (MAP_CELL + MAP_GAP), cy = MAP_Y + (5 / 4) * (MAP_CELL + MAP_GAP);
    for (int16_t y = cy; y < cy + MAP_CELL; ++y)
        for (int16_t x = cx; x < cx + MAP_CELL; ++x)
            if (s_display.getBuffer()[x + (y / 8) * 128] >> (y & 7) & 1) ink++;
    return ink;
}
// Menu opening wipe: the frame t_ms after the tuning card was requested (key screen underneath)
int oled_wipe_frame(uint32_t t_ms, uint8_t* out) {
    const uint64_t t0 = 200000000ULL;
    host_clock_set_us(t0);
    display_link::Snapshot s;
    memset(&s, 0, sizeof s);
    static const char* labels[16] = {"7", "8", "9", "/", "4", "5", "6", "*",
                                     "1", "2", "3", "-", "0", ".", "ENT", "+"};
    for (int i = 0; i < 16; i++) strcpy(s.keys[i].label, labels[i]);
    s.lastActiveKey = -1; s.rapidTrigger = true; s.actuationMm = 1.2f; s.rtSensMm = 0.2f;
    display_link::publish(s);
    display_link::read(s_view);
    s_haveView = true; s_screensaverActive = false; s_fullScreenMode = true;
    s_menuVisible = false; s_modeTransition = false;
    s_menuLastActive = millis() - 10000;
    s_currentMenu = MenuMode::ADJUST_ACTUATION;
    renderFullScreen();
    s_menuLastActive = millis() + 1;
    host_clock_set_us(t0 + 1000);
    renderFullScreen();                         // starts the transition
    host_clock_set_us(t0 + 1000 + (uint64_t)t_ms * 1000);
    renderFullScreen();
    memcpy(out, s_display.getBuffer(), 128 * 64 / 8);
    return s_modeTransition ? 1 : 0;
}
// Screensaver animation `anim` after `frames` frames (33 ms apart), for previews and motion checks
int oled_screensaver_frame(int anim, int frames, uint8_t* out) {
    static bool started = false;
    if (!started) { started = true; initDisplayHardware(); }
    host_clock_set_us(300000000ULL);
    s_screensaverActive = true;
    s_screensaverStartTime = millis();
    s_forcedAnim = (int8_t)anim;
    s_ssShownAnim = -1;
    s_ssIncomingAnim = -1;
    s_starsInit = false; s_ripplesInit = false;
    s_plasmaT = 0; s_tessA = s_tessB = s_tessC = 0.0f; s_gridScroll = 0.0f; s_gridFrame = 0; s_lavaTime = 0.0f;
    s_ssLabelSince = millis();
    srand(1);
    for (int f = 0; f < frames; f++) {
        renderScreensaver();
        host_clock_advance_us(33000);
    }
    memcpy(out, s_display.getBuffer(), 128 * 64 / 8);
    return 0;
}
// The power-up intro at `t_ms`, and whether loop1() has finished it
int oled_intro_frame(uint32_t t_ms, uint8_t* out) {
    static bool started = false;
    if (!started) { started = true; initDisplayHardware(); }
    // A fixed pad state so the frame is reproducible: labels, calibration missing
    display_link::Snapshot s;
    memset(&s, 0, sizeof s);
    static const char* labels[16] = {"7", "8", "9", "/", "4", "5", "6", "*", "1", "2", "3", "-", "0", ".", "ENT", "+"};
    for (int i = 0; i < 16; i++) strcpy(s.keys[i].label, labels[i]);
    s.lastActiveKey = -1; s.rapidTrigger = true; s.actuationMm = 1.2f; s.rtSensMm = 0.2f;
    s.outputStatus = display_link::OUTPUT_NEEDS_CAL;
    display_link::publish(s);
    display_link::read(s_view);
    s_haveView = true;
    s_menuLastActive = millis() - 10000;
    s_menuVisible = false; s_modeTransition = false;
    s_prevHadFocus = false; s_revealFrames = 0; s_cardPunch = 0; s_prevFocusActuated = false;
    presentIntro(t_ms);
    memcpy(out, s_display.getBuffer(), 128 * 64 / 8);
    return 0;
}
void oled_intro_restart() { s_introDone = false; s_introStart = millis(); }
int oled_intro_done() { return s_introDone ? 1 : 0; }
// One key-screen frame of a press on key 5 at the given travel, without resetting the display state:
// lets a test or a preview play a whole press (travel up, actuate, hold, release, fade) frame by frame
int oled_press_step(float travel_mm, int pressed, int press_count, uint8_t* out) {
    static bool ready = false;
    if (!ready) { ready = true; initDisplayHardware(); s_gridCountersSynced = false; s_haveView = true; }
    s_menuVisible = false; s_modeTransition = false; s_menuLastActive = 0; s_screensaverActive = false;
    host_clock_advance_us(33000);
    display_link::Snapshot s;
    memset(&s, 0, sizeof s);
    static const char* labels[16] = {"7", "8", "9", "/", "4", "5", "6", "*", "1", "2", "3", "-", "0", ".", "ENT", "+"};
    for (int i = 0; i < 16; i++) strcpy(s.keys[i].label, labels[i]);
    s.rapidTrigger = true; s.actuationMm = 1.2f; s.rtSensMm = 0.2f;
    s.keys[5].travelMm = travel_mm; s.keys[5].pressed = pressed != 0; s.keys[5].pressCount = (uint8_t)press_count;
    s.lastActiveKey = (travel_mm > 0.0f || pressed) ? 5 : -1;
    display_link::publish(s);
    display_link::read(s_view);
    renderFullScreen();
    memcpy(out, s_display.getBuffer(), 128 * 64 / 8);
    return 0;
}
void oled_last_frame(uint8_t* out) { memcpy(out, s_display.getBuffer(), 128 * 64 / 8); }
// Lit pixels in the frame buffer as last presented
int oled_lit_pixels() {
    int n = 0;
    for (int i = 0; i < 128 * 64 / 8; i++) n += __builtin_popcount(s_display.getBuffer()[i]);
    return n;
}
// Panel brightness state after oled_idle_step: 0 contrast, 1 pre-charge, 2 VCOMH
int oled_panel_level(int which) {
    return which == 0 ? s_display.lastContrast : which == 1 ? s_display.lastPrecharge : s_display.lastVcomh;
}
int oled_panel_level_full(int which) { return which == 0 ? CONTRAST_FULL : which == 1 ? PRECHARGE_FULL : VCOMH_FULL; }
int oled_panel_level_dim(int which) { return which == 0 ? CONTRAST_DIM : which == 1 ? PRECHARGE_DIM : VCOMH_DIM; }
int oled_contrast_full() { return CONTRAST_FULL; }
int oled_contrast_dim() { return CONTRAST_DIM; }
}
