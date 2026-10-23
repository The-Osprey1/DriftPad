#include "oled.h"
#include "pins.h"
#include "display_link.h"
#include "settings_limits.h"
#include "encoder_menu.h"
#include "build_info.h"
#include "screensaver_player.h"
#include "theme_sakura.h"
#include "theme_space.h"

#include <Arduino.h>
#include <Wire.h>

static_assert(OLED_ANIM_COUNT == limits::SAVER_ANIM_COUNT, "the stored screensaver choice indexes these animations");
#include <Adafruit_GFX.h>
#include <Fonts/FreeSansBold9pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSansBold18pt7b.h>

#if USE_SH1106
#include <Adafruit_SH110X.h>
#else
#include <Adafruit_SSD1306.h>
#endif

namespace {

constexpr uint8_t SCREEN_WIDTH = 128;
constexpr uint8_t SCREEN_HEIGHT = 64;

#if USE_SH1106
Adafruit_SH1106G s_display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
#define OLED_COLOR_WHITE   SH110X_WHITE
#define OLED_COLOR_BLACK   SH110X_BLACK
#define OLED_COLOR_INVERSE SH110X_INVERSE
#else
Adafruit_SSD1306 s_display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
#define OLED_COLOR_WHITE   SSD1306_WHITE
#define OLED_COLOR_BLACK   SSD1306_BLACK
#define OLED_COLOR_INVERSE SSD1306_INVERSE
#endif

using display_link::Request;

// Ownership (display_link.h): core 1 owns Wire, the display driver and everything drawn. Core 0
// only changes the menu state below and posts requests. Each variable has one writing core:
//   core 0 writes: s_currentMenu, s_menuLastActive, s_menuRequested, s_fullScreenMode, s_requestedAnim
//   core 1 writes: everything else (the display state flags are read by core 0 for replies)
volatile MenuMode s_currentMenu = MenuMode::ADJUST_RT;
volatile uint32_t s_menuLastActive = 0;
volatile bool s_menuRequested = false;  // selected by encoder input, never an idle timer
volatile bool s_fullScreenMode = true;
int8_t s_requestedAnim = -1;          // core 0: the animation the next screensaver request asks for

uint32_t s_lastRenderTime = 0;
constexpr uint32_t RENDER_INTERVAL_MS = 33; // ~30 FPS
constexpr uint32_t DISPLAY_RETRY_MS = 2000;  // display missing at power-up: probe again this often
constexpr uint32_t TEST_PATTERN_MS = 2000;   // OLED_TEST keeps the pattern on screen this long

volatile bool s_initialized = false;
bool s_forceRender = false;
volatile bool s_screensaverActive = false;
volatile bool s_displaySleeping = false;
uint32_t s_screensaverStartTime = 0;
constexpr uint8_t CONTRAST_FULL = 0xFF;
constexpr uint8_t CONTRAST_DIM = 0x40;      // the screensaver runs at about a quarter of full contrast
constexpr uint8_t PRECHARGE_FULL = 0xF1;   // also set by configure128x64Hardware()
constexpr uint8_t PRECHARGE_DIM = 0x22;    // shorter phases: the pixel driver is on for less time
constexpr uint8_t VCOMH_FULL = 0x40;
constexpr uint8_t VCOMH_DIM = 0x20;        // lower COM deselect level
constexpr uint32_t SCREENSAVER_DIM_DELAY_MS = 180000;   // the screensaver dims this long (3 minutes) after it starts
uint32_t s_lastActivityTime = 0;
uint32_t s_lastInitAttempt = 0;
uint32_t s_testPatternAt = 0;
bool s_testPatternActive = false;
bool s_isDimmed = false;

// Core 1's copy of the snapshot core 0 publishes, taken at the start of every loop1() pass. The
// renderer reads key state and settings only from here.
display_link::Snapshot s_view;
bool s_haveView = false;

// Edge counters already shown by the key map
static uint8_t s_lastPressCount[NUM_KEYS] = {0};
static uint8_t s_lastReleaseCount[NUM_KEYS] = {0};
static bool s_gridCountersSynced = false;

// Key map afterglow: frames of fade left on a key that was just released, so a quick tap (one
// frame of solid) leaves a trail the eye can catch. Display only, like everything here.
constexpr uint8_t GLOW_FRAMES = 8;
static uint8_t s_keyGlow[NUM_KEYS] = {0};

// Deepest travel of a held key, kept only to show where Rapid Trigger will release it
// (peak minus the RT sensitivity). Sampled per frame, so a very fast stroke can peak deeper than
// it shows; the marker is a guide, the sensing engine decides the release.
static float s_keyPeak[NUM_KEYS] = {0};

// Display focus: which key the left panel shows. Display selection only; HID and the
// Rapid Trigger state machine never read it. Keeps its own copy of the press counts so
// it never consumes the grid latches above.
constexpr float FOCUS_ACQUIRE_MM = 0.30f;   // meaningful travel: twice REST_DRIFT_THRESHOLD_MM
constexpr float FOCUS_REST_MM = 0.15f;      // at rest for settling
constexpr uint32_t FOCUS_SETTLE_MS = 100;   // focused key must stay at rest this long to let go
static int8_t s_focusKey = -1;
static uint8_t s_focusSeenPress[NUM_KEYS] = {0};
static bool s_focusSettling = false;
static uint32_t s_focusRestSince = 0;
static bool s_keyInputWasValid = false;

// Discards stale latches/counts accumulated while non-grid screens were visible
void discardGridLatches() {
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        s_lastPressCount[i] = s_view.keys[i].pressCount;
        s_lastReleaseCount[i] = s_view.keys[i].releaseCount;
        s_focusSeenPress[i] = s_lastPressCount[i];
        s_keyGlow[i] = 0;
        s_keyPeak[i] = 0.0f;
    }
}

// Picks the focused key for this frame:
//  1. A new actuation always takes focus (the last active key of the snapshot, else the deepest).
//  2. A focused key keeps focus until it is released and has sat at rest for FOCUS_SETTLE_MS;
//     other keys moving or going deeper never steal it.
//  3. With no focus, the deepest key that is held or has moved FOCUS_ACQUIRE_MM acquires it.
// The gap between FOCUS_REST_MM and FOCUS_ACQUIRE_MM keeps noise at rest from flickering it.
void selectDisplayFocus(uint32_t now) {
    if (!s_view.keyInputValid) {
        s_focusKey = -1;
        s_focusSettling = false;
        return;
    }
    int8_t newPress = -1;
    int8_t lastActive = s_view.lastActiveKey;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        uint8_t presses = s_view.keys[i].pressCount;
        if (presses != s_focusSeenPress[i]) {
            s_focusSeenPress[i] = presses;
            if (newPress < 0 || i == lastActive ||
                (newPress != lastActive &&
                 s_view.keys[i].travelMm > s_view.keys[(uint8_t)newPress].travelMm)) {
                newPress = (int8_t)i;
            }
        }
    }
    if (newPress >= 0) {
        s_focusKey = newPress;
        s_focusSettling = false;
        return;
    }

    if (s_focusKey >= 0) {
        const display_link::KeyView& k = s_view.keys[(uint8_t)s_focusKey];
        if (k.pressed || k.travelMm > FOCUS_REST_MM) {
            s_focusSettling = false;
            return;
        }
        if (!s_focusSettling) {
            s_focusSettling = true;
            s_focusRestSince = now;
        }
        if (now - s_focusRestSince < FOCUS_SETTLE_MS) return;
        s_focusKey = -1;
        s_focusSettling = false;
    }

    float deepest = 0.0f;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        const display_link::KeyView& k = s_view.keys[i];
        float mm = k.travelMm;
        if ((k.pressed || mm >= FOCUS_ACQUIRE_MM) && (s_focusKey < 0 || mm > deepest)) {
            s_focusKey = (int8_t)i;
            deepest = mm;
        }
    }
}

// Display-only travel readout: 0.1mm resolution with hysteresis so ADC noise
// (a few hundredths of a mm) doesn't make the digits flicker at rest.
static float s_shownTravel[NUM_KEYS] = {0};
float displayTravelMm(uint8_t keyIdx, float mm) {
    float& shown = s_shownTravel[keyIdx];
    if (mm < 0.05f) {
        shown = 0.0f;
    } else if (fabsf(mm - shown) > 0.07f) {
        shown = roundf(mm * 10.0f) / 10.0f;
    }
    return shown;
}

const char* const LAYER_NAMES[] = {"NUMPAD", "NAV", "GAMING"};

const char* layerName(uint8_t layer) {
    return layer < 3 ? LAYER_NAMES[layer] : "?";
}

// The theme in the settings (0 Drift, 1 Cherry blossom, 2 Space); Drift until core 0 has published
// one. A theme this firmware does not have draws as Drift.
constexpr uint8_t THEME_DRIFT = 0;
constexpr uint8_t THEME_SAKURA = 1;
constexpr uint8_t THEME_SPACE = 2;
uint8_t activeTheme() {
    return s_haveView && s_view.theme < limits::THEME_COUNT ? s_view.theme : THEME_DRIFT;
}
bool sakuraTheme() { return activeTheme() == THEME_SAKURA; }
bool spaceTheme() { return activeTheme() == THEME_SPACE; }
// Every theme but Drift letters its labels and values plainly; the slit italic is Drift's
bool plainLettering() { return activeTheme() != THEME_DRIFT; }

// Cherry blossom: petals thrown up by key presses and dropped by the standby sprig
sakura::Petals s_keyPetals;
sakura::Scene s_sakuraScene;    // the Sakura screensaver (animation 6)
space::Scene s_spaceScene;      // the Orbit screensaver (animation 7)
uint32_t s_keyPetalsAt = 0;
uint32_t s_sprigDropAt = 0;

// Width in pixels of a string in the built-in 6x8 font (no trailing gap)
int16_t textWidth(const char* text, uint8_t size = 1) {
    return (int16_t)(strlen(text) * 6 * size) - size;
}

void printCentered(const char* text, int16_t centerX, int16_t y, uint8_t size = 1) {
    s_display.setTextSize(size);
    s_display.setCursor(centerX - textWidth(text, size) / 2, y);
    s_display.print(text);
}

void drawCornerBrackets() {
    s_display.drawFastHLine(0, 0, 8, OLED_COLOR_WHITE);
    s_display.drawFastVLine(0, 0, 6, OLED_COLOR_WHITE);
    s_display.drawFastHLine(119, 0, 9, OLED_COLOR_WHITE);
    s_display.drawFastVLine(127, 0, 6, OLED_COLOR_WHITE);
    s_display.drawFastHLine(0, 63, 8, OLED_COLOR_WHITE);
    s_display.drawFastVLine(0, 57, 7, OLED_COLOR_WHITE);
    s_display.drawFastHLine(119, 63, 9, OLED_COLOR_WHITE);
    s_display.drawFastVLine(127, 57, 7, OLED_COLOR_WHITE);
}

// Animation 0: 3D Warp Starfield & Floating Badge
struct Star {
    int16_t x, y, z;
    int16_t prev_x, prev_y;
    int16_t screen_x, screen_y;
};
constexpr uint8_t NUM_STARS = 56;
Star s_stars[NUM_STARS];
bool s_starsInit = false;
uint16_t s_starFrame = 0;   // 3072 steps is a common period of all three steering phases

// Core 1 owns this generator. Animation resets and updates are the only consumers, so drawing
// the same state twice cannot change motion or consume the core 0 application's random stream.
uint32_t s_animationRandom = 1;
uint8_t s_animationRemainderMs[OLED_ANIM_COUNT] = {0};
bool s_animationInitialized[OLED_ANIM_COUNT] = {false};
constexpr uint8_t ANIMATION_MAX_CATCHUP_STEPS = 8;

uint32_t animationRandom(uint32_t bound) {
    uint32_t next = s_animationRandom;
    next ^= next << 13;
    next ^= next >> 17;
    next ^= next << 5;
    s_animationRandom = next;
    return next % bound;
}


void initStarfield() {
    for (uint8_t i = 0; i < NUM_STARS; ++i) {
        s_stars[i].x = (int16_t)animationRandom(240) - 120;
        s_stars[i].y = (int16_t)animationRandom(120) - 60;
        s_stars[i].z = (int16_t)animationRandom(90) + 10;
        s_stars[i].prev_x = -1;
        s_stars[i].prev_y = -1;
        s_stars[i].screen_x = 64 + (s_stars[i].x * 45) / s_stars[i].z;
        s_stars[i].screen_y = 41 + (s_stars[i].y * 45) / s_stars[i].z;
    }
    s_starsInit = true;
}

// Animation 1: Plasma. Four interfering sine fields (an integer sine table and a square-root table
// for the distance from the centre, so a frame is table lookups only), banded, then Bayer-dithered.
constexpr uint16_t PLASMA_LUT_SIZE = 848;        // (dx^2 + dy^2) / 8 for the screen's corners is 839
uint8_t s_sin[256];                              // sin over one period, 0..255 (ensureSin())
bool s_sinInit = false;
uint8_t s_plasmaRoot[PLASMA_LUT_SIZE];           // distance from the centre (scaled) by squared distance / 8
uint16_t s_plasmaDx2[SCREEN_WIDTH];              // squared horizontal distance from the centre
bool s_plasmaInit = false;
uint16_t s_plasmaT = 0;

void ensureSin() {
    if (s_sinInit) return;
    for (uint16_t i = 0; i < 256; ++i) {
        s_sin[i] = (uint8_t)(127.5f + 127.5f * sinf(i * (6.2831853f / 256.0f)));
    }
    s_sinInit = true;
}

void initPlasma() {
    ensureSin();
    for (uint16_t i = 0; i < PLASMA_LUT_SIZE; ++i) {
        s_plasmaRoot[i] = (uint8_t)(sqrtf((float)i * 8.0f) * 3.0f);
    }
    for (uint8_t x = 0; x < SCREEN_WIDTH; ++x) {
        int16_t dx = (int16_t)x - 64;
        s_plasmaDx2[x] = (uint16_t)(dx * dx);
    }
    s_plasmaInit = true;
}

// Animation 2: Tesseract. A 4-D hypercube spun in three planes, projected 4-D -> 3-D -> 2-D.
constexpr uint8_t TESS_VERTS = 16;
float s_tessA = 0.0f;
float s_tessB = 0.0f;
float s_tessC = 0.0f;

// Animation 3: Synthwave Horizon Grid
float s_gridScroll = 0.0f;
uint8_t s_gridTwinklePhase = 0;  // modulo 48
uint8_t s_gridSlitPhase = 0;     // modulo 16, four steps per sun-slit offset
uint16_t s_gridDriftPhase = 0;   // modulo 512, two steps per mountain sine sample

// Animation 4: Magnetic Pulse Ripples
struct Ripple {
    int16_t x, y;
    int16_t maxR;
    float t;        // Progress 0..1 (negative: waiting to spawn); the radius eases out with it
    float step;     // Progress per frame
};
constexpr uint8_t NUM_RIPPLES = 5;
Ripple s_ripples[NUM_RIPPLES];
bool s_ripplesInit = false;
uint8_t s_rippleSparkPhase = 0;  // modulo 4

// Animation 5: Lava Lamp metaballs (field sampled on a 4 px grid, interpolated per pixel)
constexpr uint8_t LAVA_BLOBS = 5;
constexpr uint8_t LAVA_GX = SCREEN_WIDTH / 4 + 1;
constexpr uint8_t LAVA_GY = SCREEN_HEIGHT / 4 + 1;
uint16_t s_lavaGrid[LAVA_GY][LAVA_GX];
uint16_t s_lavaRows[3][SCREEN_WIDTH];   // Rolling window of interpolated field rows (y-1, y, y+1)
struct LavaBlob {
    uint8_t cx, swingX;
    float speedX, speedY, phase;
    uint8_t radius;
};
const LavaBlob kLavaBlobs[LAVA_BLOBS] = {
    {30, 10, 0.21f, 0.31f, 0.0f, 13},
    {64, 14, 0.17f, 0.23f, 2.1f, 11},
    {96,  9, 0.26f, 0.37f, 4.0f, 12},
    {48, 12, 0.29f, 0.19f, 1.3f,  9},
    {84, 11, 0.15f, 0.27f, 5.2f, 10},
};
float s_lavaPhaseX[LAVA_BLOBS] = {0};
float s_lavaPhaseY[LAVA_BLOBS] = {0};
struct LavaBubble { float x, y, vy, phase; uint8_t r; };
constexpr uint8_t LAVA_BUBBLES = 6;
LavaBubble s_lavaBubbles[LAVA_BUBBLES];

// Core 1 owns playback, animation state, brightness and the shuffle generator.
constexpr uint8_t NUM_SCREENSAVER_ANIMS = screensaver::COUNT;
static_assert(NUM_SCREENSAVER_ANIMS == OLED_ANIM_COUNT, "protocol and player animation counts differ");
screensaver::Player s_ssPlayer;
uint32_t s_ssLastFrameMs = 0;
uint32_t s_ssSessionNonce = 0;
uint8_t s_ssScratch[SCREEN_WIDTH * SCREEN_HEIGHT / 8];

void publishDisplayState() {
    using display_link::DisplayMode;
    display_link::DisplayState state;
    state.available = s_initialized;
    state.mode = s_displaySleeping ? DisplayMode::Sleep :
        s_screensaverActive ? DisplayMode::Screensaver : DisplayMode::Screen;
    state.animation = s_screensaverActive ? s_ssPlayer.shown() : -1;
    if (s_screensaverActive && s_ssPlayer.incoming() >= 0 &&
        s_ssPlayer.transitionElapsed(millis()) >= screensaver::TRANSITION_MS / 2) {
        state.animation = s_ssPlayer.incoming();
    }
    state.shuffled = s_screensaverActive && s_ssPlayer.shuffled();
    state.dimmed = s_isDimmed;
    display_link::publishDisplayState(state);
}

