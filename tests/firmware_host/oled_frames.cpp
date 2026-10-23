// Renders the real oled.cpp screens on the host into a 128x64 framebuffer, with the real
// Adafruit_GFX doing the drawing (drivers are stubbed in gfx_shim/). oled.cpp is included so the
// harness can call its render functions directly; Wire and the panel do nothing.
#include "oled.cpp"

#include <cstdio>

TwoWire Wire;
bool encoderMenuApply(MenuMode, int32_t) { return false; }

// The saved-state chip and the layer-change flash remember what they last saw; scenes that are not
// about them start from "nothing changed" so an earlier test's state cannot leak into their frames
static void forget_state_history() {
    s_saveSeqKnown = false; s_savedAt = 0; s_savedActive = false;
    s_layerSeen = -1; s_layerFlashAt = 0; s_layerFlashActive = false;
    s_menuRequested = false;
}

// No key has been pressed or focused before this frame (for scenes that are not a press sequence)
static void forget_press_history() {
    s_focusKey = -1;
    memset(s_focusSeenPress, 0, sizeof s_focusSeenPress);
    memset(s_lastPressCount, 0, sizeof s_lastPressCount);
    memset(s_lastReleaseCount, 0, sizeof s_lastReleaseCount);
}

extern "C" {
void host_clock_set_us(uint64_t);
void host_clock_advance_us(uint64_t);

// Scenes: 0 standby, 1 key travelling, 2 two keys actuated, 3 ENT bottomed out, 4 standby with
// calibration missing, 5 key travelling with output off, 6/7 held key backing off with Rapid Trigger
// on/off,
// 10..13 tuning menu pages, 20 splash, 30..35 screensaver animation N (its frame 40)
int oled_scene(int id, uint8_t* out) {
    forget_state_history();
    static bool started = false;
    if (!started) {
        started = true;
        host_clock_set_us(100000000ULL);
        initDisplayHardware();
    }
    display_link::Snapshot s;
    memset(&s, 0, sizeof s);
    s.keyInputValid = true;
    static const char* labels[16] = {"7", "8", "9", "/", "4", "5", "6", "*",
                                     "1", "2", "3", "-", "0", ".", "ENT", "+"};
    for (int i = 0; i < 16; i++) strcpy(s.keys[i].label, labels[i]);
    s.lastActiveKey = -1;
    s.rapidTrigger = true;
    s.actuationMm = 1.2f;
    s.rtSensMm = 0.2f;

    s_screensaverActive = false;
    s_menuLastActive = millis() - 10000;
    s_menuRequested = false;
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
        s_menuRequested = true;
    }

    s_menuVisible = id >= 10 && id <= 13;   // scenes show their screen, not a wipe towards it
    s_modeTransition = false;
    display_link::publish(s);
    display_link::read(s_view);
    s_haveView = true;
    s_display.clearDisplay();
    if (id >= 30 && id <= 35) {
        startScreensaver(millis(), (int8_t)(id - 30));
        s_ssPlayer.start(millis(), (int8_t)(id - 30), 1);
        resetScreensaverAnimations(1);
        for (int f = 0; f < 40; f++) {
            renderScreensaver();
            host_clock_advance_us(33000);
        }
    } else if (id == 20) {
        s_fullScreenMode = true;
        drawSplash();
    } else {
        renderFullScreen();
    }
    memcpy(out, s_display.getBuffer(), 128 * 64 / 8);
    return 0;
}

int oled_label_frame(const char* label, int pressed, uint8_t* out) {
    oled_scene(1, out);
    strncpy(s_view.keys[5].label, label, sizeof(s_view.keys[5].label) - 1);
    s_view.keys[5].label[sizeof(s_view.keys[5].label) - 1] = '\0';
    s_view.keys[5].travelMm = pressed ? 1.85f : 0.7f;
    s_view.keys[5].pressed = pressed != 0;
    s_view.keys[5].pressCount = pressed ? 1 : 0;
    s_view.keys[6].travelMm = 0.0f;
    s_view.lastActiveKey = 5;
    s_focusKey = 5;
    s_prevHadFocus = true;
    s_prevFocusActuated = pressed != 0;
    s_cardPunch = 0;
    s_revealFrames = 0;
    renderFullScreen();
    memcpy(out, s_display.getBuffer(), 128 * 64 / 8);
    return 0;
}

int oled_text_wrap_enabled() { return s_display.textWrapEnabled() ? 1 : 0; }