void configure128x64Hardware() {
    // Explicitly enforce 128x64 Interleaved COM hardware configuration for Hosyond SSD1306:
    s_display.ssd1306_command(SSD1306_SETMULTIPLEX);     // 0xA8
    s_display.ssd1306_command(0x3F);                     // 64MUX (64 lines)
    s_display.ssd1306_command(SSD1306_SETDISPLAYOFFSET); // 0xD3
    s_display.ssd1306_command(0x00);                     // 0 offset
    s_display.ssd1306_command(SSD1306_SETSTARTLINE | 0x00); // Line 0
    s_display.ssd1306_command(SSD1306_SETCOMPINS);       // 0xDA
    s_display.ssd1306_command(0x12);                     // Alternative (interleaved) COM pin config
    s_display.ssd1306_command(SSD1306_SETCONTRAST);      // 0x81
    s_display.ssd1306_command(CONTRAST_FULL);            // Max brightness
    s_display.ssd1306_command(SSD1306_SETPRECHARGE);     // 0xD9
    s_display.ssd1306_command(PRECHARGE_FULL);
    s_display.ssd1306_command(SSD1306_SETVCOMDETECT);    // 0xDB
    s_display.ssd1306_command(VCOMH_FULL);
}

// Panel brightness only; the frame content is untouched. Contrast alone is barely visible on some
// panels, so the pre-charge and VCOMH levels are lowered with it. dim(false) would restore the
// library's default contrast, not the CONTRAST_FULL set in configure128x64Hardware(), so it is not
// used.
void setDimmed(bool dim) {
    s_display.ssd1306_command(SSD1306_SETCONTRAST);
    s_display.ssd1306_command(dim ? CONTRAST_DIM : CONTRAST_FULL);
    s_display.ssd1306_command(SSD1306_SETPRECHARGE);
    s_display.ssd1306_command(dim ? PRECHARGE_DIM : PRECHARGE_FULL);
    s_display.ssd1306_command(SSD1306_SETVCOMDETECT);
    s_display.ssd1306_command(dim ? VCOMH_DIM : VCOMH_FULL);
    s_isDimmed = dim;
}

bool initDisplayHardware() {
    // begin() allocates a framebuffer even when the panel is absent. Require an ACK
    // so the existing retry loop and reported availability reflect initialization.
    Wire.beginTransmission(0x3C);
    if (Wire.endTransmission() != 0) return false;
    if (!s_display.begin(SSD1306_SWITCHCAPVCC, 0x3C, false, false)) {
        return false;
    }
    configure128x64Hardware();
    // Text that would cross the right edge is clipped, never wrapped onto the row below: a
    // right-aligned "RT 0.20mm" ends on x=127 and its last glyph used to land on the next line
    s_display.setTextWrap(false);
    return true;
}

void renderSafeZoneScreen() {
    s_display.clearDisplay();

    // -------------------------------------------------------------
    // SAFE ZONE (Rows 25 to 63)
    // Rows 0 to 24 are kept completely black to accommodate
    // physical display glass constraints/defects.
    // -------------------------------------------------------------

    // 1. Header Bar (Y: 26..34)
    s_display.setTextColor(OLED_COLOR_WHITE);
    s_display.setTextSize(1);
    s_display.setCursor(2, 27);
    s_display.print("DRIFTPAD");

    uint8_t curLayer = s_view.activeLayer;
    s_display.setCursor(54, 27);
    if (curLayer == 0) s_display.print("L0:NUM");
    else if (curLayer == 1) s_display.print("L1:NAV");
    else s_display.print("L2:GAME");

    const char* rtModeStr = s_view.rapidTrigger ? "RAPID" : "NORM";
    int16_t rtModeW = (int16_t)(strlen(rtModeStr) * 6 - 1);
    s_display.setCursor(128 - rtModeW, 27); // Right-aligned to x=127
    s_display.print(rtModeStr);

    s_display.drawFastHLine(0, 35, 128, OLED_COLOR_WHITE);

    // 2. Settings Left Panel (Y: 37..49)
    s_display.setTextColor(OLED_COLOR_WHITE);

    // Line 1: Actuation & RT Sensitivity
    s_display.setCursor(2, 38);
    if (s_currentMenu == MenuMode::ADJUST_ACTUATION) s_display.print(">");
    else s_display.print(" ");
    s_display.print("Ac:");
    s_display.print(s_view.actuationMm, 1);

    s_display.setCursor(47, 38);
    if (s_currentMenu == MenuMode::ADJUST_RT) s_display.print(">");
    else s_display.print(" ");
    s_display.print("RT:");
    s_display.print(s_view.rtSensMm, 2);

    // Line 2: Mode Toggle & Layer Select
    s_display.setCursor(2, 46);
    if (s_currentMenu == MenuMode::TOGGLE_RT) s_display.print(">");
    else s_display.print(" ");
    s_display.print(s_view.rapidTrigger ? "RT:ON" : "RT:OFF");

    s_display.setCursor(47, 46);
    if (s_currentMenu == MenuMode::CYCLE_LAYER) s_display.print(">");
    else s_display.print(" ");
    s_display.print("Lay:");
    s_display.print(curLayer);

    // 3. Live 4x4 Key Matrix Indicator (Top-Right, X: 96..123, Y: 38..48)
    constexpr int16_t GRID_X = 96;
    constexpr int16_t GRID_Y = 38;
    constexpr int16_t BOX_W  = 5;
    constexpr int16_t BOX_H  = 2;
    constexpr int16_t GAP_X  = 2;
    constexpr int16_t GAP_Y  = 1;

    for (uint8_t row = 0; row < 4; ++row) {
        for (uint8_t col = 0; col < 4; ++col) {
            uint8_t keyIdx = row * 4 + col;
            int16_t bx = GRID_X + col * (BOX_W + GAP_X);
            int16_t by = GRID_Y + row * (BOX_H + GAP_Y);

            if (s_view.keys[keyIdx].pressed) {
                s_display.fillRect(bx, by, BOX_W, BOX_H, OLED_COLOR_WHITE);
            } else {
                s_display.drawRect(bx, by, BOX_W, BOX_H, OLED_COLOR_WHITE);
            }
        }
    }

    // 4. Horizontal Separator (Y: 51)
    s_display.drawFastHLine(0, 51, 128, OLED_COLOR_WHITE);

    // 5. Live Analog Depth Gauge (Bottom, Y: 53..63)
    int8_t lastKey = s_view.lastActiveKey;
    s_display.setCursor(3, 53);
    if (lastKey >= 0 && lastKey < NUM_KEYS) {
        const display_link::KeyView& k = s_view.keys[(uint8_t)lastKey];
        s_display.print(k.label);
        s_display.print(":");
        s_display.print(displayTravelMm((uint8_t)lastKey, k.travelMm), 1);
        s_display.print("mm");

        int16_t barW = (int16_t)((k.travelMm / 4.0f) * 122.0f);
        if (barW < 0) barW = 0;
        if (barW > 122) barW = 122;
        s_display.drawRect(2, 59, 124, 4, OLED_COLOR_WHITE);
        if (barW > 0) {
            s_display.fillRect(2, 59, barW, 4, OLED_COLOR_WHITE);
        }
    } else {
        s_display.print("Ready | USB"); // A longer string runs past the frame at x=127
        s_display.drawRect(2, 59, 124, 4, OLED_COLOR_WHITE);
    }

    // Lower border framing the active zone (Y: 25..63)
    s_display.drawRect(0, 25, 128, 39, OLED_COLOR_WHITE);

    // STRICT DEFENSIVE ENFORCEMENT:
    // Guarantee rows 0..24 are 100% black/unwritten
    s_display.fillRect(0, 0, 128, 25, OLED_COLOR_BLACK);

    discardGridLatches();

    s_display.display();
}

// ---------------------------------------------------------------------------------------
// The title screen's letterforms for any text: italic, and cut by a one-row slit through the middle
// of the lettering. The text is printed normally into a scratch region, read back as a mask, the
// region is restored, and the mask is redrawn sheared and slit. The region must lie on the display
// and leave room to its right for the slant.
// ---------------------------------------------------------------------------------------
constexpr uint16_t STYLE_MAX_W = 96;
constexpr uint16_t STYLE_MAX_H = 32;
uint8_t s_styleSave[STYLE_MAX_W * (STYLE_MAX_H / 8 + 1)];
uint8_t s_styleMask[STYLE_MAX_H][STYLE_MAX_W / 8];

template <typename PrintFn>
void drawStyledText(int16_t rx, int16_t ry, uint16_t rw, uint16_t rh, uint16_t color, float shear,
                    PrintFn printPlain) {
    if (rw > STYLE_MAX_W) rw = STYLE_MAX_W;
    if (rh > STYLE_MAX_H) rh = STYLE_MAX_H;
    uint8_t* buf = s_display.getBuffer();
    const int16_t p0 = ry >> 3, p1 = (ry + rh - 1) >> 3;

    for (int16_t p = p0; p <= p1; ++p) memcpy(&s_styleSave[(p - p0) * rw], &buf[p * SCREEN_WIDTH + rx], rw);
    s_display.fillRect(rx, ry, rw, rh, OLED_COLOR_BLACK);
    printPlain();

    memset(s_styleMask, 0, sizeof(s_styleMask));
    int16_t minY = rh, maxY = -1;
    for (uint16_t y = 0; y < rh; ++y) {
        const int16_t sy = ry + y;
        for (uint16_t x = 0; x < rw; ++x) {
            if (buf[(rx + x) + (sy >> 3) * SCREEN_WIDTH] & (1 << (sy & 7))) {
                s_styleMask[y][x >> 3] |= (uint8_t)(1 << (x & 7));
                if ((int16_t)y < minY) minY = (int16_t)y;
                if ((int16_t)y > maxY) maxY = (int16_t)y;
            }
        }
    }
    for (int16_t p = p0; p <= p1; ++p) memcpy(&buf[p * SCREEN_WIDTH + rx], &s_styleSave[(p - p0) * rw], rw);
    if (maxY < 0) return;

    const int16_t maskH = maxY - minY + 1;
    const int16_t slit = (maskH >= 8) ? (minY + maxY) / 2 : -1;
    const float half = (maxY - minY) / 2.0f;
    const float effectiveShear = (maskH >= 6) ? shear : 0.0f;
    for (int16_t y = minY; y <= maxY; ++y) {
        if (slit >= 0 && y == slit) continue;
        const int16_t dx = (int16_t)lroundf(((maxY - y) - half) * effectiveShear);   // top leans right, centred
        for (uint16_t x = 0; x < rw; ++x) {
            if (s_styleMask[y][x >> 3] & (1 << (x & 7))) s_display.drawPixel(rx + x + dx, ry + y, color);
        }
    }
}

// Tracked capitals: `pitch` px per character
void printTracked(const char* text, int16_t x, int16_t y, int16_t pitch) {
    s_display.setTextSize(1);
    for (; *text; ++text, x += pitch) {
        s_display.setCursor(x, y);
        s_display.print(*text);
    }
}

const char* const MENU_TITLES[] = {"Sensitivity", "Actuation point", "Rapid Trigger", "Active layer", "Screen theme"};
const char* const THEME_NAMES[] = {"Drift", "Sakura", "Space"};
const char* const THEME_CAPTIONS[] = {"The original look", "Cherry blossom", "Planets and stars"};

// A big value in italic slit lettering, with its unit in small capitals sharing the baseline; the
// pair is centred. Values are size 3 (18 x 24 px cells), which needs a 28 row region.
void drawBigValue(const char* value, const char* unit, int16_t top) {
    const int16_t valueW = textWidth(value, 3);
    const int16_t unitW = unit ? textWidth(unit, 2) : 0;
    const int16_t total = valueW + (unit ? 6 + unitW : 0);
    const int16_t x = 64 - total / 2;
    drawStyledText(x - 2, top - 2, (uint16_t)valueW + 12, 28, OLED_COLOR_WHITE, 0.22f, [&] {
        s_display.setTextColor(OLED_COLOR_WHITE);
        s_display.setTextSize(3);
        s_display.setCursor(x, top);
        s_display.print(value);
        s_display.setTextSize(1);
    });
    if (unit) {
        s_display.setTextSize(2);
        s_display.setTextColor(OLED_COLOR_WHITE);
        s_display.setCursor(x + valueW + 6, top + 8);
        s_display.print(unit);
        s_display.setTextSize(1);
    }
}

// The slider is the boot screen's ruler: a baseline with ticks (long at each detent), a bar under it
// that fills to the value, and a pointer above it. It glides to a new value and snaps when the card
// has just appeared or the page changed.
void drawMenuRuler(float ratio, uint8_t steps) {
    constexpr int16_t X0 = 10;
    constexpr int16_t X1 = 117;
    constexpr int16_t Y = 51;
    if (ratio < 0.0f) ratio = 0.0f;
    if (ratio > 1.0f) ratio = 1.0f;

    static float shown = 0.0f;
    static uint8_t shownPage = 255;
    static uint32_t lastDrawn = 0;
    const uint8_t page = static_cast<uint8_t>(s_currentMenu);
    const uint32_t nowMs = millis();
    if (page != shownPage || nowMs - lastDrawn > 100) {
        shown = ratio;
        shownPage = page;
    } else {
        shown += (ratio - shown) * 0.4f;
        if (fabsf(ratio - shown) < 0.004f) shown = ratio;
    }
    lastDrawn = nowMs;
    ratio = shown;

    s_display.drawFastHLine(X0, Y, X1 - X0 + 1, OLED_COLOR_WHITE);
    const int16_t minors = steps * 5;
    for (int16_t i = 0; i <= minors; ++i) {
        const int16_t x = X0 + (X1 - X0) * i / minors;
        const bool major = (i % 5) == 0;
        s_display.drawFastVLine(x, major ? Y - 5 : Y - 3, major ? 5 : 3, OLED_COLOR_WHITE);
    }
    const int16_t fillX = X0 + (int16_t)(ratio * (X1 - X0) + 0.5f);
    s_display.fillRect(X0, Y + 2, fillX - X0 + 1, 2, OLED_COLOR_WHITE);
    s_display.fillTriangle(fillX - 3, Y - 10, fillX + 3, Y - 10, fillX, Y - 6, OLED_COLOR_WHITE);   // pointer
}

// 24x11 switch drawn as a ruler segment: a baseline box with the knob left (off) or right (on)
void drawToggle(bool on, int16_t x, int16_t y) {
    s_display.drawRect(x, y, 26, 11, OLED_COLOR_WHITE);
    if (on) {
        s_display.fillRect(x + 14, y + 2, 10, 7, OLED_COLOR_WHITE);
        s_display.fillRect(x + 2, y + 5, 10, 1, OLED_COLOR_WHITE);
    } else {
        s_display.fillRect(x + 2, y + 2, 10, 7, OLED_COLOR_WHITE);
    }
}

void renderMenuOverlay() {
    s_display.clearDisplay();
    drawCornerBrackets();

    // Header: the page's name in capitals, four page pips at the right, a hairline beneath
    const uint8_t page = static_cast<uint8_t>(s_currentMenu);
    s_display.setTextColor(OLED_COLOR_WHITE);
    if (page < static_cast<uint8_t>(MenuMode::COUNT)) {
        printTracked(MENU_TITLES[page], 10, 4, 6);
    }
    for (uint8_t i = 0; i < static_cast<uint8_t>(MenuMode::COUNT); ++i) {
        const int16_t px = 108 + i * 4;
        if (i == page) s_display.fillRect(px, 4, 3, 5, OLED_COLOR_WHITE);
        else s_display.drawRect(px, 4, 3, 5, OLED_COLOR_WHITE);
    }
    s_display.drawFastHLine(10, 13, 108, OLED_COLOR_WHITE);

    switch (s_currentMenu) {
        case MenuMode::ADJUST_RT: {
            drawBigValue(String(s_view.rtSensMm, 2).c_str(), "mm", 16);
            drawMenuRuler((s_view.rtSensMm - limits::cmmToMm(limits::RT_SENS_MIN_CMM)) /
                          (limits::cmmToMm(limits::RT_SENS_MAX_CMM) - limits::cmmToMm(limits::RT_SENS_MIN_CMM)), 4);
            break;
        }
        case MenuMode::ADJUST_ACTUATION: {
            drawBigValue(String(s_view.actuationMm, 2).c_str(), "mm", 16);
            drawMenuRuler((s_view.actuationMm - limits::cmmToMm(limits::ACTUATION_MIN_CMM)) /
                          (limits::cmmToMm(limits::ACTUATION_MAX_CMM) - limits::cmmToMm(limits::ACTUATION_MIN_CMM)), 4);
            break;
        }
        case MenuMode::TOGGLE_RT: {
            const bool on = s_view.rapidTrigger;
            const char* state = on ? "ON" : "OFF";
            const int16_t w = textWidth(state, 3);
            const int16_t x = 64 - (w + 10 + 26) / 2;
            drawStyledText(x - 2, 17, (uint16_t)w + 12, 28, OLED_COLOR_WHITE, 0.22f, [&] {
                s_display.setTextColor(OLED_COLOR_WHITE);
                s_display.setTextSize(3);
                s_display.setCursor(x, 19);
                s_display.print(state);
                s_display.setTextSize(1);
            });
            drawToggle(on, x + w + 10, 26);
            const char* hint = on ? "Re-arms as you lift" : "Fixed actuation";
            printTracked(hint, 64 - (int16_t)strlen(hint) * 6 / 2, 48, 6);
            break;
        }
        case MenuMode::CYCLE_LAYER: {
            const uint8_t cur = s_view.activeLayer;
            const char* name = layerName(cur);
            const int16_t w = textWidth(name, 2);
            drawStyledText(64 - w / 2 - 2, 19, (uint16_t)w + 12, 24, OLED_COLOR_WHITE, 0.22f, [&] {
                s_display.setTextColor(OLED_COLOR_WHITE);
                s_display.setTextSize(2);
                s_display.setCursor(64 - w / 2, 22);
                s_display.print(name);
                s_display.setTextSize(1);
            });

            // Layer chips, on the ruler's pitch: the active one is solid
            char chip[3];
            for (uint8_t i = 0; i < limits::NUM_LAYERS; ++i) {
                const int16_t bx = 64 - (limits::NUM_LAYERS * 22 - 4) / 2 + i * 22;
                if (i == cur) {
                    s_display.fillRect(bx, 46, 18, 10, OLED_COLOR_WHITE);
                    s_display.setTextColor(OLED_COLOR_BLACK, OLED_COLOR_WHITE);
                } else {
                    s_display.drawRect(bx, 46, 18, 10, OLED_COLOR_WHITE);
                    s_display.setTextColor(OLED_COLOR_WHITE);
                }
                snprintf(chip, sizeof(chip), "%u", (unsigned)i + 1);
                printCentered(chip, bx + 9, 47);
            }
            s_display.setTextColor(OLED_COLOR_WHITE);
            break;
        }
        case MenuMode::THEME: {
            const uint8_t cur = s_view.theme < limits::THEME_COUNT ? s_view.theme : 0;
            const char* name = THEME_NAMES[cur];
            const int16_t w = textWidth(name, 2);
            if (cur == THEME_SAKURA || cur == THEME_SPACE) {
                // The theme's badge beside its name: the seal, or a ringed planet
                const int16_t left = 64 - (w + 6 + sakura::SEAL_SIZE) / 2;
                if (cur == THEME_SAKURA) sakura::drawSeal(s_display, left, 18);
                else space::drawBadge(s_display, left, 18);
                s_display.setTextColor(OLED_COLOR_WHITE);
                s_display.setTextSize(2);
                s_display.setCursor(left + sakura::SEAL_SIZE + 6, 21);
                s_display.print(name);
                s_display.setTextSize(1);
            } else {
                drawStyledText(64 - w / 2 - 2, 19, (uint16_t)w + 12, 24, OLED_COLOR_WHITE, 0.22f, [&] {
                    s_display.setTextColor(OLED_COLOR_WHITE);
                    s_display.setTextSize(2);
                    s_display.setCursor(64 - w / 2, 22);
                    s_display.print(name);
                    s_display.setTextSize(1);
                });
            }
            const char* caption = THEME_CAPTIONS[cur];
            printCentered(caption, 64, 43);
            // One dot per theme, the current one solid
            for (uint8_t i = 0; i < limits::THEME_COUNT; ++i) {
                const int16_t bx = 64 - (limits::THEME_COUNT * 8 - 3) / 2 + i * 8;
                if (i == cur) s_display.fillRect(bx, 54, 5, 5, OLED_COLOR_WHITE);
                else s_display.drawRect(bx, 54, 5, 5, OLED_COLOR_WHITE);
            }
            break;
        }
        default:
            break;
    }

}

// ---------------------------------------------------------------------------------------
// Main key screen. Left: the focused key (state label, key box, 0..4 mm travel scale and
// readout) or standby. Right: the 4x4 keypad map. Positions are fixed across states.
// ---------------------------------------------------------------------------------------
constexpr int16_t KEY_BOX_X = 2;
constexpr int16_t KEY_BOX_Y = 19;
constexpr int16_t KEY_BOX_W = 76;
constexpr int16_t KEY_BOX_H = 27;   // rows 19..45: a clear row above the release marker
constexpr int16_t SCALE_X = 2;
constexpr int16_t SCALE_W = 76;
constexpr int16_t SCALE_Y = 49;     // fill rows 49..51, leaving two clear rows under the key box
constexpr float SCALE_MAX_MM = 4.0f;  // full switch travel
constexpr int16_t MAP_X = 85;      // x 85..126: 45 px is too wide once the panel is centred, so the gaps are 2
constexpr int16_t MAP_Y = 10;      // a clear row under the top strip (chips and captions are rows 0..8)
constexpr int16_t MAP_CELL = 9;
constexpr int16_t MAP_GAP = 2;
constexpr uint8_t FLASH_FRAMES = 3;        // a new actuation sends a ring out from its map cell
constexpr uint8_t PUNCH_FRAMES = 3;        // ... and a flourish around the focus card
constexpr uint8_t REVEAL_FRAMES = 3;       // the left panel wipes in when it changes between card and standby

static bool s_prevActuated[NUM_KEYS] = {false};
static uint8_t s_keyFlash[NUM_KEYS] = {0};
static uint8_t s_cardPunch = 0;            // frames of press flourish left on the focus card
static bool s_prevFocusActuated = false;
static bool s_prevHadFocus = false;        // whether the left panel showed the focus card last frame
static uint8_t s_revealFrames = 0;         // frames of left-panel wipe left

// Standby keeps the layer visible; settings screens are explicitly selected with the encoder.

// Whether the settings shown are on flash: an UNSAVED chip while they are not, and a SAVED chip for
// a couple of seconds after a save (the saved-settings sequence changes)
constexpr uint32_t SAVED_CHIP_MS = 2200;
static bool s_saveSeqKnown = false;
static uint8_t s_lastSaveSeq = 0;
static uint32_t s_savedAt = 0;
static bool s_savedActive = false;

// A change of layer that did not come from the tuning card flashes the layer's name across the screen
constexpr uint32_t LAYER_FLASH_MS = 1300;
static int16_t s_layerSeen = -1;
static uint32_t s_layerFlashAt = 0;
static bool s_layerFlashActive = false;

const char* const LAYER_TITLES[] = {"Numpad", "Nav", "Gaming"};

void printRight(const char* text, int16_t rightX, int16_t y) {
    s_display.setTextSize(1);
    s_display.setCursor(rightX - textWidth(text) + 1, y);
    s_display.print(text);
}

// Plain-language caption on the top row of the left panel
void drawCaption(const char* text) {
    s_display.setTextSize(1);
    s_display.setTextColor(OLED_COLOR_WHITE);
    s_display.setCursor(KEY_BOX_X, 1);
    s_display.print(text);
}

// The left panel's usable width for big text: x = 2 .. 76, clear of the keypad map
constexpr int16_t PANEL_CENTER_X = 40;   // the left panel is x 2..77; its centre is 39.5
constexpr int16_t PANEL_TEXT_W = 74;

int16_t fontWidth(const char* text, const GFXfont* font, int16_t* x1out = nullptr) {
    int16_t x1, y1;
    uint16_t w, h;
    s_display.setFont(font);
    s_display.getTextBounds(text, 0, 0, &x1, &y1, &w, &h);
    s_display.setFont(nullptr);
    if (x1out) *x1out = x1;
    return (int16_t)w;
}

// The largest of the three bold sizes in which `text` fits `maxW`
const GFXfont* fitFont(const char* text, int16_t maxW) {
    if (fontWidth(text, &FreeSansBold18pt7b) <= maxW) return &FreeSansBold18pt7b;
    if (fontWidth(text, &FreeSansBold12pt7b) <= maxW) return &FreeSansBold12pt7b;
    return &FreeSansBold9pt7b;
}

// A big value (and an optional smaller unit beside it) in the title screen's lettering, centred in
// the left panel with its top at `top`. Everything is sized to fit the panel, never clipped, and the
// value and the unit share one baseline. Only the 12 and 9 pt sizes are used, so a line stays 17 rows
// tall including descenders and clears the scale beneath it.
void drawPanelValue(const char* value, const char* unit, int16_t top) {
    const GFXfont* valueFont = &FreeSansBold12pt7b;
    const GFXfont* unitFont = &FreeSansBold9pt7b;
    if (unit) {
        if (fontWidth(value, valueFont) + 5 + fontWidth(unit, unitFont) > PANEL_TEXT_W) valueFont = &FreeSansBold9pt7b;
    } else if (fontWidth(value, valueFont) > PANEL_TEXT_W) {
        valueFont = &FreeSansBold9pt7b;
    }
    int16_t x1, y1;
    uint16_t w, h;
    s_display.setFont(valueFont);
    s_display.getTextBounds(value, 0, 0, &x1, &y1, &w, &h);
    s_display.setFont(nullptr);
    const int16_t unitW = unit ? 5 + fontWidth(unit, unitFont) : 0;
    const int16_t left = PANEL_CENTER_X - ((int16_t)w + unitW) / 2 - x1;
    const int16_t baseline = top - y1;
    if (plainLettering()) {   // plain upright lettering; the slit italic is Drift's
        s_display.setTextColor(OLED_COLOR_WHITE);
        s_display.setFont(valueFont);
        s_display.setCursor(left, baseline);
        s_display.print(value);
        if (unit) {
            s_display.setFont(unitFont);
            s_display.setCursor(left + x1 + (int16_t)w + 5, baseline);
            s_display.print(unit);
        }
        s_display.setFont(nullptr);
        return;
    }
    drawStyledText(KEY_BOX_X, top - 2, KEY_BOX_W, (uint16_t)h + 6, OLED_COLOR_WHITE, 0.22f, [&] {
        s_display.setTextColor(OLED_COLOR_WHITE);
        s_display.setFont(valueFont);
        s_display.setCursor(left, baseline);
        s_display.print(value);
        if (unit) {
            s_display.setFont(unitFont);
            s_display.setCursor(left + x1 + (int16_t)w + 5, baseline);
            s_display.print(unit);
        }
        s_display.setFont(nullptr);
    });
}

// Rectangle outline drawn as dots, every `step`-th pixel of its perimeter
void drawDottedRect(int16_t x, int16_t y, int16_t w, int16_t h, uint8_t step) {
    uint8_t n = 0;
    for (int16_t i = 0; i < w; ++i, ++n) {
        if (n % step == 0) { s_display.drawPixel(x + i, y, OLED_COLOR_WHITE); s_display.drawPixel(x + i, y + h - 1, OLED_COLOR_WHITE); }
    }
    for (int16_t j = 1; j < h - 1; ++j, ++n) {
        if (n % step == 0) { s_display.drawPixel(x, y + j, OLED_COLOR_WHITE); s_display.drawPixel(x + w - 1, y + j, OLED_COLOR_WHITE); }
    }
}

// Plain rendering fallback for punctuation and small symbols whose styled result
// loses distinguishing pixels under the slit or shear.
bool isPunctuationOrSmall(const char* label, uint16_t w, uint16_t h) {
    if (!label || !*label) return false;
    bool hasAlnum = false;
    for (const char* p = label; *p; ++p) {
        if (isalnum((unsigned char)*p)) {
            hasAlnum = true;
            break;
        }
    }
    if (!hasAlnum) return true;
    if (h < 12) return true;
    return false;
}

// Key box: filled with a knocked-out label when actuated, outlined otherwise. The label
// uses the largest font that keeps comfortable side padding inside the fixed box.
void drawKeyBox(const char* label, bool actuated, uint8_t punch) {
    if (!label || !*label) {
        if (actuated) s_display.fillRoundRect(KEY_BOX_X, KEY_BOX_Y, KEY_BOX_W, KEY_BOX_H, 3, OLED_COLOR_WHITE);
        else s_display.drawRoundRect(KEY_BOX_X, KEY_BOX_Y, KEY_BOX_W, KEY_BOX_H, 3, OLED_COLOR_WHITE);
        return;
    }

    int16_t x1, y1;
    uint16_t w, h;
    const GFXfont* font = &FreeSansBold18pt7b;
    s_display.setFont(font);
    s_display.getTextBounds(label, 0, 0, &x1, &y1, &w, &h);

    bool hasAlnum = false;
    for (const char* p = label; *p; ++p) {
        if (isalnum((unsigned char)*p)) { hasAlnum = true; break; }
    }
    const bool isPunct = !hasAlnum;
    const bool hasDescender = (y1 + (int16_t)h > 1);

    if (w > KEY_BOX_W - 20 || (hasDescender && h > 20) || (isPunct && h > 20)) {
        font = &FreeSansBold12pt7b;
        s_display.setFont(font);
        s_display.getTextBounds(label, 0, 0, &x1, &y1, &w, &h);
        const bool hasDescender12 = (y1 + (int16_t)h > 1);
        if (w > KEY_BOX_W - 14 || (hasDescender12 && h > 18) || (isPunct && h > 18)) {
            font = &FreeSansBold9pt7b;
            s_display.setFont(font);
            s_display.getTextBounds(label, 0, 0, &x1, &y1, &w, &h);
        }
    }

    // The other themes draw every label plainly inside their own card; the slit lettering is Drift's
    const bool themedCard = plainLettering();
    const bool usePlain = themedCard || isPunctuationOrSmall(label, w, h);

    int16_t tx = KEY_BOX_X + (KEY_BOX_W - (int16_t)w + 1) / 2 - x1;
    int16_t ty;
    if (usePlain || hasDescender) {
        // Centre vertically on the label's actual bounding box so punctuation and descenders
        // are properly positioned and never spill outside the card.
        ty = KEY_BOX_Y + (KEY_BOX_H - (int16_t)h + 1) / 2 - y1;
    } else {
        // Alphanumeric labels align on the standard cap-height baseline
        int16_t cx1, cy1;
        uint16_t cw, capH;
        s_display.getTextBounds("H", 0, 0, &cx1, &cy1, &cw, &capH);
        ty = KEY_BOX_Y + (KEY_BOX_H - (int16_t)capH + 1) / 2 + (int16_t)capH;
    }

    if (sakuraTheme()) {
        sakura::drawCardFrame(s_display, KEY_BOX_X, KEY_BOX_Y, KEY_BOX_W, KEY_BOX_H, actuated);
    } else if (spaceTheme()) {
        space::drawCardFrame(s_display, KEY_BOX_X, KEY_BOX_Y, KEY_BOX_W, KEY_BOX_H, actuated);
    } else if (actuated) {
        s_display.fillRoundRect(KEY_BOX_X, KEY_BOX_Y, KEY_BOX_W, KEY_BOX_H, 3, OLED_COLOR_WHITE);
        if (punch > 0) {
            // The press flourish: a dark bevel just inside the card edge that steps inward over the
            // punch frames. It stays within 3 px of the edge, clear of the legend, and nothing is
            // drawn outside the card, so it can never touch the chip above or the scale below.
            const int16_t inset = 1 + (PUNCH_FRAMES - punch);
            s_display.drawRoundRect(KEY_BOX_X + inset, KEY_BOX_Y + inset, KEY_BOX_W - 2 * inset, KEY_BOX_H - 2 * inset,
                                    2, OLED_COLOR_BLACK);
        }
    } else {
        s_display.drawRoundRect(KEY_BOX_X, KEY_BOX_Y, KEY_BOX_W, KEY_BOX_H, 3, OLED_COLOR_WHITE);
    }

    const int16_t sink = actuated ? 1 : 0;

    if (usePlain) {
        s_display.setFont(font);
        s_display.setTextColor(actuated ? OLED_COLOR_BLACK : OLED_COLOR_WHITE);
        s_display.setCursor(tx, ty + sink);
        s_display.print(label);
        s_display.setFont(nullptr);
    } else {
        // The label in the title screen's lettering: italic, cut by a slit
        drawStyledText(KEY_BOX_X + 2, KEY_BOX_Y + 2, KEY_BOX_W - 4, KEY_BOX_H - 3,
                       actuated ? OLED_COLOR_BLACK : OLED_COLOR_WHITE, 0.22f, [&] {
            s_display.setFont(font);
            s_display.setTextColor(OLED_COLOR_WHITE);
            s_display.setCursor(tx, ty + sink);   // the keycap sinks a pixel when pressed
            s_display.print(label);
            s_display.setFont(nullptr);
        });
    }
    s_display.setFont(nullptr);
    s_display.setTextColor(OLED_COLOR_WHITE);
}

int16_t scaleX(float mm) {
    return SCALE_X + (int16_t)(mm / SCALE_MAX_MM * (SCALE_W - 1) + 0.5f);
}

// Fixed 0..4 mm scale: 1px track, 3px fill, mm ticks, and the configured initial actuation
// point as a line through the bar plus a pointer underneath. With Rapid Trigger, releaseMm >= 0
// adds a pointer above the bar: the depth at which the held key will release.
void drawTravelScale(float travelMm, float releaseMm = -1.0f) {
    if (travelMm < 0.0f) travelMm = 0.0f;
    if (travelMm > SCALE_MAX_MM) travelMm = SCALE_MAX_MM;

    s_display.drawFastHLine(SCALE_X, SCALE_Y + 1, SCALE_W, OLED_COLOR_WHITE);
    int16_t fillX = scaleX(travelMm);
    if (travelMm > 0.0f) {
        s_display.fillRect(SCALE_X, SCALE_Y, fillX - SCALE_X + 1, 3, OLED_COLOR_WHITE);
    }
    for (uint8_t mm = 0; mm <= 4; ++mm) {
        s_display.drawPixel(scaleX(mm), SCALE_Y + 4, OLED_COLOR_WHITE);
    }
    int16_t ax = scaleX(s_view.actuationMm);
    bool filledPast = travelMm > 0.0f && ax <= fillX;
    s_display.drawFastVLine(ax, SCALE_Y, 4, filledPast ? OLED_COLOR_BLACK : OLED_COLOR_WHITE);
    s_display.drawPixel(ax, SCALE_Y + 4, OLED_COLOR_WHITE);
    s_display.drawFastHLine(ax - 1, SCALE_Y + 5, 3, OLED_COLOR_WHITE);
    s_display.drawFastHLine(ax - 2, SCALE_Y + 6, 5, OLED_COLOR_WHITE);

    if (releaseMm >= 0.0f) {
        int16_t rx = scaleX(releaseMm > SCALE_MAX_MM ? SCALE_MAX_MM : releaseMm);
        s_display.drawFastHLine(rx - 1, SCALE_Y - 2, 3, OLED_COLOR_WHITE);
        s_display.drawPixel(rx, SCALE_Y - 1, OLED_COLOR_WHITE);
    }

}