// Idle dimming through the real loop1(): publishes a snapshot, advances the clock by dt_ms and
// runs one pass, then returns the contrast the panel was last given (touch != 0 presses a key).
// Puts the display's idle state back to "awake, just now, intro over" at the current fake time
void oled_idle_reset() {
    forget_state_history();
    s_initialized = true;
    s_lastActivityTime = millis();
    s_isDimmed = false;
    s_screensaverActive = false;
    s_displaySleeping = false;
    s_introDone = true;
    s_haveView = false;
    s_forceRender = false;
    s_lastRenderTime = millis();
    s_testPatternAt = 0;
    s_testPatternActive = false;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) s_activityRefTravel[i] = 0.0f;
    memset(s_activityPressCount, 0, sizeof(s_activityPressCount));
    s_activityInputWasValid = false;
    display_link::reset();
    s_display.ssd1306_command(SSD1306_SETCONTRAST);
    s_display.ssd1306_command(CONTRAST_FULL);
    s_display.ssd1306_command(SSD1306_SETPRECHARGE);
    s_display.ssd1306_command(PRECHARGE_FULL);
    s_display.ssd1306_command(SSD1306_SETVCOMDETECT);
    s_display.ssd1306_command(VCOMH_FULL);
    publishDisplayState();
}

int oled_idle_travel_step(uint32_t dt_ms, float travel, int pressed) {
    display_link::Snapshot s;
    memset(&s, 0, sizeof s);
    s.keyInputValid = true;
    s.lastActiveKey = -1;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) s.keys[i].travelMm = travel;
    s.keys[0].pressed = pressed != 0;
    display_link::publish(s);
    host_clock_advance_us((uint64_t)dt_ms * 1000);
    loop1();
    return s_display.lastContrast;
}
int oled_idle_step(uint32_t dt_ms, int touch) {
    return oled_idle_travel_step(dt_ms, touch ? 2.0f : 0.0f, touch);
}
void oled_idle_start_screensaver() { startScreensaver(millis(), -1); }
int oled_idle_hidden() { return s_screensaverActive || s_displaySleeping ? 1 : 0; }
int oled_uncalibrated_intro_step(uint32_t dt_ms, int output) {
    display_link::Snapshot s;
    memset(&s, 0, sizeof s);
    s.keyInputValid = true;
    s.outputStatus = (uint8_t)output;
    s.keyInputValid = false;
    s.keys[0].travelMm = 4.0f;
    s.keys[0].pressed = true;
    display_link::publish(s);
    host_clock_advance_us((uint64_t)dt_ms * 1000);
    loop1();
    return s_introDone ? 1 : 0;
}
// Key-map afterglow: renders one key-screen frame with key 5 held (held != 0) or released, without
// resetting the display state between calls, and returns the ink in that key's cell.
int oled_glow_step(int held) {
    forget_state_history();
    static bool ready = false;
    if (!ready) {
        ready = true;
        s_gridCountersSynced = false;
        s_menuLastActive = millis() - 10000;
    s_menuRequested = false;
        s_haveView = true;
    }
    static uint8_t presses = 0;
    s_menuVisible = false;
    s_modeTransition = false;
    s_menuLastActive = 0;
    host_clock_set_us(100000000ULL);   // fixed time: the standby scan line sits away from key 5
    display_link::Snapshot s;
    memset(&s, 0, sizeof s);
    s.keyInputValid = true;
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
    forget_press_history();
    forget_state_history();
    const uint64_t t0 = 200000000ULL;
    host_clock_set_us(t0);
    display_link::Snapshot s;
    memset(&s, 0, sizeof s);
    s.keyInputValid = true;
    static const char* labels[16] = {"7", "8", "9", "/", "4", "5", "6", "*",
                                     "1", "2", "3", "-", "0", ".", "ENT", "+"};
    for (int i = 0; i < 16; i++) strcpy(s.keys[i].label, labels[i]);
    s.lastActiveKey = -1; s.rapidTrigger = true; s.actuationMm = 1.2f; s.rtSensMm = 0.2f;
    display_link::publish(s);
    display_link::read(s_view);
    s_haveView = true; s_screensaverActive = false; s_fullScreenMode = true;
    s_menuVisible = false; s_modeTransition = false;
    s_menuLastActive = millis() - 10000;
    s_menuRequested = false;
    s_currentMenu = MenuMode::ADJUST_ACTUATION;
    renderFullScreen();
    s_menuLastActive = millis() + 1;
    s_menuRequested = true;
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
    startScreensaver(millis(), (int8_t)anim);
    s_ssPlayer.start(millis(), (int8_t)anim, 1);
    resetScreensaverAnimations(1);
    for (int f = 0; f < frames; f++) {
        renderScreensaver();
        host_clock_advance_us(33000);
    }
    memcpy(out, s_display.getBuffer(), 128 * 64 / 8);
    return 0;
}
// The power-up intro at `t_ms`, and whether loop1() has finished it
int oled_intro_frame(uint32_t t_ms, uint8_t* out) {
    forget_press_history();
    forget_state_history();
    static bool started = false;
    if (!started) { started = true; initDisplayHardware(); }
    // A fixed pad state so the frame is reproducible: labels, calibration missing
    display_link::Snapshot s;
    memset(&s, 0, sizeof s);
    s.keyInputValid = true;
    static const char* labels[16] = {"7", "8", "9", "/", "4", "5", "6", "*", "1", "2", "3", "-", "0", ".", "ENT", "+"};
    for (int i = 0; i < 16; i++) strcpy(s.keys[i].label, labels[i]);
    s.lastActiveKey = -1; s.rapidTrigger = true; s.actuationMm = 1.2f; s.rtSensMm = 0.2f;
    s.outputStatus = display_link::OUTPUT_NEEDS_CAL;
    display_link::publish(s);
    display_link::read(s_view);
    s_haveView = true;
    s_menuLastActive = millis() - 10000;
    s_menuRequested = false;
    s_menuVisible = false; s_modeTransition = false;
    s_prevHadFocus = false; s_revealFrames = 0; s_cardPunch = 0; s_prevFocusActuated = false;
    presentIntro(t_ms);
    memcpy(out, s_display.getBuffer(), 128 * 64 / 8);
    return 0;
}
void oled_intro_restart() { s_introDone = false; s_introStart = millis(); }
int oled_intro_done() { return s_introDone ? 1 : 0; }
void oled_manual_reset() {
    oled_idle_reset();
    oledInit();
    s_menuVisible = false;
    s_modeTransition = false;
    s_encoderWokeDisplay = false;
    display_link::Snapshot s;
    memset(&s, 0, sizeof s);
    s.keyInputValid = true;
    s.lastActiveKey = -1;
    s.actuationMm = 1.2f;
    s.rtSensMm = 0.2f;
    display_link::publish(s);
    display_link::read(s_view);
    s_haveView = true;
    renderFullScreen();
}
int oled_manual_step(int action, uint32_t dt_ms) {
    host_clock_advance_us((uint64_t)dt_ms * 1000);
    if (action == 1) oledCycleMenu();
    if (action == 2) oledAdjustCurrentSetting(1);
    if (action == 3) oledAdjustCurrentSetting(0);
    renderFullScreen();
    return s_menuVisible ? (int)s_currentMenu : -1;
}
// One key-screen frame of a press on key 5 at the given travel, without resetting the display state:
// lets a test or a preview play a whole press (travel up, actuate, hold, release, fade) frame by frame
int oled_press_step(float travel_mm, int pressed, int press_count, uint8_t* out) {
    forget_state_history();
    static bool ready = false;
    if (!ready) { ready = true; initDisplayHardware(); s_gridCountersSynced = false; s_haveView = true; }
    s_menuVisible = false; s_modeTransition = false; s_menuLastActive = 0; s_screensaverActive = false;
    host_clock_advance_us(33000);
    display_link::Snapshot s;
    memset(&s, 0, sizeof s);
    s.keyInputValid = true;
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
// Saved-state and layer-change steps on the key screen (nothing focused): the clock advances by
// dt_ms, then one frame is drawn from a snapshot with the given flags
static void keyscreen_step(int dirty, int save_seq, int layer, uint32_t dt_ms, uint8_t* out,
                          int output = display_link::OUTPUT_ON, bool focused = false) {
    static bool ready = false;
    if (!ready) { ready = true; initDisplayHardware(); s_haveView = true; }
    host_clock_advance_us((uint64_t)dt_ms * 1000);
    s_menuVisible = false; s_modeTransition = false; s_menuLastActive = millis() - 10000;
    s_menuRequested = false; s_screensaverActive = false;
    s_focusKey = -1; s_prevHadFocus = false; s_revealFrames = 0;
    memset(s_focusSeenPress, 0, sizeof s_focusSeenPress);
    memset(s_lastPressCount, 0, sizeof s_lastPressCount);
    memset(s_lastReleaseCount, 0, sizeof s_lastReleaseCount);
    display_link::Snapshot s;
    memset(&s, 0, sizeof s);
    s.keyInputValid = true;
    static const char* labels[16] = {"7", "8", "9", "/", "4", "5", "6", "*", "1", "2", "3", "-", "0", ".", "ENT", "+"};
    for (int i = 0; i < 16; i++) strcpy(s.keys[i].label, labels[i]);
    s.lastActiveKey = -1; s.rapidTrigger = true; s.actuationMm = 1.2f; s.rtSensMm = 0.2f;
    s.settingsDirty = dirty != 0; s.saveSeq = (uint8_t)save_seq; s.activeLayer = (uint8_t)layer;
    s.outputStatus = (uint8_t)output;
    if (focused) { s.keys[5].travelMm = 2.0f; s.keys[5].pressed = true; s.lastActiveKey = 5; }
    display_link::publish(s);
    display_link::read(s_view);
    renderFullScreen();
    memcpy(out, s_display.getBuffer(), 128 * 64 / 8);
}
void oled_state_reset() { forget_state_history(); }
const char* oled_settings_text() { const char* text = settingsChipText(millis()); return text ? text : ""; }
int oled_settings_step(int dirty, int save_seq, uint32_t dt_ms, uint8_t* out) {
    keyscreen_step(dirty, save_seq, 0, dt_ms, out);
    return 0;
}
int oled_layer_step(int layer, uint32_t dt_ms, uint8_t* out) {
    keyscreen_step(0, 0, layer, dt_ms, out);
    return 0;
}
void oled_context_step(int layer, int dirty, int output, int focused, uint32_t dt_ms, uint8_t* out) {
    keyscreen_step(dirty, 0, layer, dt_ms, out, output, focused != 0);
}
void oled_last_frame(uint8_t* out) { memcpy(out, s_display.getBuffer(), 128 * 64 / 8); }

void oled_saver_start(int anim, uint32_t seed) {
    startScreensaver(millis(), static_cast<int8_t>(anim));
    s_ssPlayer.start(millis(), static_cast<int8_t>(anim), seed);
    resetScreensaverAnimations(seed);
}
void oled_saver_step(uint32_t dt_ms, uint8_t* out) {
    host_clock_advance_us((uint64_t)dt_ms * 1000);
    renderScreensaver();
    memcpy(out, s_display.getBuffer(), 1024);
}
int oled_saver_state(int which) {
    if (which == 0) return s_ssPlayer.shown();
    if (which == 1) return s_ssPlayer.incoming();
    if (which == 2) return s_ssPlayer.shuffled() ? 1 : 0;
    if (which == 3) return s_ssPlayer.labelAge(millis());
    return s_screensaverActive ? 1 : 0;
}
void oled_animation_reset(uint32_t seed) { resetScreensaverAnimations(seed); }
void oled_animation_step(int anim, uint32_t dt_ms, uint8_t* out) {
    advanceScreensaverAnimation(anim, dt_ms);
    s_display.clearDisplay();
    kScreensaverAnims[anim].render();
    memcpy(out, s_display.getBuffer(), 1024);
}
int oled_activity_step(uint32_t dt_ms, float travel, int pressed, int presses, int trusted) {
    display_link::Snapshot s;
    memset(&s, 0, sizeof(s));
    s.keyInputValid = trusted != 0;
    s.lastActiveKey = -1;
    s.keys[0].travelMm = travel;
    s.keys[0].pressed = pressed != 0;
    s.keys[0].pressCount = static_cast<uint8_t>(presses);
    display_link::publish(s);
    host_clock_advance_us((uint64_t)dt_ms * 1000);
    loop1();
    return s_screensaverActive || s_displaySleeping ? 1 : 0;
}
void oled_idle_sleep() { sleepDisplay(); }
void oled_display_action_post(int action) {
    display_link::post(action == 0 ? Request::Wake : action == 1 ? Request::Sleep : Request::Screensaver, 2);
}
int oled_panel_powered_on() { return s_display.poweredOn ? 1 : 0; }
uint32_t oled_frame_count() { return s_display.displayCount; }
int oled_display_state(int which) {
    auto state = display_link::displayState();
    if (which == 0) return static_cast<int>(state.mode);
    if (which == 1) return state.animation;
    if (which == 2) return state.available;
    if (which == 3) return state.shuffled;
    return state.dimmed;
}
void oled_clock_set_ms(uint32_t now) { host_clock_set_us((uint64_t)now * 1000); }
void oled_test_pattern_start() {
    display_link::post(Request::TestPattern);
}
void oled_panel_present(int present) { Wire.oledPresent = present != 0; }
void oled_hardware_retry_reset() {
    s_initialized = false;
    s_lastInitAttempt = millis() - DISPLAY_RETRY_MS;
    s_introDone = true;
    publishDisplayState();
}
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