// Space: the target lock of each fresh press closes in on its map cell for space::LOCK_STEPS
// frames, held or not; s_keyFlash counts it down
void drawSpaceLocks() {
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        if (s_keyFlash[i] == 0) continue;
        const int16_t x = MAP_X + (i % 4) * (MAP_CELL + MAP_GAP);
        const int16_t y = MAP_Y + (i / 4) * (MAP_CELL + MAP_GAP);
        space::drawLockOn(s_display, x, y, MAP_CELL, (uint8_t)(space::LOCK_STEPS - s_keyFlash[i]));
        s_keyFlash[i]--;
    }
}

// Keypad map. Resting: outline. Travelling: outline with a level that rises toward the
// actuation point (a full cell is about to fire). Actuated: solid, with a ring around it for two
// frames, then a dithered afterglow that thins out over GLOW_FRAMES. Focus is marked by row and column pointers outside the grid, so
// neighbouring actuated keys can never make it ambiguous.
void drawKeypadMap(const bool actuated[NUM_KEYS], int8_t focus, bool legends) {
    static const uint8_t kBayer4[4][4] = {
        { 0,  8,  2, 10}, {12,  4, 14,  6}, { 3, 11,  1,  9}, {15,  7, 13,  5}};
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        int16_t x = MAP_X + (i % 4) * (MAP_CELL + MAP_GAP);
        int16_t y = MAP_Y + (i / 4) * (MAP_CELL + MAP_GAP);
        if (actuated[i]) {
            if (!s_prevActuated[i]) {
                s_keyFlash[i] = FLASH_FRAMES;
                // Cherry blossom: a press throws a few petals up from its cell instead of the ring
                if (sakuraTheme()) {
                    s_keyPetals.burst(x + MAP_CELL / 2.0f, y + 1.0f, 6);
                    s_keyFlash[i] = 0;
                }
                // Space: a target lock closes in instead (drawSpaceLocks, which counts it down)
                if (spaceTheme()) s_keyFlash[i] = space::LOCK_STEPS;
            }
            s_prevActuated[i] = true;
            s_display.fillRect(x, y, MAP_CELL, MAP_CELL, OLED_COLOR_WHITE);
            if (s_keyFlash[i] > 0 && !spaceTheme()) {
                // A ring that leaves the cell: solid at once, then further out and breaking into dots
                if (s_keyFlash[i] == FLASH_FRAMES) {
                    s_display.drawRect(x - 1, y - 1, MAP_CELL + 2, MAP_CELL + 2, OLED_COLOR_WHITE);
                } else {
                    drawDottedRect(x - 1, y - 1, MAP_CELL + 2, MAP_CELL + 2, s_keyFlash[i] == 2 ? 2 : 3);
                }
                s_keyFlash[i]--;
            }
            s_keyGlow[i] = GLOW_FRAMES;
            continue;
        }
        s_prevActuated[i] = false;
        s_display.drawRect(x, y, MAP_CELL, MAP_CELL, OLED_COLOR_WHITE);
        float mm = s_view.keys[i].travelMm;
        const bool glowing = s_keyGlow[i] > 0;
        if (glowing) {
            int16_t threshold = (int16_t)s_keyGlow[i] * 2 - 4;
            for (int16_t py = 1; py < MAP_CELL - 1; ++py) {
                for (int16_t px = 1; px < MAP_CELL - 1; ++px) {
                    if (kBayer4[py & 3][px & 3] < threshold) {
                        s_display.drawPixel(x + px, y + py, OLED_COLOR_WHITE);
                    }
                }
            }
            s_keyGlow[i]--;
        }
        if (mm >= FOCUS_REST_MM) {
            float toAct = s_view.actuationMm > 0.1f ? s_view.actuationMm : 0.1f;
            int16_t rows = (int16_t)(mm / toAct * 5.0f + 0.5f);
            if (rows < 1) rows = 1;
            if (rows > 5) rows = 5;
            s_display.fillRect(x + 2, y + MAP_CELL - 2 - rows, MAP_CELL - 4, rows, OLED_COLOR_WHITE);
        } else if (legends && !glowing && s_view.keys[i].label[0]) {
            // At rest with nothing focused the map doubles as the layout: each key's first character
            s_display.setTextSize(1);
            s_display.setTextColor(OLED_COLOR_WHITE);
            s_display.setCursor(x + 2, y + 1);
            s_display.print(s_view.keys[i].label[0]);
        }
    }
    if (focus < 0) return;

    int16_t cx = MAP_X + (focus % 4) * (MAP_CELL + MAP_GAP) + MAP_CELL / 2;
    int16_t cy = MAP_Y + (focus / 4) * (MAP_CELL + MAP_GAP) + MAP_CELL / 2;
    s_display.drawFastVLine(MAP_X - 4, cy - 2, 5, OLED_COLOR_WHITE);
    s_display.drawFastVLine(MAP_X - 3, cy - 1, 3, OLED_COLOR_WHITE);
    s_display.drawPixel(MAP_X - 2, cy, OLED_COLOR_WHITE);
    int16_t gridBottom = MAP_Y + 4 * (MAP_CELL + MAP_GAP) - MAP_GAP;
    s_display.drawPixel(cx, gridBottom + 2, OLED_COLOR_WHITE);
    s_display.drawFastHLine(cx - 1, gridBottom + 3, 3, OLED_COLOR_WHITE);
    s_display.drawFastHLine(cx - 2, gridBottom + 4, 5, OLED_COLOR_WHITE);
}

// The top-left status of the left panel speaks only when there is something to say: ACTUATED (chip)
// while a key is down, or, whenever key presses are not being sent to the computer, why not, so a
// pad that looks alive but types nothing (no calibration yet, output switched off) is never
// mistaken for a working one. Otherwise the slot stays empty.
void drawStatusLabel(const char* normal, bool chip) {
    const char* text = normal;
    if (s_view.outputStatus == display_link::OUTPUT_NEEDS_CAL) text = "Calibrate";
    else if (s_view.outputStatus == display_link::OUTPUT_CALIBRATING) text = "Calibrating";
    else if (s_view.outputStatus == display_link::OUTPUT_OFF) text = "Output off";
    if (!text) return;
    bool blocked = text != normal;
    if (blocked || chip) {
        s_display.fillRect(KEY_BOX_X, 9, textWidth(text) + 4, 9, OLED_COLOR_WHITE);
        s_display.setTextColor(OLED_COLOR_BLACK, OLED_COLOR_WHITE);
    }
    s_display.setCursor(KEY_BOX_X + 2, 10);
    s_display.print(text);
    s_display.setTextColor(OLED_COLOR_WHITE);
}

// Notices a save (the sequence changed) and starts the SAVED chip; the first call only records it
void noteSettingsState(uint32_t now) {
    if (!s_saveSeqKnown) {
        s_saveSeqKnown = true;
        s_lastSaveSeq = s_view.saveSeq;
        return;
    }
    if (s_view.saveSeq != s_lastSaveSeq) {
        s_lastSaveSeq = s_view.saveSeq;
        s_savedAt = now;
        s_savedActive = true;
    }
}

// Top-right chip: Saved right after a save, Unsaved while changes are only in RAM, otherwise nothing
const char* settingsChipText(uint32_t now) {
    if (s_view.settingsDirty) {
        s_savedActive = false;
        return "Unsaved";
    }
    if (s_savedActive && now - s_savedAt >= SAVED_CHIP_MS) s_savedActive = false;
    if (s_savedActive) return "Saved";
    return nullptr;
}

void drawSettingsState(uint32_t now) {
    const char* text = settingsChipText(now);
    if (!text) return;
    const int16_t w = textWidth(text) + 4;
    s_display.fillRect(SCREEN_WIDTH - w, 0, w, 9, OLED_COLOR_WHITE);
    s_display.setTextSize(1);
    s_display.setTextColor(OLED_COLOR_BLACK, OLED_COLOR_WHITE);
    s_display.setCursor(SCREEN_WIDTH - w + 2, 1);
    s_display.print(text);
    s_display.setTextColor(OLED_COLOR_WHITE);
}

// The layer-change flash: a band opens across the middle of the screen, names the layer in the
// title screen's lettering, and closes again
void drawLayerFlash(uint32_t now, uint8_t layer) {
    if (!s_layerFlashActive) return;
    const uint32_t elapsed = now - s_layerFlashAt;
    if (elapsed >= LAYER_FLASH_MS) { s_layerFlashActive = false; return; }
    if (sakuraTheme()) {   // paper doors slide shut on the new layer and open again
        sakura::drawShoji(s_display, elapsed, LAYER_FLASH_MS, layer, layerName(layer));
        return;
    }
    if (spaceTheme()) {    // a window onto stars rushing past opens, names the layer and closes
        space::drawWarp(s_display, elapsed, LAYER_FLASH_MS, layer, layerName(layer));
        return;
    }
    const int32_t age = (int32_t)elapsed;
    const int32_t remaining = (int32_t)LAYER_FLASH_MS - age;
    const int32_t edge = age < remaining ? age : remaining;              // ms from the nearer end
    const float open = edge >= 160 ? 1.0f : (float)edge / 160.0f;
    const int16_t h = (int16_t)(31.0f * open);
    if (h < 3) return;
    const int16_t top = 32 - h / 2;
    s_display.fillRect(0, top, SCREEN_WIDTH, h, OLED_COLOR_BLACK);
    s_display.drawFastHLine(0, top, SCREEN_WIDTH, OLED_COLOR_WHITE);
    s_display.drawFastHLine(0, top + h - 1, SCREEN_WIDTH, OLED_COLOR_WHITE);
    if (h < 31) return;

    char tag[12];
    snprintf(tag, sizeof(tag), "LAYER %u", (unsigned)layer + 1);
    printTracked(tag, 64 - ((int16_t)strlen(tag) * 7 - 2) / 2, top + 4, 7);
    const char* name = layerName(layer);
    const int16_t w = textWidth(name, 2);
    drawStyledText(64 - w / 2 - 2, top + 13, (uint16_t)w + 12, 17, OLED_COLOR_WHITE, 0.22f, [&] {
        s_display.setTextColor(OLED_COLOR_WHITE);
        s_display.setTextSize(2);
        s_display.setCursor(64 - w / 2, top + 14);
        s_display.print(name);
        s_display.setTextSize(1);
    });
}

// Draws the key screen into the frame buffer (no display() call); consumes the edge latches.
void renderKeysFrame(uint32_t now) {
    noteSettingsState(now);
    if (!s_view.keyInputValid || s_keyInputWasValid != s_view.keyInputValid) {
        discardGridLatches();
        s_focusKey = -1;
        s_focusSettling = false;
    }
    s_keyInputWasValid = s_view.keyInputValid;
    if (!s_gridCountersSynced) {
        discardGridLatches();
        s_gridCountersSynced = true;
    }

    selectDisplayFocus(now);
    int8_t focus = s_focusKey;

    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        const display_link::KeyView& k = s_view.keys[i];
        s_keyPeak[i] = k.pressed ? (k.travelMm > s_keyPeak[i] ? k.travelMm : s_keyPeak[i]) : 0.0f;
    }

    // Focused key state, from the same latches as the map (read before the map consumes them).
    // A release and re-press inside one frame shows one un-actuated frame so RT resets stay visible.
    bool focusActuated = false;
    if (focus >= 0) {
        const display_link::KeyView& k = s_view.keys[(uint8_t)focus];
        bool pressChanged = k.pressCount != s_lastPressCount[(uint8_t)focus];
        bool releaseChanged = k.releaseCount != s_lastReleaseCount[(uint8_t)focus];
        focusActuated = (k.pressed || pressChanged) && !(k.pressed && releaseChanged);
    }

    // The press punch starts on the rising edge of the focused key's actuation and runs a few frames;
    // the left panel wipes in when it changes between the focus card and standby, except when the
    // key is already actuated, which always shows at once
    uint8_t punch = 0;
    if (focusActuated) {
        if (!s_prevFocusActuated) s_cardPunch = PUNCH_FRAMES;
        punch = s_cardPunch;
        if (s_cardPunch > 0) --s_cardPunch;
    } else {
        s_cardPunch = 0;
    }
    s_prevFocusActuated = focusActuated;
    if ((focus >= 0) != s_prevHadFocus) {
        s_prevHadFocus = focus >= 0;
        s_revealFrames = focusActuated ? 0 : REVEAL_FRAMES;
    }

    // Keypad map state per key, then consume the latches
    bool actuated[NUM_KEYS];
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        const display_link::KeyView& k = s_view.keys[i];
        uint8_t curPress = k.pressCount;
        uint8_t curRelease = k.releaseCount;
        bool pressChanged = (curPress != s_lastPressCount[i]);
        bool releaseChanged = (curRelease != s_lastReleaseCount[i]);
        if (k.pressed && releaseChanged) {
            actuated[i] = false;   // RT re-press within one frame: show the reset
        } else {
            actuated[i] = k.pressed || pressChanged;   // held, or a tap finished between frames
        }
        s_lastPressCount[i] = curPress;
        s_lastReleaseCount[i] = curRelease;
    }

    const uint8_t page = 0;  // no automatic standby page advance

    s_display.clearDisplay();
    s_display.setTextColor(OLED_COLOR_WHITE);
    uint8_t layer = s_view.activeLayer;
    // Layer identity has its own slot, including while a key or a save notice is visible.
    char layerCaption[20];
    snprintf(layerCaption, sizeof(layerCaption), "%u %s", (unsigned)layer + 1,
             layer < 3 ? LAYER_TITLES[layer] : "?");
    drawCaption(layerCaption);

    if (focus >= 0) {
        const display_link::KeyView& k = s_view.keys[(uint8_t)focus];
        drawStatusLabel(focusActuated ? "ACTUATED" : nullptr, focusActuated);
        drawKeyBox(k.label, focusActuated, punch);
        float releaseAt = -1.0f;
        if (s_view.rapidTrigger && k.pressed) {
            releaseAt = s_keyPeak[(uint8_t)focus] - s_view.rtSensMm;
            if (releaseAt < 0.0f) releaseAt = -1.0f;
        }
        drawTravelScale(k.travelMm, releaseAt);
        printRight((String(displayTravelMm((uint8_t)focus, k.travelMm), 1) + " mm").c_str(),
                   KEY_BOX_X + KEY_BOX_W - 1, 57);
        s_display.setTextSize(1);
        s_display.setCursor(KEY_BOX_X, 57);
        s_display.print("Travel");
    } else {
        drawStatusLabel(nullptr, false);

        // One page at a time: a plain caption over a big value
        char cap[24];
        char valueBuf[16];
        const char* value = valueBuf;
        const char* unit = nullptr;
        switch (page) {
            case 0:
                snprintf(cap, sizeof(cap), "Layer %u of %u", (unsigned)layer + 1, (unsigned)limits::NUM_LAYERS);
                value = layer < 3 ? LAYER_TITLES[layer] : "?";
                break;
            case 1:
                snprintf(cap, sizeof(cap), "Actuation");
                snprintf(valueBuf, sizeof(valueBuf), "%.2f", (double)s_view.actuationMm);
                unit = "mm";
                break;
            default:
                snprintf(cap, sizeof(cap), "Rapid Trigger");
                if (s_view.rapidTrigger) {
                    snprintf(valueBuf, sizeof(valueBuf), "%.2f", (double)s_view.rtSensMm);
                    unit = "mm";
                } else {
                    snprintf(valueBuf, sizeof(valueBuf), "Off");
                }
                break;
        }
        printCentered(cap, PANEL_CENTER_X, 20);
        drawPanelValue(value, unit, 31);
        if (sakuraTheme()) {
            // A sprig in place of the empty scale; now and then it lets a petal go
            sakura::drawSprig(s_display, 6, 58, 68, now);
            if (now - s_sprigDropAt >= 2600) {
                s_sprigDropAt = now;
                s_keyPetals.drop(6 + 68 * (0.18f + 0.32f * (float)((now / 2600) % 3)), 55.0f);
            }
        } else if (spaceTheme()) {
            // A small planet and its moon in place of the empty scale
            space::drawOrbit(s_display, 6, 58, 68, now);
        } else {
            drawTravelScale(0.0f);
        }
    }

    // Left-panel wipe: everything right of a front that sweeps across is held back for a few frames
    if (s_revealFrames > 0) {
        const int16_t step = REVEAL_FRAMES - s_revealFrames + 1;
        const int16_t front = 78 * step / (REVEAL_FRAMES + 1);
        s_display.fillRect(front, 18, 79 - front, 39, OLED_COLOR_BLACK);
        --s_revealFrames;
    }

    drawKeypadMap(actuated, focus, focus < 0);

    if (sakuraTheme()) {
        s_keyPetals.step(now - s_keyPetalsAt, -1.5f);
        s_keyPetals.draw(s_display);
    } else {
        s_keyPetals.clear();
    }
    s_keyPetalsAt = now;
    if (spaceTheme()) drawSpaceLocks();

    drawSettingsState(now);

    // A layer change not made on the tuning card flashes the layer's name (not while a key is in use)
    if (s_layerSeen < 0) {
        s_layerSeen = layer;
    } else if (layer != s_layerSeen) {
        s_layerSeen = layer;
        if (now - s_menuLastActive > 3500) { s_layerFlashAt = now; s_layerFlashActive = true; }
    }
    // Expire a suppressed notice too, so it never resurfaces at a later clock wrap.
    if (s_layerFlashActive && now - s_layerFlashAt >= LAYER_FLASH_MS) s_layerFlashActive = false;
    if (focus < 0 && s_view.outputStatus == display_link::OUTPUT_ON) drawLayerFlash(now, layer);
}

void blendWipe(uint8_t* outgoing, const uint8_t* incoming, int16_t front);

// Key screen, or the tuning card explicitly selected with the encoder. Switching between the two
// is a short dithered wipe with both screens live, so the menu arrives and leaves instead of
// popping.
constexpr uint32_t MODE_TRANSITION_MS = 260;
bool s_menuVisible = false;
bool s_modeTransition = false;
uint32_t s_modeChangeAt = 0;

void renderFullScreen() {
    uint32_t now = millis();
    bool wantMenu = s_menuRequested;
    if (wantMenu != s_menuVisible) {
        s_menuVisible = wantMenu;
        s_modeTransition = true;
        s_modeChangeAt = now;
    }
    uint32_t elapsed = now - s_modeChangeAt;
    if (s_modeTransition && elapsed >= MODE_TRANSITION_MS) s_modeTransition = false;

    if (!s_modeTransition) {
        if (s_menuVisible) {
            noteSettingsState(now);
            s_layerSeen = s_view.activeLayer;
            renderMenuOverlay();
            discardGridLatches();
        } else {
            renderKeysFrame(now);
        }
        s_display.display();
        return;
    }

    // Wipe from the old screen to the new one; both keep animating meanwhile
    uint8_t* buf = s_display.getBuffer();
    int16_t front = (int16_t)((elapsed * 256UL) / MODE_TRANSITION_MS);
    if (s_menuVisible) {
        renderMenuOverlay();
        memcpy(s_ssScratch, buf, sizeof(s_ssScratch));
        renderKeysFrame(now);
    } else {
        renderKeysFrame(now);
        memcpy(s_ssScratch, buf, sizeof(s_ssScratch));
        renderMenuOverlay();
    }
    blendWipe(buf, s_ssScratch, front);
    s_display.display();
}

// Title card naming the animation: slides up from the bottom edge when an animation starts, stays
// for BADGE_MS, then slides away and leaves the animation clear.
constexpr uint32_t BADGE_MS = 3500;
constexpr uint32_t BADGE_SLIDE_MS = 300;

void drawBadge(const char* text, uint32_t sinceMs) {
    if (sinceMs >= BADGE_MS) return;
    const int16_t pitch = 7;                                   // tracked capitals
    const int16_t w = (int16_t)strlen(text) * pitch - 1 + 16;
    const int16_t h = 15;
    const int16_t restY = 63 - h - 1;
    int16_t offset = 0;                          // pixels below the resting position
    if (sinceMs < BADGE_SLIDE_MS) {
        offset = (int16_t)((BADGE_SLIDE_MS - sinceMs) * (h + 3) / BADGE_SLIDE_MS);
    } else if (sinceMs > BADGE_MS - BADGE_SLIDE_MS) {
        offset = (int16_t)((sinceMs - (BADGE_MS - BADGE_SLIDE_MS)) * (h + 3) / BADGE_SLIDE_MS);
    }
    const int16_t x = 64 - w / 2;
    const int16_t y = restY + offset;
    s_display.fillRect(x, y, w, h, OLED_COLOR_BLACK);
    // Corner brackets around the name, like the frame of the title screen
    const int16_t a = 4;
    s_display.drawFastHLine(x, y, a, OLED_COLOR_WHITE);
    s_display.drawFastVLine(x, y, a, OLED_COLOR_WHITE);
    s_display.drawFastHLine(x + w - a, y, a, OLED_COLOR_WHITE);
    s_display.drawFastVLine(x + w - 1, y, a, OLED_COLOR_WHITE);
    s_display.drawFastHLine(x, y + h - 1, a, OLED_COLOR_WHITE);
    s_display.drawFastVLine(x, y + h - a, a, OLED_COLOR_WHITE);
    s_display.drawFastHLine(x + w - a, y + h - 1, a, OLED_COLOR_WHITE);
    s_display.drawFastVLine(x + w - 1, y + h - a, a, OLED_COLOR_WHITE);
    s_display.setTextColor(OLED_COLOR_WHITE);
    printTracked(text, x + 8, y + 4, pitch);
}

// Animation 0: 3D Warp Starfield & Floating DRIFTPAD Badge
void renderAnimStarfield() {
    for (uint8_t i = 0; i < NUM_STARS; ++i) {
        const Star& star = s_stars[i];
        const int16_t sx = star.screen_x, sy = star.screen_y;
        if (sx >= 0 && sx < 128 && sy >= 0 && sy < 64) {
            // Far stars are single dots, near ones grow into 2x2 blocks with a streak behind them
            if (star.z < 22) {
                s_display.fillRect(sx, sy, 2, 2, OLED_COLOR_WHITE);
            } else {
                s_display.drawPixel(sx, sy, OLED_COLOR_WHITE);
            }
            if (star.prev_x >= 0) {
                s_display.drawLine(star.prev_x, star.prev_y, sx, sy, OLED_COLOR_WHITE);
            }
        }
    }
}

// Animation 1: Plasma
void renderAnimPlasma() {
    static const uint8_t kBayer4[4][4] = {
        { 0,  8,  2, 10}, {12,  4, 14,  6}, { 3, 11,  1,  9}, {15,  7, 13,  5}};
    const uint8_t t1 = (uint8_t)s_plasmaT;
    const uint8_t t2 = (uint8_t)(s_plasmaT * 3 / 2);
    const uint8_t t3 = (uint8_t)(s_plasmaT / 2);
    const int16_t bias = (int16_t)(s_sin[(uint8_t)(s_plasmaT >> 2)] >> 5) - 5;   // -5..+2: swells and ebbs

    uint8_t* buf = s_display.getBuffer();
    for (uint8_t y = 0; y < SCREEN_HEIGHT; ++y) {
        const uint8_t sy = s_sin[(uint8_t)(y * 6 + t2)];
        const int16_t dy = ((int16_t)y - 32) * 8 / 5;   // vertical distance, stretched: pixels are not square to the eye
        const uint16_t dy2 = (uint16_t)(dy * dy);
        for (uint8_t x = 0; x < SCREEN_WIDTH; ++x) {
            uint16_t v = s_sin[(uint8_t)(x * 3 + t1)] + sy +
                         s_sin[(uint8_t)((x + y) * 2 + t3)] +
                         s_sin[(uint8_t)(s_plasmaRoot[(s_plasmaDx2[x] + dy2) >> 3] - t1)];
            uint8_t band = s_sin[(uint8_t)((v >> 2) * 2)];   // fold the sum into soft bands
            if (kBayer4[y & 3][x & 3] < (int16_t)(band >> 4) + bias) {
                buf[x + (y >> 3) * SCREEN_WIDTH] |= 1 << (y & 7);
            }
        }
    }
}

// Animation 2: Tesseract
// Projects the 16 vertices for the given rotation angles (X-W, Y-Z and X-Z planes)
void projectTesseract(float a, float b, float c, int16_t* px, int16_t* py) {
    const float ca = cosf(a), sa = sinf(a);
    const float cb = cosf(b), sb = sinf(b);
    const float cc = cosf(c), sc = sinf(c);
    for (uint8_t i = 0; i < TESS_VERTS; ++i) {
        float x = (i & 1) ? 1.0f : -1.0f;
        float y = (i & 2) ? 1.0f : -1.0f;
        float z = (i & 4) ? 1.0f : -1.0f;
        float w = (i & 8) ? 1.0f : -1.0f;
        float t;
        t = x * ca - w * sa; w = x * sa + w * ca; x = t;
        t = y * cb - z * sb; z = y * sb + z * cb; y = t;
        t = x * cc - z * sc; z = x * sc + z * cc; x = t;
        float k4 = 1.0f / (2.6f - w * 0.55f);                // 4-D -> 3-D
        x *= k4; y *= k4; z *= k4;
        float k3 = 1.0f / (3.1f - z * 0.9f);                 // 3-D -> 2-D
        px[i] = 64 + (int16_t)(x * k3 * 100.0f);
        py[i] = 32 + (int16_t)(y * k3 * 100.0f);
    }
}

void drawDottedLine(int16_t x0, int16_t y0, int16_t x1, int16_t y1) {
    int16_t dx = x1 - x0, dy = y1 - y0;
    int16_t n = abs(dx) > abs(dy) ? abs(dx) : abs(dy);
    for (int16_t i = 0; i <= n; i += 2) {
        s_display.drawPixel(n ? x0 + dx * i / n : x0, n ? y0 + dy * i / n : y0, OLED_COLOR_WHITE);
    }
}

void renderAnimTesseract() {
    // A dotted ghost of where the cube was a few frames ago trails the solid one, so the spin leaves
    // a wake
    int16_t gx[TESS_VERTS], gy[TESS_VERTS], px[TESS_VERTS], py[TESS_VERTS];
    projectTesseract(s_tessA - 0.13f, s_tessB - 0.20f, s_tessC - 0.07f, gx, gy);
    projectTesseract(s_tessA, s_tessB, s_tessC, px, py);
    // 32 edges: vertices whose indices differ in exactly one bit
    for (uint8_t i = 0; i < TESS_VERTS; ++i) {
        for (uint8_t bit = 1; bit < TESS_VERTS; bit <<= 1) {
            uint8_t j = i ^ bit;
            if (j > i) {
                drawDottedLine(gx[i], gy[i], gx[j], gy[j]);
            }
        }
    }
    for (uint8_t i = 0; i < TESS_VERTS; ++i) {
        for (uint8_t bit = 1; bit < TESS_VERTS; bit <<= 1) {
            uint8_t j = i ^ bit;
            if (j > i) {
                s_display.drawLine(px[i], py[i], px[j], py[j], OLED_COLOR_WHITE);
            }
        }
    }
    for (uint8_t i = 0; i < TESS_VERTS; ++i) {
        s_display.fillRect(px[i] - 1, py[i] - 1, 3, 3, OLED_COLOR_WHITE);
    }
}

// Animation 3: Synthwave Horizon Grid & Floating DRIFT GRID Badge
void renderAnimSynthGrid() {
    constexpr int16_t HORIZON = 30;
    constexpr int16_t SUN_R = 15;

    // Twinkling sky stars (fixed positions, each blinks on its own beat)
    static const uint8_t kSky[][2] = {
        {6, 4}, {19, 11}, {31, 3}, {44, 17}, {88, 5}, {97, 14},
        {109, 3}, {121, 10}, {13, 22}, {115, 21}, {76, 2}, {52, 7}
    };
    for (uint8_t i = 0; i < sizeof(kSky) / sizeof(kSky[0]); ++i) {
        if (((s_gridTwinklePhase + i * 11) % 48) > 3) {
            s_display.drawPixel(kSky[i][0], kSky[i][1], OLED_COLOR_WHITE);
        }
    }

    // Setting sun: upper half disc with slits that scroll down and widen toward the horizon
    uint8_t slitOffset = s_gridSlitPhase / 4;
    for (int16_t dy = -SUN_R; dy < 0; ++dy) {
        int16_t fromHorizon = -dy;
        if (fromHorizon <= 10) {
            uint8_t gap = fromHorizon <= 5 ? 2 : 1;
            if (((fromHorizon + slitOffset) % 4) < gap) {
                continue;
            }
        }
        int16_t half = (int16_t)sqrtf((float)(SUN_R * SUN_R - dy * dy));
        s_display.drawFastHLine(64 - half, HORIZON + dy, half * 2 + 1, OLED_COLOR_WHITE);
    }

    // Distant mountains in silhouette, drifting sideways; the sun sinks behind them
    const uint8_t drift = (uint8_t)(s_gridDriftPhase / 2);
    for (int16_t x = 0; x < 128; ++x) {
        int16_t h = 1 + s_sin[(uint8_t)(x * 3 + drift)] / 50 + s_sin[(uint8_t)(x * 7 + 90 - 2 * drift)] / 90;
        s_display.drawFastVLine(x, HORIZON - h, h, OLED_COLOR_BLACK);
        s_display.drawPixel(x, HORIZON - h, OLED_COLOR_WHITE);
    }

    s_display.drawFastHLine(0, HORIZON, 128, OLED_COLOR_WHITE);

    // Floor rails converging on the vanishing point
    for (int8_t i = -6; i <= 6; ++i) {
        s_display.drawLine(64 + i * 4, HORIZON + 1, 64 + i * 24, 63, OLED_COLOR_WHITE);
    }

    // Cross ties rushing toward the viewer (perspective y = horizon + k / depth)
    // Ties bunch up toward the horizon; a tie less than 3 px under the previous line would merge
    // into a solid band, so it is left out
    int16_t lastY = HORIZON;
    for (uint8_t k = 0; k < 9; ++k) {
        float depth = (float)k + 1.0f - s_gridScroll;
        if (depth < 0.5f) continue;
        int16_t y = HORIZON + (int16_t)(33.0f / depth);
        if (y < 64 && y - lastY >= 3) {
            s_display.drawFastHLine(0, y, 128, OLED_COLOR_WHITE);
            lastY = y;
        }
    }
}

void spawnRipple(Ripple& rp) {
    rp.x = (int16_t)animationRandom(128);
    rp.y = (int16_t)animationRandom(64);
    rp.t = -0.02f * (float)animationRandom(24);    // Staggered start so rings don't pulse in lockstep
    rp.step = 0.013f + 0.0015f * (float)animationRandom(8);
    rp.maxR = 24 + (int16_t)animationRandom(28);
}

// Ease-out: the ring leaps away from the impact and settles as it spreads
int16_t rippleRadius(const Ripple& rp, float t) {
    if (t <= 0.0f) return 0;
    float e = 1.0f - (1.0f - t) * (1.0f - t);
    return (int16_t)(rp.maxR * e);
}

// Midpoint circle; skip > 0 draws only every skip-th step so fading rings break up into dots
void drawRippleRing(int16_t cx, int16_t cy, int16_t r, uint8_t skip) {
    int16_t x = r;
    int16_t y = 0;
    int16_t err = 1 - r;
    uint8_t n = 0;
    while (x >= y) {
        if (skip == 0 || (n % skip) == 0) {
            s_display.drawPixel(cx + x, cy + y, OLED_COLOR_WHITE);
            s_display.drawPixel(cx - x, cy + y, OLED_COLOR_WHITE);
            s_display.drawPixel(cx + x, cy - y, OLED_COLOR_WHITE);
            s_display.drawPixel(cx - x, cy - y, OLED_COLOR_WHITE);
            s_display.drawPixel(cx + y, cy + x, OLED_COLOR_WHITE);
            s_display.drawPixel(cx - y, cy + x, OLED_COLOR_WHITE);
            s_display.drawPixel(cx + y, cy - x, OLED_COLOR_WHITE);
            s_display.drawPixel(cx - y, cy - x, OLED_COLOR_WHITE);
        }
        n++;
        y++;
        if (err < 0) {
            err += 2 * y + 1;
        } else {
            x--;
            err += 2 * (y - x) + 1;
        }
    }
}

// Animation 4: Magnetic Pulse Ripples & Floating MAG PULSE Badge
// Where two wavefronts cross, the fields interfere: a small spark marks each crossing point
void rippleSpark(float fx, float fy) {
    const int16_t x = (int16_t)lroundf(fx), y = (int16_t)lroundf(fy);
    s_display.drawPixel(x, y, OLED_COLOR_WHITE);
    s_display.drawPixel(x - 1, y, OLED_COLOR_WHITE);
    s_display.drawPixel(x + 1, y, OLED_COLOR_WHITE);
    s_display.drawPixel(x, y - 1, OLED_COLOR_WHITE);
    s_display.drawPixel(x, y + 1, OLED_COLOR_WHITE);
}

// The (up to two) points where circle A (centre a, radius ra) meets circle B
void rippleCrossings(const Ripple& a, int16_t ra, const Ripple& b, int16_t rb, bool twinkleOn) {
    const float dx = (float)(b.x - a.x), dy = (float)(b.y - a.y);
    const float d2 = dx * dx + dy * dy;
    if (d2 < 1.0f || ra < 2 || rb < 2) return;
    const float d = sqrtf(d2);
    if (d > ra + rb || d < fabsf((float)(ra - rb))) return;
    const float along = ((float)ra * ra - (float)rb * rb + d2) / (2.0f * d);
    const float h2 = (float)ra * ra - along * along;
    if (h2 < 0.0f) return;
    const float h = sqrtf(h2);
    const float mx = a.x + along * dx / d, my = a.y + along * dy / d;
    if (twinkleOn) {
        rippleSpark(mx + h * dy / d, my - h * dx / d);
        rippleSpark(mx - h * dy / d, my + h * dx / d);
    }
}

// Animation 4: Magnetic Pulse. Pulses leap out of their sources and ease to a stop, each leading
// wavefront thick at first, then a chain of weaker echoes behind it; the rings break up into dots as
// they fade, and every point where two wavefronts cross flickers with a spark, like interfering fields.
void renderAnimRipples() {
    int16_t radius[NUM_RIPPLES];
    for (uint8_t i = 0; i < NUM_RIPPLES; ++i) {
        const Ripple& rp = s_ripples[i];
        radius[i] = 0;
        if (rp.t <= 0.0f) continue;

        // The source: a droplet, then a small crosshair that stays until the wave has gone
        if (rp.t < 0.07f) {
            s_display.fillCircle(rp.x, rp.y, 2, OLED_COLOR_WHITE);
        } else if (rp.t < 0.14f) {
            s_display.drawCircle(rp.x, rp.y, 3, OLED_COLOR_WHITE);
        } else if (rp.t < 0.9f) {
            s_display.drawPixel(rp.x, rp.y, OLED_COLOR_WHITE);
            s_display.drawPixel(rp.x - 3, rp.y, OLED_COLOR_WHITE);
            s_display.drawPixel(rp.x + 3, rp.y, OLED_COLOR_WHITE);
            s_display.drawPixel(rp.x, rp.y - 3, OLED_COLOR_WHITE);
            s_display.drawPixel(rp.x, rp.y + 3, OLED_COLOR_WHITE);
        }
        uint8_t skip = 0;
        if (rp.t > 0.75f) {
            skip = 3;
        } else if (rp.t > 0.5f) {
            skip = 2;
        }
        const int16_t r = rippleRadius(rp, rp.t);
        radius[i] = r;
        if (r > 0) {
            drawRippleRing(rp.x, rp.y, r, skip);
            if (rp.t < 0.4f && r > 2) {
                drawRippleRing(rp.x, rp.y, r - 1, 0);    // a thick, bright leading edge
            }
        }
        // Two echoes trail the wavefront, each weaker than the one before
        const int16_t echo1 = rippleRadius(rp, rp.t - 0.15f);
        if (echo1 > 1) {
            drawRippleRing(rp.x, rp.y, echo1, skip + 2);
        }
        const int16_t echo2 = rippleRadius(rp, rp.t - 0.30f);
        if (echo2 > 1) {
            drawRippleRing(rp.x, rp.y, echo2, skip + 4);
        }
    }

    // Sparks where two live wavefronts cross (they twinkle rather than burn steadily)
    for (uint8_t i = 0; i < NUM_RIPPLES; ++i) {
        for (uint8_t j = i + 1; j < NUM_RIPPLES; ++j) {
            rippleCrossings(s_ripples[i], radius[i], s_ripples[j], radius[j], ((s_rippleSparkPhase + i + 2 * j) & 3) != 0);
        }
    }
}

// Animation 5: Lava Lamp & Floating LAVA LAMP Badge
// Blobs drift up and down on slow, unrelated sine periods so they merge and pinch apart.
// Each blob gets a 1 px rim plus Bayer-dithered shading that thickens toward its core.
void renderAnimLava() {
    static const uint8_t kBayer4[4][4] = {
        { 0,  8,  2, 10},
        {12,  4, 14,  6},
        { 3, 11,  1,  9},
        {15,  7, 13,  5},
    };
    constexpr uint16_t EDGE = 256;   // Field value on a lone blob's radius
    constexpr uint16_t CORE = 360;   // Shading starts here, leaving a dark gap inside the rim
    constexpr uint16_t FIELD_MAX = 2048;

    int16_t bx[LAVA_BLOBS], by[LAVA_BLOBS];
    int32_t strength[LAVA_BLOBS];
    for (uint8_t k = 0; k < LAVA_BLOBS; ++k) {
        const LavaBlob& b = kLavaBlobs[k];
        bx[k] = (int16_t)(b.cx + b.swingX * sinf(s_lavaPhaseX[k]));
        by[k] = (int16_t)(32.0f + 34.0f * sinf(s_lavaPhaseY[k]));
        strength[k] = (int32_t)b.radius * b.radius * EDGE;
    }

    for (uint8_t j = 0; j < LAVA_GY; ++j) {
        for (uint8_t i = 0; i < LAVA_GX; ++i) {
            int32_t f = 0;
            for (uint8_t k = 0; k < LAVA_BLOBS; ++k) {
                int32_t dx = i * 4 - bx[k];
                int32_t dy = j * 4 - by[k];
                f += strength[k] / (dx * dx + dy * dy + 1);
            }
            s_lavaGrid[j][i] = (uint16_t)(f > FIELD_MAX ? FIELD_MAX : f);
        }
    }

    // Interpolate one screen row of the field from the 4 px grid
    auto fieldRow = [](uint8_t y, uint16_t* out) {
        uint8_t gy = y >> 2, fy = y & 3;
        for (uint8_t x = 0; x < SCREEN_WIDTH; ++x) {
            uint8_t gx = x >> 2, fx = x & 3;
            uint32_t top = s_lavaGrid[gy][gx] * (4 - fx) + s_lavaGrid[gy][gx + 1] * fx;
            uint32_t bot = s_lavaGrid[gy + 1][gx] * (4 - fx) + s_lavaGrid[gy + 1][gx + 1] * fx;
            out[x] = (uint16_t)((top * (4 - fy) + bot * fy) >> 4);
        }
    };

    uint8_t* buf = s_display.getBuffer();
    fieldRow(0, s_lavaRows[0]);
    for (uint8_t y = 0; y < SCREEN_HEIGHT; ++y) {
        if (y + 1 < SCREEN_HEIGHT) {
            fieldRow(y + 1, s_lavaRows[(y + 1) % 3]);
        }
        const uint16_t* prev = (y > 0) ? s_lavaRows[(y + 2) % 3] : nullptr;
        const uint16_t* row = s_lavaRows[y % 3];
        const uint16_t* next = (y + 1 < SCREEN_HEIGHT) ? s_lavaRows[(y + 1) % 3] : nullptr;

        for (uint8_t x = 0; x < SCREEN_WIDTH; ++x) {
            uint16_t f = row[x];
            if (f < EDGE) continue;

            // Off-screen neighbours count as inside so blobs leaving the screen stay open
            bool rim = (x > 0 && row[x - 1] < EDGE) ||
                       (x < SCREEN_WIDTH - 1 && row[x + 1] < EDGE) ||
                       (prev && prev[x] < EDGE) ||
                       (next && next[x] < EDGE);
            bool on = rim;
            if (!rim && f >= CORE) {
                uint8_t level = 1 + (f - CORE) / 96;
                if (level > 8) level = 8;
                on = kBayer4[y & 3][x & 3] < level;
            }
            // Gloss: light from the upper left lands where the field climbs toward the lower right, a
            // solid crescent just inside each blob's upper-left edge
            if (!rim && prev && next && x > 0 && x < SCREEN_WIDTH - 1 && f < CORE + 260) {
                const int32_t gx = (int32_t)row[x + 1] - (int32_t)row[x - 1];
                const int32_t gy = (int32_t)next[x] - (int32_t)prev[x];
                if (gx > 40 && gy > 40) on = true;
            }
            if (on) {
                buf[x + (y >> 3) * SCREEN_WIDTH] |= 1 << (y & 7);
            }
        }
    }

    // Small bubbles rise through the wax, wobbling; drawn inverted so they read over the blobs too
    for (uint8_t i = 0; i < LAVA_BUBBLES; ++i) {
        const LavaBubble& b = s_lavaBubbles[i];
        s_display.drawCircle((int16_t)b.x, (int16_t)b.y, b.r, OLED_COLOR_INVERSE);
    }

    // Lamp caps: the column of wax sits between a top and a bottom cap
    s_display.fillRect(0, 0, SCREEN_WIDTH, 3, OLED_COLOR_BLACK);
    s_display.drawFastHLine(0, 2, SCREEN_WIDTH, OLED_COLOR_WHITE);
    s_display.fillRect(0, SCREEN_HEIGHT - 3, SCREEN_WIDTH, 3, OLED_COLOR_BLACK);
    s_display.drawFastHLine(0, SCREEN_HEIGHT - 3, SCREEN_WIDTH, OLED_COLOR_WHITE);
    for (int16_t x = 0; x < SCREEN_WIDTH; x += 2) {
        s_display.drawPixel(x, 0, OLED_COLOR_WHITE);
        s_display.drawPixel(x + 1, SCREEN_HEIGHT - 1, OLED_COLOR_WHITE);
    }
}

// Simulation and drawing are separate: each elapsed 33 ms advances the same motion as one old
// frame did, independent of redraw requests and transfer time. A long stall is bounded to eight
// steps; the excess is dropped instead of spending the next frames catching up.
constexpr float ANIMATION_TAU = 6.2831853f;

float wrappedAnimationAngle(float angle) {
    if (angle >= ANIMATION_TAU) angle -= ANIMATION_TAU;
    if (angle < 0.0f) angle += ANIMATION_TAU;
    return angle;
}

void resetScreensaverAnimation(uint8_t anim) {
    if (anim >= OLED_ANIM_COUNT) return;
    ensureSin();
    s_animationRemainderMs[anim] = 0;
    switch (anim) {
        case 0:
            s_starFrame = 0;
            initStarfield();
            break;
        case 1:
            if (!s_plasmaInit) initPlasma();
            s_plasmaT = 0;
            break;
        case 2:
            s_tessA = s_tessB = s_tessC = 0.0f;
            break;
        case 3:
            s_gridScroll = 0.0f;
            s_gridTwinklePhase = s_gridSlitPhase = 0;
            s_gridDriftPhase = 0;
            break;
        case 4:
            s_rippleSparkPhase = 0;
            for (uint8_t i = 0; i < NUM_RIPPLES; ++i) spawnRipple(s_ripples[i]);
            s_ripplesInit = true;
            break;
        case 5:
            for (uint8_t i = 0; i < LAVA_BLOBS; ++i) {
                s_lavaPhaseX[i] = kLavaBlobs[i].phase;
                s_lavaPhaseY[i] = wrappedAnimationAngle(kLavaBlobs[i].phase * 1.7f);
            }
            for (uint8_t i = 0; i < LAVA_BUBBLES; ++i) {
                s_lavaBubbles[i] = {
                    (float)(12 + animationRandom(104)), (float)animationRandom(64),
                    0.35f + 0.1f * (float)animationRandom(8), 0.7f * (float)i,
                    (uint8_t)(1 + animationRandom(2))};
            }
            break;
        case 6:
            s_sakuraScene.reset(animationRandom(0xFFFFFFFFUL) | 1u);
            break;
        case 7:
            s_spaceScene.reset(animationRandom(0xFFFFFFFFUL) | 1u);
            break;
    }
    s_animationInitialized[anim] = true;
}

void resetScreensaverAnimations(uint32_t seed) {
    s_animationRandom = seed ? seed : 0x6D2B79F5UL; // xorshift must never start from zero
    for (uint8_t anim = 0; anim < OLED_ANIM_COUNT; ++anim) resetScreensaverAnimation(anim);
}

void respawnStar(Star& star) {
    star.x = (int16_t)animationRandom(240) - 120;
    star.y = (int16_t)animationRandom(120) - 60;
    star.z = 90;
    star.prev_x = star.prev_y = -1;
}

void advanceScreensaverAnimation(uint8_t anim, uint32_t elapsedMs) {
    if (anim >= OLED_ANIM_COUNT) return;
    if (!s_animationInitialized[anim]) resetScreensaverAnimation(anim);

    // Quotient/remainder arithmetic avoids overflowing when elapsedMs is near UINT32_MAX.
    uint32_t steps = elapsedMs / RENDER_INTERVAL_MS;
    const uint32_t remainder = elapsedMs % RENDER_INTERVAL_MS + s_animationRemainderMs[anim];
    steps += remainder / RENDER_INTERVAL_MS;
    s_animationRemainderMs[anim] = (uint8_t)(remainder % RENDER_INTERVAL_MS);
    if (steps > ANIMATION_MAX_CATCHUP_STEPS) steps = ANIMATION_MAX_CATCHUP_STEPS;

    while (steps-- > 0) {
        switch (anim) {
            case 0: {
                s_starFrame = (s_starFrame + 1) % 3072;
                // Cruise swells into long streaks and the vanishing point steers in a slow loop.
                const int16_t swell = s_sin[(uint8_t)(s_starFrame >> 1)];
                const int16_t speed = 2 + (int16_t)(((int32_t)swell * swell) >> 13);
                const int16_t cx = 64 + (s_sin[(uint8_t)(s_starFrame / 3)] - 128) / 8;
                const int16_t cy = 32 + (s_sin[(uint8_t)(s_starFrame / 4 + 64)] - 128) / 14;
                for (uint8_t i = 0; i < NUM_STARS; ++i) {
                    Star& star = s_stars[i];
                    const bool wasVisible = star.screen_x >= 0 && star.screen_x < SCREEN_WIDTH &&
                                            star.screen_y >= 0 && star.screen_y < SCREEN_HEIGHT;
                    star.prev_x = wasVisible ? star.screen_x : -1;
                    star.prev_y = wasVisible ? star.screen_y : -1;
                    star.z -= speed;
                    if (star.z <= 2) respawnStar(star);
                    star.screen_x = cx + (star.x * 45) / star.z;
                    star.screen_y = cy + (star.y * 45) / star.z;
                    if (star.screen_x < 0 || star.screen_x >= SCREEN_WIDTH ||
                        star.screen_y < 0 || star.screen_y >= SCREEN_HEIGHT) {
                        respawnStar(star);
                        star.screen_x = star.screen_y = -1;
                    }
                }
                break;
            }
            case 1:
                s_plasmaT = (s_plasmaT + 2) & 1023; // all four sine phases share this period
                break;
            case 2:
                s_tessA = wrappedAnimationAngle(s_tessA + 0.021f);
                s_tessB = wrappedAnimationAngle(s_tessB + 0.033f);
                s_tessC = wrappedAnimationAngle(s_tessC + 0.012f);
                break;
            case 3:
                s_gridScroll += 0.06f;
                if (s_gridScroll >= 1.0f) s_gridScroll -= 1.0f;
                s_gridTwinklePhase = (s_gridTwinklePhase + 1) % 48;
                s_gridSlitPhase = (s_gridSlitPhase + 1) % 16;
                s_gridDriftPhase = (s_gridDriftPhase + 1) % 512;
                break;
            case 4:
                s_rippleSparkPhase = (s_rippleSparkPhase + 1) % 4;
                for (uint8_t i = 0; i < NUM_RIPPLES; ++i) {
                    Ripple& ripple = s_ripples[i];
                    ripple.t += ripple.step;
                    if (ripple.t > 1.0f) spawnRipple(ripple);
                }
                break;
            case 5:
                for (uint8_t i = 0; i < LAVA_BLOBS; ++i) {
                    s_lavaPhaseX[i] = wrappedAnimationAngle(s_lavaPhaseX[i] +
                        (RENDER_INTERVAL_MS / 1000.0f) * kLavaBlobs[i].speedX);
                    s_lavaPhaseY[i] = wrappedAnimationAngle(s_lavaPhaseY[i] +
                        (RENDER_INTERVAL_MS / 1000.0f) * kLavaBlobs[i].speedY);
                }
                for (uint8_t i = 0; i < LAVA_BUBBLES; ++i) {
                    LavaBubble& bubble = s_lavaBubbles[i];
                    bubble.y -= bubble.vy;
                    bubble.x += 0.35f * sinf(bubble.y * 0.22f + bubble.phase);
                    if (bubble.y < -3.0f) {
                        bubble.y = 66.0f;
                        bubble.x = (float)(12 + animationRandom(104));
                        bubble.vy = 0.35f + 0.1f * (float)animationRandom(8);
                    }
                }
                break;
            case 6:
                s_sakuraScene.advance(RENDER_INTERVAL_MS);
                break;
            case 7:
                s_spaceScene.advance(RENDER_INTERVAL_MS);
                break;
        }
    }
}

void renderAnimSakura() {
    s_sakuraScene.render(s_display);
}

void renderAnimOrbit() {
    s_spaceScene.render(s_display);
}

struct ScreensaverAnim {
    void (*render)();
    const char* label;
};

const ScreensaverAnim kScreensaverAnims[NUM_SCREENSAVER_ANIMS] = {
    {renderAnimStarfield,    "DRIFTPAD"},
    {renderAnimPlasma,       "PLASMA"},
    {renderAnimTesseract,    "TESSERACT"},
    {renderAnimSynthGrid,    "DRIFT GRID"},
    {renderAnimRipples,      "MAG PULSE"},
    {renderAnimLava,         "LAVA LAMP"},
    {renderAnimSakura,       "SAKURA"},
    {renderAnimOrbit,        "ORBIT"},
};

// Blends two frames with a dithered diagonal wipe sweeping from top-left to bottom-right.
// Each pixel flips to the incoming frame once the sweep front passes (x + y) plus a 4x4
// Bayer offset, so the front is a soft ~64 px dithered band instead of a hard edge.
// front runs 0..256: 0 = all outgoing, 256 = all incoming.
void blendWipe(uint8_t* outgoing, const uint8_t* incoming, int16_t front) {
    static const uint8_t kBayer4[4][4] = {
        { 0,  8,  2, 10},
        {12,  4, 14,  6},
        { 3, 11,  1,  9},
        {15,  7, 13,  5},
    };
    for (uint8_t page = 0; page < SCREEN_HEIGHT / 8; ++page) {
        for (uint8_t x = 0; x < SCREEN_WIDTH; ++x) {
            uint8_t mask = 0;
            for (uint8_t bit = 0; bit < 8; ++bit) {
                uint8_t y = page * 8 + bit;
                int16_t key = x + y + kBayer4[y & 3][x & 3] * 4;
                if (key < front) {
                    mask |= 1 << bit;
                }
            }
            uint16_t idx = x + page * SCREEN_WIDTH;
            outgoing[idx] = (incoming[idx] & mask) | (outgoing[idx] & ~mask);
        }
    }
}

void renderScreensaver() {
    discardGridLatches();
    const uint32_t now = millis();
    const int8_t previousIncoming = s_ssPlayer.incoming();
    s_ssPlayer.advance(now);
    const int8_t shown = s_ssPlayer.shown();
    const int8_t incoming = s_ssPlayer.incoming();
    if (incoming >= 0 && incoming != previousIncoming) resetScreensaverAnimation(incoming);
    const uint32_t dt = now - s_ssLastFrameMs;
    s_ssLastFrameMs = now;
    advanceScreensaverAnimation(shown, dt);
    if (incoming >= 0) advanceScreensaverAnimation(incoming, dt);

    const uint32_t elapsed = s_ssPlayer.transitionElapsed(now);
    const char* badge = kScreensaverAnims[shown].label;
    const uint32_t badgeSince = s_ssPlayer.labelAge(now);
    s_display.clearDisplay();

    if (incoming < 0) {
        kScreensaverAnims[shown].render();
    } else {
        // State advances once from elapsed time; drawing both sides cannot speed either up.
        uint8_t* buf = s_display.getBuffer();
        kScreensaverAnims[incoming].render();
        memcpy(s_ssScratch, buf, sizeof(s_ssScratch));
        s_display.clearDisplay();
        kScreensaverAnims[shown].render();

        int16_t front = (int16_t)((elapsed * 256UL) / screensaver::TRANSITION_MS);
        blendWipe(buf, s_ssScratch, front);
        if (front >= 128) badge = kScreensaverAnims[incoming].label;
    }

    drawBadge(badge, badgeSince);

    s_display.display();
    publishDisplayState();
}

// ---------------------------------------------------------------------------------------
// Power-up / reset intro, drawn like an instrument coming up: corner brackets and a ruler along the
// bottom edge (the scale the key screen measures travel with) come on; the wordmark, a heavy
// extended italic with chamfered corners cut by a fine slit, arrives as two halves that DRIFT in from
// opposite sides and lock together, and a glint crosses it; a swell settles on a fine horizon
// beneath, and a tracked tagline types in while the ruler's bar fills. The tagline then erases itself
// and the pad's real status types in (calibration needed, output off or ready), a second glint
// crosses, and the whole screen wipes into the key screen. Any key press ends it early; otherwise it
// runs INTRO_MS and then INTRO_WIPE_MS of wipe.
// ---------------------------------------------------------------------------------------
constexpr uint32_t INTRO_MS = 5400;        // the intro proper
constexpr uint32_t INTRO_WIPE_MS = 700;    // then a dithered wipe into the key screen
uint32_t s_introStart = 0;
bool s_introDone = false;
int8_t s_introTheme = -1;   // the theme the title started in: it never changes style halfway

// The pad's state, as the title's last line says it
const char* introStatus() {
    switch (s_view.outputStatus) {
        case display_link::OUTPUT_ON:          return "Ready to type";
        case display_link::OUTPUT_NEEDS_CAL:   return "Calibrate keys";
        case display_link::OUTPUT_CALIBRATING: return "Calibrating keys";
        default:                               return "Output off";
    }
}

// 0 before `a`, 1 after `b`, linear between (times in ms)
float introSpan(uint32_t t, uint32_t a, uint32_t b) {
    if (t <= a) return 0.0f;
    if (t >= b) return 1.0f;
    return (float)(t - a) / (float)(b - a);
}

float introEaseOut(float p) {          // fast start, soft landing
    float q = 1.0f - p;
    return 1.0f - q * q * q;
}

// ---- the wordmark -----------------------------------------------------------------------------
// Each capital is a few filled polygons in an 18-unit-tall design space (stems 3 units, corners
// chamfered), slanted and squeezed a little to fit, then split into an upper and a lower half so the
// halves can drift independently. Counters are drawn last, in black.
struct IntroPt { float x, y; };

// Fills a polygon on screen rows [rowMin, rowMax] (scanline, even-odd), transformed from glyph units
void introFillPoly(const IntroPt* p, uint8_t n, int16_t ox, int16_t oy, int16_t rowMin, int16_t rowMax,
                   uint16_t color) {
    constexpr float SX = 0.85f;         // horizontal squeeze
    constexpr float SHEAR = 0.22f;      // italic slant: the top leans right
    float px[12], py[12];
    float lo = 1e9f, hi = -1e9f;
    for (uint8_t i = 0; i < n; ++i) {
        px[i] = ox + (p[i].x + (18.0f - p[i].y) * SHEAR) * SX;
        py[i] = oy + p[i].y;
        if (py[i] < lo) lo = py[i];
        if (py[i] > hi) hi = py[i];
    }
    int16_t y0 = (int16_t)floorf(lo), y1 = (int16_t)ceilf(hi) - 1;
    if (y0 < rowMin) y0 = rowMin;
    if (y1 > rowMax) y1 = rowMax;
    for (int16_t y = y0; y <= y1; ++y) {
        const float yc = y + 0.5f;
        float xs[8];
        uint8_t k = 0;
        for (uint8_t i = 0; i < n; ++i) {
            uint8_t j = (i + 1) % n;
            if ((py[i] <= yc && py[j] > yc) || (py[j] <= yc && py[i] > yc)) {
                if (k < 8) xs[k++] = px[i] + (yc - py[i]) * (px[j] - px[i]) / (py[j] - py[i]);
            }
        }
        for (uint8_t a = 1; a < k; ++a) {       // sort the crossings
            float v = xs[a];
            int8_t b = (int8_t)a - 1;
            while (b >= 0 && xs[b] > v) { xs[b + 1] = xs[b]; --b; }
            xs[b + 1] = v;
        }
        for (uint8_t a = 0; a + 1 < k; a += 2) {
            int16_t xa = (int16_t)lroundf(xs[a]), xb = (int16_t)lroundf(xs[a + 1]);
            if (xb > xa) s_display.drawFastHLine(xa, y, xb - xa, color);
        }
    }
}

#define IP(...) __VA_ARGS__
// Draws one glyph's white shapes then its counters, on the rows given. Returns the advance (in
// glyph units, before the squeeze).
float introGlyphHalf(char c, int16_t ox, int16_t oy, int16_t rowMin, int16_t rowMax) {
    auto white = [&](std::initializer_list<IntroPt> pts) {
        IntroPt buf[12];
        uint8_t n = 0;
        for (const IntroPt& q : pts) if (n < 12) buf[n++] = q;
        introFillPoly(buf, n, ox, oy, rowMin, rowMax, OLED_COLOR_WHITE);
    };
    auto black = [&](std::initializer_list<IntroPt> pts) {
        IntroPt buf[12];
        uint8_t n = 0;
        for (const IntroPt& q : pts) if (n < 12) buf[n++] = q;
        introFillPoly(buf, n, ox, oy, rowMin, rowMax, OLED_COLOR_BLACK);
    };
    switch (c) {
        case 'D':
            white({{0, 0}, {8, 0}, {12, 4}, {12, 14}, {8, 18}, {0, 18}});
            black({{3, 3}, {7, 3}, {9, 5}, {9, 13}, {7, 15}, {3, 15}});
            return 12;
        case 'R':
            white({{0, 0}, {9, 0}, {12, 3}, {12, 9}, {9, 11}, {0, 11}});
            white({{0, 0}, {3, 0}, {3, 18}, {0, 18}});
            white({{6, 11}, {10, 11}, {13, 18}, {9, 18}});
            black({{3, 3}, {8, 3}, {9, 4}, {9, 7}, {8, 8}, {3, 8}});
            return 13;
        case 'I':
            white({{0, 0}, {3, 0}, {3, 18}, {0, 18}});
            return 3;
        case 'F':
            white({{0, 0}, {12, 0}, {10.5f, 3}, {0, 3}});
            white({{0, 0}, {3, 0}, {3, 18}, {0, 18}});
            white({{0, 8}, {9, 8}, {8, 11}, {0, 11}});
            return 12;
        case 'T':
            white({{0, 0}, {14, 0}, {12.5f, 3}, {1.5f, 3}});
            white({{5.5f, 0}, {8.5f, 0}, {8.5f, 18}, {5.5f, 18}});
            return 14;
        case 'P':
            white({{0, 0}, {9, 0}, {12, 3}, {12, 9}, {9, 12}, {0, 12}});
            white({{0, 0}, {3, 0}, {3, 18}, {0, 18}});
            black({{3, 3}, {8, 3}, {9, 4}, {9, 8}, {8, 9}, {3, 9}});
            return 12;
        case 'A':
            white({{0, 18}, {5, 0}, {9, 0}, {14, 18}, {10.5f, 18}, {9.6f, 14.5f}, {4.4f, 14.5f}, {3.5f, 18}});
            black({{5.4f, 11.5f}, {8.6f, 11.5f}, {7, 5.5f}});
            return 14;
        default:
            return 8;
    }
}
#undef IP

constexpr int16_t WORD_TOP = 13;          // top row of the capitals (18 rows)
constexpr int16_t WORD_LEFT = 10;         // the wordmark is 108 px wide with its slant, so 10 centres it
constexpr int16_t WORD_WIDTH = 108;       // the drawn extent, used for the horizon beneath
constexpr int16_t WORD_GAP = 4;           // px between letters
constexpr int16_t SLIT_ROW = 9;           // the empty row that cuts every letter, from WORD_TOP

// Draws the wordmark at time t: each letter's upper half drifts in from the left and its lower half
// from the right, letters staggered, easing to rest and locking together
void drawIntroWordmark(uint32_t t) {
    static const char kName[] = "DRIFTPAD";
    int16_t x = WORD_LEFT;
    for (uint8_t i = 0; i < 8; ++i) {
        const float p = introEaseOut(introSpan(t, 350 + 80u * i, 1150 + 80u * i));
        const int16_t away = (int16_t)lroundf((1.0f - p) * 10.0f);
        float adv = 0;
        if (p > 0.0f) {
            adv = introGlyphHalf(kName[i], x - away, WORD_TOP, WORD_TOP, WORD_TOP + SLIT_ROW - 1);
            introGlyphHalf(kName[i], x + away, WORD_TOP, WORD_TOP + SLIT_ROW + 1, WORD_TOP + 17);
        } else {
            // Not started yet: still advance the pen by this letter's width
            static const uint8_t kWidth[] = {12, 13, 3, 12, 14, 12, 14, 12};
            adv = kWidth[i];
        }
        x += (int16_t)lroundf(adv * 0.85f) + WORD_GAP;
    }
}

// One glint crossing the finished wordmark: a slanted band inverts the lit pixels under it
void drawIntroGlint(uint32_t t, uint32_t from, uint32_t to) {
    const float p = introSpan(t, from, to);
    if (p <= 0.0f || p >= 1.0f) return;
    uint8_t* buf = s_display.getBuffer();
    const float center = WORD_LEFT - 12 + p * (WORD_WIDTH + 30);
    for (int16_t y = WORD_TOP; y < WORD_TOP + 18; ++y) {
        const float lean = (18.0f - (y - WORD_TOP)) * 0.22f * 0.85f;
        for (int16_t x = (int16_t)(center + lean) - 3; x <= (int16_t)(center + lean) + 3; ++x) {
            if (x < 0 || x > 127) continue;
            if (buf[x + (y >> 3) * 128] & (1 << (y & 7))) {
                buf[x + (y >> 3) * 128] &= (uint8_t)~(1 << (y & 7));   // a lit pixel under the glint goes dark
            }
        }
    }
}

// ---- the rest of the frame ---------------------------------------------------------------------
// The horizon under the wordmark, with a low swell riding on it that keeps rolling
void drawIntroHorizon(uint32_t t) {
    const float ts = t / 1000.0f;
    const int16_t revealedTo = WORD_LEFT + (int16_t)(introSpan(t, 1100, 2000) * WORD_WIDTH);
    const int16_t y0 = 39;
    int16_t px = 0, py = 0;
    for (int16_t x = WORD_LEFT; x < WORD_LEFT + WORD_WIDTH && x <= revealedTo; ++x) {
        float k = (float)(x - WORD_LEFT) / WORD_WIDTH;
        float envelope = sinf(k * 3.1415926f);                        // calm at both ends
        int16_t y = y0 + (int16_t)lroundf(sinf(x * 0.30f - ts * 3.2f) * 2.2f * envelope);
        if (x > WORD_LEFT) s_display.drawLine(px, py, x, y, OLED_COLOR_WHITE);
        px = x;
        py = y;
    }
    // End caps, like the ends of a scale
    if (revealedTo > WORD_LEFT) s_display.drawFastVLine(WORD_LEFT, y0 - 3, 7, OLED_COLOR_WHITE);
    if (revealedTo >= WORD_LEFT + WORD_WIDTH - 1) {
        s_display.drawFastVLine(WORD_LEFT + WORD_WIDTH - 1, y0 - 3, 7, OLED_COLOR_WHITE);
    }
}

void drawIntroFrame(uint32_t t) {
    // Corner brackets
    const int16_t arm = (int16_t)(7 * introSpan(t, 0, 350));
    if (arm > 0) {
        s_display.drawFastHLine(0, 0, arm, OLED_COLOR_WHITE);
        s_display.drawFastVLine(0, 0, arm, OLED_COLOR_WHITE);
        s_display.drawFastHLine(128 - arm, 0, arm, OLED_COLOR_WHITE);
        s_display.drawFastVLine(127, 0, arm, OLED_COLOR_WHITE);
        s_display.drawFastHLine(0, 63, arm, OLED_COLOR_WHITE);
        s_display.drawFastVLine(0, 64 - arm, arm, OLED_COLOR_WHITE);
        s_display.drawFastHLine(128 - arm, 63, arm, OLED_COLOR_WHITE);
        s_display.drawFastVLine(127, 64 - arm, arm, OLED_COLOR_WHITE);
    }

    // The ruler along the bottom: a baseline with ticks (long every 20 px), and a bar filling under it
    const int16_t rulerEnd = 4 + (int16_t)(120 * introSpan(t, 0, 500));
    if (rulerEnd > 4) {
        s_display.drawFastHLine(4, 59, rulerEnd - 4, OLED_COLOR_WHITE);
        for (int16_t x = 4; x <= rulerEnd; x += 4) {
            const bool major = (x - 4) % 20 == 0;
            s_display.drawFastVLine(x, major ? 54 : 56, major ? 5 : 3, OLED_COLOR_WHITE);
        }
    }
    const int16_t fill = (int16_t)(120UL * (t > INTRO_MS ? INTRO_MS : t) / INTRO_MS);
    if (fill > 0) s_display.fillRect(4, 61, fill, 2, OLED_COLOR_WHITE);
}

void renderIntroFrame(uint32_t t) {
    s_display.clearDisplay();
    if (s_introTheme < 0 && s_haveView) s_introTheme = (int8_t)activeTheme();
    if (s_introTheme == THEME_SAKURA) {
        sakura::drawIntro(s_display, t, introStatus());
        return;
    }
    if (s_introTheme == THEME_SPACE) {
        space::drawIntro(s_display, t, introStatus());
        return;
    }

    drawIntroWordmark(t);
    drawIntroGlint(t, 1900, 2500);
    drawIntroGlint(t, 4700, 5300);
    drawIntroHorizon(t);

    // Tagline in tracked capitals, typed in, later erased; then the pad's real status types in
    {
        static const char kTag[] = "HALL-EFFECT";
        const uint8_t tagLen = sizeof(kTag) - 1;
        int16_t shown = 0;
        if (t >= 2000) shown = (int16_t)((t - 2000) / 55);
        if (shown > tagLen) shown = tagLen;
        if (t >= 3300) shown = tagLen - (int16_t)((t - 3300) / 30);    // erased again
        if (shown < 0) shown = 0;
        const int16_t pitch = 8;
        const int16_t left = 64 - (int16_t)(tagLen * pitch) / 2 + 1;
        s_display.setTextSize(1);
        s_display.setTextColor(OLED_COLOR_WHITE);
        for (int16_t i = 0; i < shown; ++i) {
            s_display.setCursor(left + i * pitch, 46);
            s_display.print(kTag[i]);
        }
        const bool typing = (t >= 2000 && t < 2000 + 55u * tagLen) || (t >= 3300 && shown > 0);
        if (typing) s_display.fillRect(left + shown * pitch, 46, 5, 7, OLED_COLOR_WHITE);   // cursor

        if (t >= 3700) {
            const char* status = introStatus();
            const int16_t len = (int16_t)strlen(status);
            int16_t typed = (int16_t)((t - 3700) / 45);
            if (typed > len) typed = len;
            char buf[24];
            memcpy(buf, status, typed);
            buf[typed] = '\0';
            const int16_t sx = 64 - len * 6 / 2;
            s_display.setCursor(sx, 46);
            s_display.print(buf);
            if (typed < len || ((t / 400) & 1)) s_display.fillRect(sx + typed * 6, 46, 5, 7, OLED_COLOR_WHITE);
        }
    }
    // The firmware version, top right, once the name is up
    if (t >= 2300) {
        const char* ver = "v" DRIFTPAD_FW_VERSION;
        s_display.setTextSize(1);
        s_display.setTextColor(OLED_COLOR_WHITE);
        s_display.setCursor(120 - textWidth(ver), 3);
        s_display.print(ver);
    }

    drawIntroFrame(t);
}

// One intro frame, and after INTRO_MS a dithered wipe into the key screen (both keep animating)
void presentIntro(uint32_t t) {
    if (t < INTRO_MS) {
        renderIntroFrame(t);
        s_display.display();
        return;
    }
    const uint32_t now = millis();
    uint8_t* buf = s_display.getBuffer();
    renderKeysFrame(now);
    memcpy(s_ssScratch, buf, sizeof(s_ssScratch));
    renderIntroFrame(t);
    int16_t front = (int16_t)(((t - INTRO_MS) * 256UL) / INTRO_WIPE_MS);
    if (front > 256) front = 256;
    blendWipe(buf, s_ssScratch, front);
    s_display.display();
}

void renderScreen() {
    if (s_screensaverActive) {
        renderScreensaver();
        return;
    }
    if (s_fullScreenMode) {
        renderFullScreen();
    } else {
        renderSafeZoneScreen();
    }
}

// ============================================================================================
// Core 1: Wire, the display, the idle timers and every frame. Nothing here runs on core 0.
// ============================================================================================

// Frees a bus a previous crash left with SDA held low (NXP UM10204: nine SCL pulses, then a
// STOP condition), then starts Wire at 100 kHz.
void initI2cBus() {
    pinMode(OLED_SDA_PIN, INPUT_PULLUP);
    pinMode(OLED_SCL_PIN, OUTPUT);
    for (int i = 0; i < 9; i++) {
        digitalWrite(OLED_SCL_PIN, HIGH);
        delayMicroseconds(10);
        digitalWrite(OLED_SCL_PIN, LOW);
        delayMicroseconds(10);
    }
    pinMode(OLED_SDA_PIN, OUTPUT);
    digitalWrite(OLED_SDA_PIN, LOW);
    delayMicroseconds(10);
    digitalWrite(OLED_SCL_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(OLED_SDA_PIN, HIGH);
    delayMicroseconds(10);

    pinMode(OLED_SDA_PIN, INPUT_PULLUP);
    pinMode(OLED_SCL_PIN, INPUT_PULLUP);
    gpio_pull_up(OLED_SDA_PIN);
    gpio_pull_up(OLED_SCL_PIN);

    Wire.setSDA(OLED_SDA_PIN);
    Wire.setSCL(OLED_SCL_PIN);
    Wire.begin();
    Wire.setClock(100000); // 100kHz standard mode for robust signal integrity
    Wire.setTimeout(50, true);
}

void drawSplash() {
    s_display.clearDisplay();
    s_display.setTextColor(OLED_COLOR_WHITE);

    if (s_fullScreenMode) {
        s_display.drawRoundRect(0, 0, 128, 64, 3, OLED_COLOR_WHITE);
        s_display.setTextSize(2);
        s_display.setCursor(64 - textWidth("DRIFTPAD", 2) / 2, 9);
        s_display.print("DRIFTPAD");
        s_display.setTextSize(1);

        s_display.drawFastHLine(8, 29, 112, OLED_COLOR_WHITE);
        printCentered("RAPID TRIGGER", 64, 35);
        printCentered("v" DRIFTPAD_FW_VERSION, 64, 49);
    } else {
        // Safe splash screen in Y: 25..63
        s_display.drawFastHLine(0, 25, 128, OLED_COLOR_WHITE);
        s_display.setCursor(10, 29);
        s_display.println("DRIFTPAD HE READY");
        s_display.setCursor(10, 41);
        s_display.println("Rapid Trigger Active");
        s_display.setCursor(10, 52);
        s_display.println("USB Config Connected");
        s_display.drawRect(0, 25, 128, 39, OLED_COLOR_WHITE);
        s_display.fillRect(0, 0, 128, 25, OLED_COLOR_BLACK);
    }

    s_display.display();
}

void drawTestPattern() {
    s_display.clearDisplay();
    s_display.fillRect(0, 25, 128, 39, OLED_COLOR_WHITE);
    s_display.setTextColor(OLED_COLOR_BLACK, OLED_COLOR_WHITE);
    s_display.setTextSize(1);
    s_display.setCursor(10, 32);
    s_display.print("DRIFTPAD ACTIVE!");
    s_display.setCursor(10, 46);
    s_display.print("SSD1306 SAFE ZONE");
    s_display.fillRect(0, 0, 128, 25, OLED_COLOR_BLACK);
    s_display.display();
    s_display.setTextColor(OLED_COLOR_WHITE);
}

// Probes every 7-bit address; the ones that ACK go to `found` (at most SCAN_MAX), returns the count
uint8_t scanBus(uint8_t* found) {
    uint8_t count = 0;
    for (uint8_t addr = 1; addr < 127; addr++) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) {
            if (count < display_link::SCAN_MAX) found[count] = addr;
            count++;
        }
    }
    return count;
}

// Leaves sleep and the screensaver and restarts the idle timers. Key edges that happened while
// the key map was not on screen are dropped; an awake map keeps its latches, so a quick tap
// between two frames still shows while commands or the knob keep the display awake.
void wakeDisplay(uint32_t now) {
    s_testPatternActive = false;
    const bool wasHidden = s_displaySleeping || s_screensaverActive;
    s_lastActivityTime = now;
    if (s_displaySleeping) {
        if (s_initialized) s_display.ssd1306_command(SSD1306_DISPLAYON);
        s_displaySleeping = false;
    }
    s_screensaverActive = false;
    if (s_isDimmed) {
        if (s_initialized) setDimmed(false);
        s_isDimmed = false;
    }
    if (wasHidden) discardGridLatches();
    s_forceRender = true;
    publishDisplayState();
}

void sleepDisplay() {
    s_testPatternActive = false;
    s_displaySleeping = true;
    s_screensaverActive = false;
    publishDisplayState();
    if (!s_initialized) return;
    s_display.clearDisplay();
    s_display.display();
    s_display.ssd1306_command(SSD1306_DISPLAYOFF);
}

void startScreensaver(uint32_t now, int8_t anim) {
    s_testPatternActive = false;
    if (s_displaySleeping) {
        if (s_initialized) s_display.ssd1306_command(SSD1306_DISPLAYON);
        s_displaySleeping = false;
    }
    s_screensaverActive = true;
    s_screensaverStartTime = now;
    const uint32_t seed = (uint32_t)micros() ^ (++s_ssSessionNonce * 0x9e3779b9u);
    s_ssPlayer.start(now, anim, seed);
    s_ssLastFrameMs = now;
    resetScreensaverAnimations(seed ^ 0x85ebca6bu);
    if (s_isDimmed) {
        if (s_initialized) setDimmed(false);
        s_isDimmed = false;
    }
    // An explicit display action takes effect immediately even during the power-up title.
    s_introDone = true;
    s_lastActivityTime = now;
    s_forceRender = true;
    publishDisplayState();
}

// Serves what core 0 posted. Mode actions and the test pattern replace display content, so they are
// applied in the order they were posted.
void serveRequests(uint32_t now) {
    struct Item { Request r; uint32_t ticket; uint32_t stamp; int32_t arg; };
    Item items[4];
    uint8_t n = 0;
    for (Request r : { Request::Wake, Request::Sleep, Request::Screensaver, Request::TestPattern }) {
        Item it = { r, 0, 0, 0 };
        it.ticket = display_link::pending(r, &it.arg, &it.stamp);
        if (it.ticket == 0) continue;
        uint8_t j = n++;
        while (j > 0 && (int32_t)(items[j - 1].stamp - it.stamp) > 0) {
            items[j] = items[j - 1];
            --j;
        }
        items[j] = it;
    }
    for (uint8_t i = 0; i < n; ++i) {
        switch (items[i].r) {
            case Request::Wake:        wakeDisplay(now); break;
            case Request::Sleep:       sleepDisplay(); break;
            case Request::Screensaver: startScreensaver(now, (int8_t)items[i].arg); break;
            case Request::TestPattern:
                if (s_initialized) {
                    drawTestPattern();
                    s_testPatternAt = now;
                    s_testPatternActive = true;
                }
                break;
            default: break;
        }
        display_link::markServed(items[i].r, items[i].ticket);
    }

    uint32_t t = display_link::pending(Request::ScanBus);
    if (t != 0) {
        uint8_t found[display_link::SCAN_MAX];
        uint8_t count = scanBus(found);
        display_link::setScanResult(found, count);
        display_link::markServed(Request::ScanBus, t);
    }
}

} // namespace

// RP2040 Core 1: runs in parallel with core 0 from power-up. The I2C transfer of a frame (~23 ms
// at 100 kHz) and everything else about the display happen here, so core 0's 1 kHz scan never
// waits for the bus.
void setup1() {
    initI2cBus();
    delay(100);
    s_lastInitAttempt = millis();
    s_introStart = millis();
    if (initDisplayHardware()) {
        drawSplash();
        s_initialized = true;
    }
    s_lastActivityTime = millis();
    s_lastRenderTime = millis();
    publishDisplayState();
}

// A key counts as activity when it is pressed or has moved since the last check. A key
// parked at a small resting offset is not activity, otherwise it would hold the display
// awake forever and the screensaver and sleep timeouts would never run.
constexpr float ACTIVITY_MOVE_MM = 0.15f;
float s_activityRefTravel[NUM_KEYS] = {0};
uint8_t s_activityPressCount[NUM_KEYS] = {0};
bool s_activityInputWasValid = false;

bool keysShowActivity() {
    if (!s_view.keyInputValid) {
        s_activityInputWasValid = false;
        for (uint8_t i = 0; i < NUM_KEYS; ++i) {
            s_activityPressCount[i] = s_view.keys[i].pressCount;
            s_activityRefTravel[i] = 0.0f;
        }
        return false;
    }
    const bool firstTrusted = !s_activityInputWasValid;
    s_activityInputWasValid = true;
    bool active = false;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        const display_link::KeyView& k = s_view.keys[i];
        if (!firstTrusted && k.pressCount != s_activityPressCount[i]) active = true;
        s_activityPressCount[i] = k.pressCount;
        float mm = k.travelMm;
        if (firstTrusted) s_activityRefTravel[i] = mm;
        if (fabsf(mm - s_activityRefTravel[i]) > ACTIVITY_MOVE_MM) {
            s_activityRefTravel[i] = mm;
            active = true;
        }
        if (k.pressed) {
            active = true;
        }
    }
    return active;
}

bool introKeyPressed() {
    if (!s_view.keyInputValid) return false;
    if (s_view.outputStatus == display_link::OUTPUT_NEEDS_CAL ||
        s_view.outputStatus == display_link::OUTPUT_CALIBRATING) return false;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        if (s_view.keys[i].pressed) return true;
    }
    return false;
}

void loop1() {
    const uint32_t now = millis();

    if (display_link::read(s_view)) {
        s_haveView = true;
    } else if (s_haveView) {
        display_link::noteStaleFrame();   // every copy raced a publish: draw last frame's data
    }
    serveRequests(now);

    if (!s_initialized) {
        if (now - s_lastInitAttempt >= DISPLAY_RETRY_MS) {
            s_lastInitAttempt = now;
            if (initDisplayHardware()) {
                s_initialized = true;
                // begin() powers the controller on and resets its brightness. Restore
                // requests already applied while the panel was unavailable.
                setDimmed(s_isDimmed);
                if (s_displaySleeping) s_display.ssd1306_command(SSD1306_DISPLAYOFF);
                s_forceRender = true;
                publishDisplayState();
            }
        }
        delay(10);
        return;
    }
    // Power-up / reset intro. A key press ends it early; nothing else waits for it (core 0 already
    // scans and types), it only holds the display.
    if (!s_introDone) {
        // Startup offsets and unpressed motion can wake an idle screen, but must not skip
        // the title animation. Only an actuated key dismisses it early.
        if (now - s_introStart >= INTRO_MS + INTRO_WIPE_MS || (s_haveView && introKeyPressed())) {
            s_introDone = true;
            s_lastActivityTime = now;
            s_forceRender = true;
        } else {
            if (now - s_lastRenderTime >= RENDER_INTERVAL_MS) {
                s_lastRenderTime = now;
                presentIntro(now - s_introStart);
            } else {
                delay(2);
            }
            return;
        }
    }

    if (s_testPatternActive && now - s_testPatternAt >= TEST_PATTERN_MS) {
        s_testPatternActive = false;
        s_forceRender = true;
    }
    if (!s_haveView || s_testPatternActive) {
        delay(2);   // splash (nothing published yet) or the test pattern stays on screen
        return;
    }

    // Key activity can wake an explicitly hidden display. Idle never changes the selected screen.
    if (keysShowActivity()) {
        s_lastActivityTime = now;
        if (s_displaySleeping || s_screensaverActive || s_isDimmed) wakeDisplay(now);
    }

    // Idle: the screensaver chosen in the settings starts by itself (saverIdleMin 0 = never). Not over
    // the tuning menu, and not while keys cannot be trusted (calibration missing or running), when
    // the screen's calibration hint matters more and key presses do not count as activity.
    if (s_view.saverIdleMin != 0 && !s_screensaverActive && !s_displaySleeping && !s_menuRequested &&
        s_view.keyInputValid && now - s_lastActivityTime >= (uint32_t)s_view.saverIdleMin * 60000u) {
        startScreensaver(now, s_view.saverAnim);
    }

    // The screensaver dims after it has been on for a while (any input wakes it to full brightness)
    if (s_screensaverActive && !s_isDimmed && now - s_screensaverStartTime >= SCREENSAVER_DIM_DELAY_MS) {
        setDimmed(true);
        publishDisplayState();
    }

    if (s_displaySleeping) {
        delay(20);
        return;
    }

    bool shouldRender = s_forceRender || ((now - s_lastRenderTime) >= RENDER_INTERVAL_MS);
    if (shouldRender) {
        s_forceRender = false;
        s_lastRenderTime = now;
        renderScreen();
    } else {
        delay(2);
    }
}

// ============================================================================================
// Core 0 API: the menu state and requests. Nothing below touches Wire or the display.
// ============================================================================================

void oledInit() {
    s_currentMenu = MenuMode::ADJUST_RT;
    s_menuRequested = false;
    s_menuLastActive = millis() - 10000;   // no menu card at power-up
    s_fullScreenMode = true;
    s_requestedAnim = -1;
}

// Encoder input that lands on a sleeping or screensaver display only wakes it. The rest of
// the spin (or switch bounce) that follows within the grace window is swallowed too, so a
// wake never changes the menu or a setting.
constexpr uint32_t ENCODER_WAKE_GRACE_MS = 300;
static uint32_t s_encoderWakeTime = 0;
static bool s_encoderWokeDisplay = false;

static bool consumeEncoderWake() {
    uint32_t now = millis();
    if (s_displaySleeping || s_screensaverActive) {
        display_link::post(Request::Wake);
        s_encoderWakeTime = now;
        s_encoderWokeDisplay = true;
        return true;
    }
    if (s_encoderWokeDisplay && (now - s_encoderWakeTime) < ENCODER_WAKE_GRACE_MS) {
        return true;
    }
    s_encoderWokeDisplay = false;
    return false;
}

void oledCycleMenu() {
    if (consumeEncoderWake()) return;

    if (!s_menuRequested) {
        s_currentMenu = MenuMode::ADJUST_RT;
        s_menuRequested = true;
    } else {
        uint8_t next = static_cast<uint8_t>(s_currentMenu) + 1;
        if (next == static_cast<uint8_t>(MenuMode::COUNT)) {
            s_menuRequested = false;
            s_currentMenu = MenuMode::ADJUST_RT;
        } else {
            s_currentMenu = static_cast<MenuMode>(next);
        }
    }
    s_menuLastActive = millis();
    display_link::post(Request::Wake);
}

bool oledMenuOpen() {
    return s_menuRequested;
}

void oledCloseMenu() {
    if (!s_menuRequested) return;
    s_menuRequested = false;
    s_currentMenu = MenuMode::ADJUST_RT;
    s_menuLastActive = millis();
    display_link::post(Request::Wake);
}

bool oledAdjustCurrentSetting(int32_t delta) {
    if (delta == 0) return false;
    if (consumeEncoderWake()) return false;

    s_menuRequested = true;
    s_menuLastActive = millis();
    bool changed = encoderMenuApply(s_currentMenu, delta);
    display_link::post(Request::Wake);
    return changed;
}

void oledSetFullScreen(bool enabled) {
    s_fullScreenMode = enabled;
    display_link::post(Request::Wake);
}

bool oledIsFullScreen() {
    return s_fullScreenMode;
}

void oledTriggerScreensaver() {
    display_link::post(Request::Screensaver, s_requestedAnim);
}

bool oledIsScreensaverActive() {
    return s_screensaverActive;
}

void oledSetScreensaverAnim(int8_t animIdx) {
    s_requestedAnim = animIdx;
}

void oledWake() {
    display_link::post(Request::Wake);
}

void oledSleep() {
    display_link::post(Request::Sleep);
}

bool oledIsSleeping() {
    return s_displaySleeping;
}

uint32_t oledPost(OledRequest r) {
    return display_link::post(r == OledRequest::BusScan ? Request::ScanBus : Request::TestPattern);
}

bool oledRequestServed(OledRequest r, uint32_t ticket) {
    return display_link::isServed(r == OledRequest::BusScan ? Request::ScanBus : Request::TestPattern, ticket);
}

uint8_t oledBusScanResult(uint8_t* found, uint8_t max) {
    return display_link::scanResult(found, max);
}
