#include "oled.h"
#include "pins.h"
#include "hall.h"
#include "config.h"

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Fonts/FreeSansBold9pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSansBold18pt7b.h>

#if USE_SH1106
#include <Adafruit_SH110X.h>
#else
#include <Adafruit_SSD1306.h>
#endif
#include <pico/mutex.h>

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

MenuMode s_currentMenu = MenuMode::ADJUST_RT;
uint32_t s_lastRenderTime = 0;
constexpr uint32_t RENDER_INTERVAL_MS = 33; // ~30 FPS

volatile bool s_initialized = false;
volatile bool s_core1Running = false;
volatile bool s_forceRender = false;
volatile bool s_fullScreenMode = true;
volatile bool s_screensaverActive = false;
volatile bool s_displaySleeping = false;
volatile int8_t s_forcedAnim = -1;
volatile uint32_t s_screensaverStartTime = 0;
constexpr uint32_t SCREENSAVER_TIMEOUT_MS = 45000;       // 45s idle -> start screensaver
constexpr uint32_t SCREENSAVER_ANIM_CYCLE_MS = 20000;   // 20s per animation cycle (0 -> 1 -> ... -> 5)
constexpr uint32_t DISPLAY_SLEEP_TIMEOUT_MS = 3600000UL; // 1 hour (3600s) -> turn display OFF
volatile uint32_t s_menuLastActive = 0;
volatile uint32_t s_lastActivityTime = 0;
volatile bool s_isDimmed = false;
auto_init_mutex(s_wireMutex);

// Core 1 local copies of edge counters for lock-free display rendering
static uint8_t s_lastPressCount[NUM_KEYS] = {0};
static uint8_t s_lastReleaseCount[NUM_KEYS] = {0};
static bool s_gridCountersSynced = false;

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

// Discards stale latches/counts accumulated while non-grid screens were visible
void discardGridLatches() {
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        s_lastPressCount[i] = HallManager::getKey(i).getPressCount();
        s_lastReleaseCount[i] = HallManager::getKey(i).getReleaseCount();
        s_focusSeenPress[i] = s_lastPressCount[i];
    }
}

// Picks the focused key for this frame:
//  1. A new actuation always takes focus (the key HallManager reports, else the deepest).
//  2. A focused key keeps focus until it is released and has sat at rest for FOCUS_SETTLE_MS;
//     other keys moving or going deeper never steal it.
//  3. With no focus, the deepest key that is held or has moved FOCUS_ACQUIRE_MM acquires it.
// The gap between FOCUS_REST_MM and FOCUS_ACQUIRE_MM keeps noise at rest from flickering it.
void selectDisplayFocus(uint32_t now) {
    int8_t newPress = -1;
    int8_t lastActive = HallManager::getLastActiveKey();
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        uint8_t presses = HallManager::getKey(i).getPressCount();
        if (presses != s_focusSeenPress[i]) {
            s_focusSeenPress[i] = presses;
            if (newPress < 0 || i == lastActive ||
                (newPress != lastActive &&
                 HallManager::getKey(i).getTravelMm() > HallManager::getKey((uint8_t)newPress).getTravelMm())) {
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
        HallKey& k = HallManager::getKey((uint8_t)s_focusKey);
        if (k.isPressed() || k.getTravelMm() > FOCUS_REST_MM) {
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
        HallKey& k = HallManager::getKey(i);
        float mm = k.getTravelMm();
        if ((k.isPressed() || mm >= FOCUS_ACQUIRE_MM) && (s_focusKey < 0 || mm > deepest)) {
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

// Width in pixels of a string in the built-in 6x8 font (no trailing gap)
int16_t textWidth(const char* text, uint8_t size = 1) {
    return (int16_t)(strlen(text) * 6 * size) - size;
}

void printCentered(const char* text, int16_t centerX, int16_t y, uint8_t size = 1) {
    s_display.setTextSize(size);
    s_display.setCursor(centerX - textWidth(text, size) / 2, y);
    s_display.print(text);
}

// Shared header (Y: 0..10): checkered flag, inverted banner, speed chevrons, status pill
void drawHeader(const char* banner, const char* pill) {
    for (int8_t r = 0; r < 4; ++r) {
        for (int8_t c = 0; c < 3; ++c) {
            if ((r + c) % 2 == 0) {
                s_display.fillRect(c * 2, 1 + r * 2, 2, 2, OLED_COLOR_WHITE);
            }
        }
    }

    // Banner X: 7..72 fits 11 characters
    s_display.fillRect(7, 0, 66, 10, OLED_COLOR_WHITE);
    s_display.setTextColor(OLED_COLOR_BLACK, OLED_COLOR_WHITE);
    s_display.setTextSize(1);
    s_display.setCursor(7 + (67 - textWidth(banner)) / 2, 1);
    s_display.print(banner);

    s_display.drawLine(77, 0, 74, 10, OLED_COLOR_WHITE);
    s_display.drawLine(81, 0, 78, 10, OLED_COLOR_WHITE);
    s_display.drawLine(85, 0, 82, 10, OLED_COLOR_WHITE);

    // Pill X: 87..126 fits 6 characters
    constexpr int16_t PILL_X = 87;
    constexpr int16_t PILL_W = 40;
    s_display.drawRoundRect(PILL_X, 0, PILL_W, 11, 2, OLED_COLOR_WHITE);
    s_display.setTextColor(OLED_COLOR_WHITE);
    s_display.setCursor(PILL_X + (PILL_W - textWidth(pill)) / 2, 2);
    s_display.print(pill);
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
};
constexpr uint8_t NUM_STARS = 26;
Star s_stars[NUM_STARS];
bool s_starsInit = false;

int16_t s_badgeX = 18;
int16_t s_badgeY = 18;
int8_t s_badgeDX = 1;
int8_t s_badgeDY = 1;

void initStarfield() {
    for (uint8_t i = 0; i < NUM_STARS; ++i) {
        s_stars[i].x = (rand() % 240) - 120;
        s_stars[i].y = (rand() % 120) - 60;
        s_stars[i].z = (rand() % 90) + 10;
        s_stars[i].prev_x = -1;
        s_stars[i].prev_y = -1;
    }
    s_starsInit = true;
}

// Animation 1: Digital Matrix Rain
struct RainDrop {
    int8_t y;
    int8_t speed;
    uint8_t length;
};
constexpr uint8_t RAIN_COLS = 16;
RainDrop s_rain[RAIN_COLS];
bool s_rainInit = false;

void initRain() {
    for (uint8_t c = 0; c < RAIN_COLS; ++c) {
        s_rain[c].y = rand() % 64;
        s_rain[c].speed = (rand() % 2) + 1;
        s_rain[c].length = (rand() % 8) + 6;
    }
    s_rainInit = true;
}

// Animation 2: Oscilloscope Sine Flow
float s_wavePhase = 0.0f;

// Animation 3: Synthwave Horizon Grid
float s_gridScroll = 0.0f;
uint8_t s_gridFrame = 0;

// Animation 4: Magnetic Pulse Ripples
struct Ripple {
    int16_t x, y;
    int16_t r;      // Current radius; <= 0 means waiting to spawn
    int16_t maxR;
};
constexpr uint8_t NUM_RIPPLES = 4;
Ripple s_ripples[NUM_RIPPLES];
bool s_ripplesInit = false;

// Animation 5: Lava Lamp metaballs (field sampled on a 4 px grid, interpolated per pixel)
constexpr uint8_t LAVA_BLOBS = 5;
constexpr uint8_t LAVA_GX = SCREEN_WIDTH / 4 + 1;
constexpr uint8_t LAVA_GY = SCREEN_HEIGHT / 4 + 1;
uint16_t s_lavaGrid[LAVA_GY][LAVA_GX];
uint16_t s_lavaRows[3][SCREEN_WIDTH];   // Rolling window of interpolated field rows (y-1, y, y+1)
float s_lavaTime = 0.0f;

// Screensaver sequencing & cross-animation transition
constexpr uint8_t NUM_SCREENSAVER_ANIMS = 6;
constexpr uint32_t SCREENSAVER_TRANSITION_MS = 1500;    // Dithered diagonal wipe between animations
int8_t s_ssShownAnim = -1;       // Animation fully on screen (or the one being wiped away)
int8_t s_ssIncomingAnim = -1;    // Animation being wiped in, -1 when no transition is running
uint32_t s_ssTransitionStart = 0;
uint32_t s_ssSessionStart = 0;   // Detects a fresh screensaver session so it starts without a wipe
uint8_t s_ssScratch[SCREEN_WIDTH * SCREEN_HEIGHT / 8];

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
    s_display.ssd1306_command(0xFF);                     // Max brightness
    s_display.ssd1306_command(SSD1306_SETPRECHARGE);     // 0xD9
    s_display.ssd1306_command(0xF1);
    s_display.ssd1306_command(SSD1306_SETVCOMDETECT);    // 0xDB
    s_display.ssd1306_command(0x40);
}

bool initDisplayHardware() {
    if (!s_display.begin(SSD1306_SWITCHCAPVCC, 0x3C, false, false)) {
        return false;
    }
    configure128x64Hardware();
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

    uint8_t curLayer = configGet().activeLayer;
    s_display.setCursor(54, 27);
    if (curLayer == 0) s_display.print("L0:NUM");
    else if (curLayer == 1) s_display.print("L1:NAV");
    else s_display.print("L2:GAME");

    const char* rtModeStr = HallKey::isRapidTrigger() ? "RAPID" : "NORM";
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
    s_display.print(HallKey::getActuationPoint(), 1);

    s_display.setCursor(47, 38);
    if (s_currentMenu == MenuMode::ADJUST_RT) s_display.print(">");
    else s_display.print(" ");
    s_display.print("RT:");
    s_display.print(HallKey::getRtSensitivity(), 2);

    // Line 2: Mode Toggle & Layer Select
    s_display.setCursor(2, 46);
    if (s_currentMenu == MenuMode::TOGGLE_RT) s_display.print(">");
    else s_display.print(" ");
    s_display.print(HallKey::isRapidTrigger() ? "RT:ON" : "RT:OFF");

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

            if (HallManager::getKey(keyIdx).isPressed()) {
                s_display.fillRect(bx, by, BOX_W, BOX_H, OLED_COLOR_WHITE);
            } else {
                s_display.drawRect(bx, by, BOX_W, BOX_H, OLED_COLOR_WHITE);
            }
        }
    }

    // 4. Horizontal Separator (Y: 51)
    s_display.drawFastHLine(0, 51, 128, OLED_COLOR_WHITE);

    // 5. Live Analog Depth Gauge (Bottom, Y: 53..63)
    int8_t lastKey = HallManager::getLastActiveKey();
    s_display.setCursor(3, 53);
    if (lastKey >= 0 && lastKey < NUM_KEYS) {
        HallKey& k = HallManager::getKey((uint8_t)lastKey);
        s_display.print(k.getLabel());
        s_display.print(":");
        s_display.print(displayTravelMm((uint8_t)lastKey, k.getTravelMm()), 1);
        s_display.print("mm");

        int16_t barW = (int16_t)((k.getTravelMm() / 4.0f) * 122.0f);
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

    mutex_enter_blocking(&s_wireMutex);
    s_display.display();
    mutex_exit(&s_wireMutex);
}

const char* const MENU_TITLES[] = {"RT SENSITIVITY", "ACTUATION POINT", "RAPID TRIGGER", "ACTIVE LAYER"};

// Size-2 value and size-1 unit sharing a baseline, centered as one group
void drawValueWithUnit(const char* value, const char* unit, int16_t y) {
    int16_t valueW = textWidth(value, 2);
    int16_t x = 64 - (valueW + 3 + textWidth(unit)) / 2;
    s_display.setTextSize(2);
    s_display.setCursor(x, y);
    s_display.print(value);
    s_display.setTextSize(1);
    s_display.setCursor(x + valueW + 3, y + 7);
    s_display.print(unit);
}

// Slider track (X: 10..117, Y: 46..50) with detent ticks under it and a knob on the fill edge
void drawMenuSlider(float ratio, uint8_t steps) {
    constexpr int16_t X0 = 10;
    constexpr int16_t X1 = 117;
    constexpr int16_t Y = 46;
    if (ratio < 0.0f) ratio = 0.0f;
    if (ratio > 1.0f) ratio = 1.0f;

    s_display.drawRoundRect(X0, Y, X1 - X0 + 1, 5, 2, OLED_COLOR_WHITE);
    int16_t fillX = X0 + (int16_t)(ratio * (X1 - X0) + 0.5f);
    if (fillX > X0 + 1) {
        s_display.fillRoundRect(X0, Y, fillX - X0 + 1, 5, 2, OLED_COLOR_WHITE);
    }
    for (uint8_t t = 0; t <= steps; ++t) {
        s_display.drawPixel(X0 + (X1 - X0) * t / steps, 53, OLED_COLOR_WHITE);
    }

    int16_t knobX = fillX - 2;
    if (knobX < X0) knobX = X0;
    if (knobX > X1 - 4) knobX = X1 - 4;
    s_display.fillRect(knobX, Y - 2, 5, 9, OLED_COLOR_BLACK);
    s_display.drawRoundRect(knobX, Y - 2, 5, 9, 1, OLED_COLOR_WHITE);
    s_display.drawFastVLine(knobX + 2, Y, 5, OLED_COLOR_WHITE);
}

// 24x11 pill switch, knob right and track filled when on
void drawToggle(bool on, int16_t x, int16_t y) {
    s_display.drawRoundRect(x, y, 24, 11, 5, OLED_COLOR_WHITE);
    if (on) {
        s_display.fillRoundRect(x + 2, y + 2, 20, 7, 3, OLED_COLOR_WHITE);
        s_display.fillCircle(x + 17, y + 5, 3, OLED_COLOR_BLACK);
        s_display.drawCircle(x + 17, y + 5, 3, OLED_COLOR_WHITE);
    } else {
        s_display.drawCircle(x + 6, y + 5, 3, OLED_COLOR_WHITE);
    }
}

void renderMenuOverlay() {
    s_display.clearDisplay();

    uint8_t page = static_cast<uint8_t>(s_currentMenu);
    char pillBuf[8];
    snprintf(pillBuf, sizeof(pillBuf), "%u/%u", page + 1, static_cast<uint8_t>(MenuMode::COUNT));
    drawHeader("TUNING MENU", pillBuf);
    s_display.drawFastHLine(0, 11, 128, OLED_COLOR_WHITE);
    drawCornerBrackets();

    s_display.setTextColor(OLED_COLOR_WHITE);
    if (page < static_cast<uint8_t>(MenuMode::COUNT)) {
        printCentered(MENU_TITLES[page], 64, 15);
    }

    switch (s_currentMenu) {
        case MenuMode::ADJUST_RT: {
            drawValueWithUnit(String(HallKey::getRtSensitivity(), 2).c_str(), "mm", 26);
            drawMenuSlider((HallKey::getRtSensitivity() - HallKey::RT_SENS_MIN_MM) /
                           (HallKey::RT_SENS_MAX_MM - HallKey::RT_SENS_MIN_MM), 4);
            break;
        }
        case MenuMode::ADJUST_ACTUATION: {
            // Encoder range is 0.3mm to 3.6mm
            drawValueWithUnit(String(HallKey::getActuationPoint(), 1).c_str(), "mm", 26);
            drawMenuSlider((HallKey::getActuationPoint() - 0.3f) / (3.6f - 0.3f), 4);
            break;
        }
        case MenuMode::TOGGLE_RT: {
            bool on = HallKey::isRapidTrigger();
            const char* state = on ? "ON" : "OFF";
            int16_t x = 64 - (textWidth(state, 2) + 6 + 24) / 2;
            s_display.setTextSize(2);
            s_display.setCursor(x, 27);
            s_display.print(state);
            drawToggle(on, x + textWidth(state, 2) + 6, 29);
            printCentered(on ? "Re-arms on lift" : "Fixed actuation", 64, 47);
            break;
        }
        case MenuMode::CYCLE_LAYER: {
            uint8_t cur = configGet().activeLayer;
            printCentered(layerName(cur), 64, 26, 2);

            // Layer chips: the active one is inverted
            char chip[3];
            for (uint8_t i = 0; i < NUM_LAYERS; ++i) {
                int16_t bx = 64 - (NUM_LAYERS * 20 - 2) / 2 + i * 20;
                if (i == cur) {
                    s_display.fillRoundRect(bx, 44, 18, 10, 2, OLED_COLOR_WHITE);
                    s_display.setTextColor(OLED_COLOR_BLACK, OLED_COLOR_WHITE);
                } else {
                    s_display.drawRoundRect(bx, 44, 18, 10, 2, OLED_COLOR_WHITE);
                    s_display.setTextColor(OLED_COLOR_WHITE);
                }
                snprintf(chip, sizeof(chip), "L%u", i);
                printCentered(chip, bx + 9, 45);
            }
            s_display.setTextColor(OLED_COLOR_WHITE);
            break;
        }
        default:
            break;
    }

    // Auto-return countdown: a centered bar that shrinks toward the middle
    uint32_t elapsed = millis() - s_menuLastActive;
    if (elapsed < 2800) {
        int16_t remW = 108 - (int16_t)((elapsed / 2800.0f) * 108.0f);
        if (remW > 0) {
            s_display.drawFastHLine(64 - remW / 2, 62, remW, OLED_COLOR_WHITE);
        }
    }
}

// ---------------------------------------------------------------------------------------
// Main key screen. Left: the focused key (state label, key box, 0..4 mm travel scale and
// readout) or standby. Right: the 4x4 keypad map. Positions are fixed across states.
// ---------------------------------------------------------------------------------------
constexpr int16_t KEY_BOX_X = 1;
constexpr int16_t KEY_BOX_Y = 19;
constexpr int16_t KEY_BOX_W = 76;
constexpr int16_t KEY_BOX_H = 28;
constexpr int16_t SCALE_X = 1;
constexpr int16_t SCALE_W = 76;
constexpr int16_t SCALE_Y = 49;     // fill rows 49..51, leaving two clear rows under the key box
constexpr float SCALE_MAX_MM = 4.0f;  // full switch travel
constexpr int16_t MAP_X = 83;
constexpr int16_t MAP_Y = 9;
constexpr int16_t MAP_CELL = 9;
constexpr int16_t MAP_GAP = 3;

const char* const LAYER_TITLES[] = {"Numpad", "Nav", "Gaming"};

void printRight(const char* text, int16_t rightX, int16_t y) {
    s_display.setTextSize(1);
    s_display.setCursor(rightX - textWidth(text) + 1, y);
    s_display.print(text);
}

// Header: inverted layer chip, // motif, layer name (active screens only), RT setting
void drawKeyScreenHeader(uint8_t layer, bool showName) {
    char chip[4];
    snprintf(chip, sizeof(chip), "L%u", layer);
    int16_t chipW = textWidth(chip) + 4;
    s_display.fillRect(0, 0, chipW, 8, OLED_COLOR_WHITE);
    s_display.setTextSize(1);
    s_display.setTextColor(OLED_COLOR_BLACK, OLED_COLOR_WHITE);
    s_display.setCursor(2, 0);
    s_display.print(chip);
    s_display.setTextColor(OLED_COLOR_WHITE);
    for (int16_t i = 0; i < 2; ++i) {
        s_display.drawLine(chipW + 3 + i * 3, 7, chipW + 5 + i * 3, 1, OLED_COLOR_WHITE);
    }
    if (showName) {
        s_display.setCursor(chipW + 12, 0);
        s_display.print(layerName(layer));
    }
    if (HallKey::isRapidTrigger()) {
        printRight((String("RT ") + String(HallKey::getRtSensitivity(), 2) + "mm").c_str(), 127, 0);
    } else {
        printRight("RT OFF", 127, 0);
    }
}

// Key box: filled with a knocked-out label when actuated, outlined otherwise. The label
// uses the largest font that keeps comfortable side padding inside the fixed box.
void drawKeyBox(const char* label, bool actuated) {
    int16_t x1, y1;
    uint16_t w, h;
    s_display.setFont(&FreeSansBold18pt7b);
    s_display.getTextBounds(label, 0, 0, &x1, &y1, &w, &h);
    if (w > KEY_BOX_W - 16) {
        s_display.setFont(&FreeSansBold12pt7b);
        s_display.getTextBounds(label, 0, 0, &x1, &y1, &w, &h);
        if (w > KEY_BOX_W - 10) {
            s_display.setFont(&FreeSansBold9pt7b);
            s_display.getTextBounds(label, 0, 0, &x1, &y1, &w, &h);
        }
    }
    // Centre on the font's cap height so every label sits on the same line
    int16_t cx1, cy1;
    uint16_t cw, capH;
    s_display.getTextBounds("H", 0, 0, &cx1, &cy1, &cw, &capH);
    int16_t tx = KEY_BOX_X + (KEY_BOX_W - (int16_t)w + 1) / 2 - x1;
    int16_t ty = KEY_BOX_Y + (KEY_BOX_H - (int16_t)capH + 1) / 2 + (int16_t)capH;

    if (actuated) {
        s_display.fillRoundRect(KEY_BOX_X, KEY_BOX_Y, KEY_BOX_W, KEY_BOX_H, 3, OLED_COLOR_WHITE);
        s_display.setTextColor(OLED_COLOR_BLACK);
    } else {
        s_display.drawRoundRect(KEY_BOX_X, KEY_BOX_Y, KEY_BOX_W, KEY_BOX_H, 3, OLED_COLOR_WHITE);
        s_display.setTextColor(OLED_COLOR_WHITE);
    }
    s_display.setCursor(tx, ty);
    s_display.print(label);
    s_display.setFont(nullptr);
    s_display.setTextColor(OLED_COLOR_WHITE);
}

int16_t scaleX(float mm) {
    return SCALE_X + (int16_t)(mm / SCALE_MAX_MM * (SCALE_W - 1) + 0.5f);
}

// Fixed 0..4 mm scale: 1px track, 3px fill, mm ticks, and the configured initial actuation
// point as a line through the bar plus a pointer underneath
void drawTravelScale(float travelMm) {
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
    int16_t ax = scaleX(HallKey::getActuationPoint());
    bool filledPast = travelMm > 0.0f && ax <= fillX;
    s_display.drawFastVLine(ax, SCALE_Y, 4, filledPast ? OLED_COLOR_BLACK : OLED_COLOR_WHITE);
    s_display.drawPixel(ax, SCALE_Y + 4, OLED_COLOR_WHITE);
    s_display.drawFastHLine(ax - 1, SCALE_Y + 5, 3, OLED_COLOR_WHITE);
    s_display.drawFastHLine(ax - 2, SCALE_Y + 6, 5, OLED_COLOR_WHITE);

    s_display.setTextSize(1);
    s_display.setCursor(SCALE_X, 57);
    s_display.print("0");
}

// Keypad map. Resting: outline. Travelling: outline with an inner level that keeps a dark
// ring. Actuated: solid. Focus is marked by row and column pointers outside the grid, so
// neighbouring actuated keys can never make it ambiguous.
void drawKeypadMap(const bool actuated[NUM_KEYS], int8_t focus) {
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        int16_t x = MAP_X + (i % 4) * (MAP_CELL + MAP_GAP);
        int16_t y = MAP_Y + (i / 4) * (MAP_CELL + MAP_GAP);
        if (actuated[i]) {
            s_display.fillRect(x, y, MAP_CELL, MAP_CELL, OLED_COLOR_WHITE);
            continue;
        }
        s_display.drawRect(x, y, MAP_CELL, MAP_CELL, OLED_COLOR_WHITE);
        float mm = HallManager::getKey(i).getTravelMm();
        if (mm >= FOCUS_REST_MM) {
            int16_t rows = (int16_t)(mm / SCALE_MAX_MM * 5.0f + 0.5f);
            if (rows < 1) rows = 1;
            if (rows > 5) rows = 5;
            s_display.fillRect(x + 2, y + MAP_CELL - 2 - rows, MAP_CELL - 4, rows, OLED_COLOR_WHITE);
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

void renderFullScreen() {
    // If the rotary encoder was clicked or turned in the last 2.8s, show focused tuning card
    if ((millis() - s_menuLastActive) < 2800) {
        renderMenuOverlay();
        discardGridLatches();
        mutex_enter_blocking(&s_wireMutex);
        s_display.display();
        mutex_exit(&s_wireMutex);
        return;
    }

    if (!s_gridCountersSynced) {
        discardGridLatches();
        s_gridCountersSynced = true;
    }

    selectDisplayFocus(millis());
    int8_t focus = s_focusKey;

    // Focused key state, from the same latches as the map (read before the map consumes them).
    // A release and re-press inside one frame shows one un-actuated frame so RT resets stay visible.
    bool focusActuated = false;
    if (focus >= 0) {
        HallKey& k = HallManager::getKey((uint8_t)focus);
        bool pressChanged = k.getPressCount() != s_lastPressCount[(uint8_t)focus];
        bool releaseChanged = k.getReleaseCount() != s_lastReleaseCount[(uint8_t)focus];
        focusActuated = (k.isPressed() || pressChanged) && !(k.isPressed() && releaseChanged);
    }

    // Keypad map state per key, then consume the latches
    bool actuated[NUM_KEYS];
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        HallKey& k = HallManager::getKey(i);
        uint8_t curPress = k.getPressCount();
        uint8_t curRelease = k.getReleaseCount();
        bool pressChanged = (curPress != s_lastPressCount[i]);
        bool releaseChanged = (curRelease != s_lastReleaseCount[i]);
        if (k.isPressed() && releaseChanged) {
            actuated[i] = false;   // RT re-press within one frame: show the reset
        } else {
            actuated[i] = k.isPressed() || pressChanged;   // held, or a tap finished between frames
        }
        s_lastPressCount[i] = curPress;
        s_lastReleaseCount[i] = curRelease;
    }

    s_display.clearDisplay();
    s_display.setTextColor(OLED_COLOR_WHITE);
    uint8_t layer = configGet().activeLayer;
    drawKeyScreenHeader(layer, focus >= 0);

    if (focus >= 0) {
        HallKey& k = HallManager::getKey((uint8_t)focus);
        if (focusActuated) {
            s_display.fillRect(1, 9, textWidth("ACTUATED") + 4, 9, OLED_COLOR_WHITE);
            s_display.setTextColor(OLED_COLOR_BLACK, OLED_COLOR_WHITE);
            s_display.setCursor(3, 10);
            s_display.print("ACTUATED");
            s_display.setTextColor(OLED_COLOR_WHITE);
        } else {
            s_display.setCursor(3, 10);
            s_display.print("TRAVEL");
        }
        drawKeyBox(k.getLabel(), focusActuated);
        drawTravelScale(k.getTravelMm());
        printRight((String(displayTravelMm((uint8_t)focus, k.getTravelMm()), 1) + "mm").c_str(),
                   KEY_BOX_X + KEY_BOX_W - 1, 57);
    } else {
        s_display.setCursor(3, 10);
        s_display.print("READY");

        const char* title = layer < 3 ? LAYER_TITLES[layer] : "?";
        int16_t x1, y1;
        uint16_t w, h;
        s_display.setFont(&FreeSansBold9pt7b);
        s_display.getTextBounds(title, 0, 0, &x1, &y1, &w, &h);
        s_display.setCursor(KEY_BOX_X - x1, 33);
        s_display.print(title);
        s_display.setFont(nullptr);

        s_display.setCursor(1, 38);
        s_display.print("ACT");
        printRight((String(HallKey::getActuationPoint(), 1) + "mm").c_str(), KEY_BOX_X + KEY_BOX_W - 1, 38);
        drawTravelScale(0.0f);
        printRight("4mm", KEY_BOX_X + KEY_BOX_W - 1, 57);
    }

    drawKeypadMap(actuated, focus);

    mutex_enter_blocking(&s_wireMutex);
    s_display.display();
    mutex_exit(&s_wireMutex);
}

void updateFloatingBadge(const char* text) {
    const int16_t w = (int16_t)strlen(text) * 6 + 8;
    const int16_t h = 14;
    s_badgeX += s_badgeDX;
    s_badgeY += s_badgeDY;
    if (s_badgeX <= 1) { s_badgeX = 1; s_badgeDX = 1; }
    if (s_badgeX + w >= 127) { s_badgeX = 127 - w; s_badgeDX = -1; }
    if (s_badgeY <= 1) { s_badgeY = 1; s_badgeDY = 1; }
    if (s_badgeY + h >= 63) { s_badgeY = 63 - h; s_badgeDY = -1; }

    // Clear area behind badge and draw framing card with rounded corners
    s_display.fillRect(s_badgeX - 1, s_badgeY - 1, w + 2, h + 2, OLED_COLOR_BLACK);
    s_display.drawRoundRect(s_badgeX - 1, s_badgeY - 1, w + 2, h + 2, 2, OLED_COLOR_WHITE);
    s_display.setTextColor(OLED_COLOR_WHITE);
    s_display.setTextSize(1);
    s_display.setCursor(s_badgeX + 4, s_badgeY + (h - 8) / 2);
    s_display.print(text);
}

// Animation 0: 3D Warp Starfield & Floating DRIFTPAD Badge
void renderAnimStarfield() {
    if (!s_starsInit) {
        initStarfield();
    }

    for (uint8_t i = 0; i < NUM_STARS; ++i) {
        s_stars[i].z -= 2;
        if (s_stars[i].z <= 2) {
            s_stars[i].x = (rand() % 240) - 120;
            s_stars[i].y = (rand() % 120) - 60;
            s_stars[i].z = 90;
            s_stars[i].prev_x = -1;
            s_stars[i].prev_y = -1;
        }

        // Project 3D (x, y, z) to 2D screen center (64, 32)
        int16_t sx = 64 + (s_stars[i].x * 45) / s_stars[i].z;
        int16_t sy = 32 + (s_stars[i].y * 45) / s_stars[i].z;

        if (sx >= 0 && sx < 128 && sy >= 0 && sy < 64) {
            s_display.drawPixel(sx, sy, OLED_COLOR_WHITE);
            // Draw streak tail for fast stars close to viewer
            if (s_stars[i].z < 35 && s_stars[i].prev_x >= 0) {
                s_display.drawLine(s_stars[i].prev_x, s_stars[i].prev_y, sx, sy, OLED_COLOR_WHITE);
            }
            s_stars[i].prev_x = sx;
            s_stars[i].prev_y = sy;
        } else {
            // Out of bounds, reset star
            s_stars[i].x = (rand() % 240) - 120;
            s_stars[i].y = (rand() % 120) - 60;
            s_stars[i].z = 90;
            s_stars[i].prev_x = -1;
            s_stars[i].prev_y = -1;
        }
    }
}

// Animation 1: Digital Cyber Rain & Floating CYBER RT Badge
void renderAnimMatrixRain() {
    if (!s_rainInit) {
        initRain();
    }

    for (uint8_t c = 0; c < RAIN_COLS; ++c) {
        int16_t x = c * 8 + 3;
        s_rain[c].y += s_rain[c].speed;

        if (s_rain[c].y - s_rain[c].length > 64) {
            s_rain[c].y = -(rand() % 16);
            s_rain[c].speed = (rand() % 2) + 1;
            s_rain[c].length = (rand() % 8) + 6;
        }

        int16_t headY = s_rain[c].y;
        if (headY >= 0 && headY < 64) {
            s_display.drawPixel(x, headY, OLED_COLOR_WHITE);
            if (headY > 0) {
                s_display.drawPixel(x, headY - 1, OLED_COLOR_WHITE);
            }
        }

        // Draw sparse falling tail dots (< 2% duty cycle)
        for (uint8_t k = 2; k < s_rain[c].length; k += 2) {
            int16_t ty = headY - k;
            if (ty >= 0 && ty < 64) {
                s_display.drawPixel(x, ty, OLED_COLOR_WHITE);
            }
        }
    }
}

// Animation 2: Dual Harmonic Oscilloscope Flux Wave & Floating HALL FLUX Badge
void renderAnimOscilloscope() {
    s_wavePhase += 0.08f;
    if (s_wavePhase > 62.8318f) {
        s_wavePhase -= 62.8318f;
    }

    // Two interlaced harmonic flux waveforms
    for (int16_t x = 0; x < 128; x += 2) {
        float fx = (float)x * 0.065f;
        // Primary analog wave
        int16_t y1 = 32 + (int16_t)(sinf(fx + s_wavePhase) * 14.0f + sinf(fx * 0.45f - s_wavePhase * 0.7f) * 7.0f);
        if (y1 >= 0 && y1 < 64) {
            s_display.drawPixel(x, y1, OLED_COLOR_WHITE);
        }
        // Secondary harmonic wave
        int16_t y2 = 32 + (int16_t)(cosf(fx * 0.85f - s_wavePhase * 1.3f) * 11.0f);
        if (y2 >= 0 && y2 < 64) {
            s_display.drawPixel(x + 1, y2, OLED_COLOR_WHITE);
        }
    }
}

// Animation 3: Synthwave Horizon Grid & Floating DRIFT GRID Badge
void renderAnimSynthGrid() {
    constexpr int16_t HORIZON = 30;
    constexpr int16_t SUN_R = 15;

    s_gridFrame++;
    s_gridScroll += 0.06f;
    if (s_gridScroll >= 1.0f) {
        s_gridScroll -= 1.0f;
    }

    // Twinkling sky stars (fixed positions, each blinks on its own beat)
    static const uint8_t kSky[][2] = {
        {6, 4}, {19, 11}, {31, 3}, {44, 17}, {88, 5}, {97, 14},
        {109, 3}, {121, 10}, {13, 22}, {115, 21}, {76, 2}, {52, 7}
    };
    for (uint8_t i = 0; i < sizeof(kSky) / sizeof(kSky[0]); ++i) {
        if (((s_gridFrame + i * 11) % 48) > 3) {
            s_display.drawPixel(kSky[i][0], kSky[i][1], OLED_COLOR_WHITE);
        }
    }

    // Setting sun: upper half disc with slits that scroll down and widen toward the horizon
    uint8_t slitOffset = (s_gridFrame / 4) % 4;
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

    s_display.drawFastHLine(0, HORIZON, 128, OLED_COLOR_WHITE);

    // Floor rails converging on the vanishing point
    for (int8_t i = -6; i <= 6; ++i) {
        s_display.drawLine(64 + i * 4, HORIZON + 1, 64 + i * 24, 63, OLED_COLOR_WHITE);
    }

    // Cross ties rushing toward the viewer (perspective y = horizon + k / depth)
    for (uint8_t k = 0; k < 9; ++k) {
        float depth = (float)k + 1.0f - s_gridScroll;
        if (depth < 0.5f) continue;
        int16_t y = HORIZON + (int16_t)(33.0f / depth);
        if (y > HORIZON + 1 && y < 64) {
            s_display.drawFastHLine(0, y, 128, OLED_COLOR_WHITE);
        }
    }
}

void spawnRipple(Ripple& rp) {
    rp.x = rand() % 128;
    rp.y = rand() % 64;
    rp.r = -(rand() % 24);          // Staggered start so rings don't pulse in lockstep
    rp.maxR = 22 + (rand() % 26);
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
void renderAnimRipples() {
    if (!s_ripplesInit) {
        for (uint8_t i = 0; i < NUM_RIPPLES; ++i) {
            spawnRipple(s_ripples[i]);
        }
        s_ripplesInit = true;
    }

    for (uint8_t i = 0; i < NUM_RIPPLES; ++i) {
        Ripple& rp = s_ripples[i];
        rp.r++;
        if (rp.r > rp.maxR) {
            spawnRipple(rp);
            continue;
        }
        if (rp.r <= 0) continue;

        // Impact flash, then an outer wavefront trailed by a weaker echo ring
        if (rp.r <= 2) {
            s_display.fillCircle(rp.x, rp.y, 3 - rp.r, OLED_COLOR_WHITE);
        }
        uint8_t skip = 0;
        if (rp.r > rp.maxR * 3 / 4) {
            skip = 3;
        } else if (rp.r > rp.maxR / 2) {
            skip = 2;
        }
        drawRippleRing(rp.x, rp.y, rp.r, skip);
        if (rp.r > 7) {
            drawRippleRing(rp.x, rp.y, rp.r - 7, skip + 2);
        }
    }
}

// Animation 5: Lava Lamp & Floating LAVA LAMP Badge
// Blobs drift up and down on slow, unrelated sine periods so they merge and pinch apart.
// Each blob gets a 1 px rim plus Bayer-dithered shading that thickens toward its core.
void renderAnimLava() {
    struct Blob {
        uint8_t cx, swingX;
        float speedX, speedY, phase;
        uint8_t radius;
    };
    static const Blob kBlobs[LAVA_BLOBS] = {
        {30, 10, 0.21f, 0.31f, 0.0f, 13},
        {64, 14, 0.17f, 0.23f, 2.1f, 11},
        {96,  9, 0.26f, 0.37f, 4.0f, 12},
        {48, 12, 0.29f, 0.19f, 1.3f,  9},
        {84, 11, 0.15f, 0.27f, 5.2f, 10},
    };
    static const uint8_t kBayer4[4][4] = {
        { 0,  8,  2, 10},
        {12,  4, 14,  6},
        { 3, 11,  1,  9},
        {15,  7, 13,  5},
    };
    constexpr uint16_t EDGE = 256;   // Field value on a lone blob's radius
    constexpr uint16_t CORE = 360;   // Shading starts here, leaving a dark gap inside the rim
    constexpr uint16_t FIELD_MAX = 2048;

    s_lavaTime += RENDER_INTERVAL_MS / 1000.0f;
    if (s_lavaTime > 1000.0f) {
        s_lavaTime -= 1000.0f;
    }

    int16_t bx[LAVA_BLOBS], by[LAVA_BLOBS];
    int32_t strength[LAVA_BLOBS];
    for (uint8_t k = 0; k < LAVA_BLOBS; ++k) {
        const Blob& b = kBlobs[k];
        bx[k] = (int16_t)(b.cx + b.swingX * sinf(s_lavaTime * b.speedX + b.phase));
        by[k] = (int16_t)(32.0f + 34.0f * sinf(s_lavaTime * b.speedY + b.phase * 1.7f));
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
            if (on) {
                buf[x + (y >> 3) * SCREEN_WIDTH] |= 1 << (y & 7);
            }
        }
    }
}

struct ScreensaverAnim {
    void (*render)();
    const char* label;
};

const ScreensaverAnim kScreensaverAnims[NUM_SCREENSAVER_ANIMS] = {
    {renderAnimStarfield,    "DRIFTPAD"},
    {renderAnimMatrixRain,   "CYBER RT"},
    {renderAnimOscilloscope, "HALL FLUX"},
    {renderAnimSynthGrid,    "DRIFT GRID"},
    {renderAnimRipples,      "MAG PULSE"},
    {renderAnimLava,         "LAVA LAMP"},
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

    uint32_t now = millis();
    uint32_t sessionStart = s_screensaverStartTime;
    int8_t forced = s_forcedAnim;
    int8_t target;
    if (forced >= 0 && forced < NUM_SCREENSAVER_ANIMS) {
        target = forced;
    } else {
        // Cycle through all animations every SCREENSAVER_ANIM_CYCLE_MS (20s)
        target = ((now - sessionStart) / SCREENSAVER_ANIM_CYCLE_MS) % NUM_SCREENSAVER_ANIMS;
    }

    if (s_ssShownAnim < 0 || s_ssSessionStart != sessionStart) {
        // Fresh screensaver session: show the target immediately, no wipe
        s_ssSessionStart = sessionStart;
        s_ssShownAnim = target;
        s_ssIncomingAnim = -1;
    } else if (s_ssIncomingAnim < 0 && target != s_ssShownAnim) {
        s_ssIncomingAnim = target;
        s_ssTransitionStart = now;
    }

    uint32_t elapsed = now - s_ssTransitionStart;
    if (s_ssIncomingAnim >= 0 && elapsed >= SCREENSAVER_TRANSITION_MS) {
        s_ssShownAnim = s_ssIncomingAnim;
        s_ssIncomingAnim = -1;
    }

    const char* badge = kScreensaverAnims[s_ssShownAnim].label;
    s_display.clearDisplay();

    if (s_ssIncomingAnim < 0) {
        kScreensaverAnims[s_ssShownAnim].render();
    } else {
        // Both animations keep moving during the wipe: render incoming, stash it, render outgoing, blend
        uint8_t* buf = s_display.getBuffer();
        kScreensaverAnims[s_ssIncomingAnim].render();
        memcpy(s_ssScratch, buf, sizeof(s_ssScratch));
        s_display.clearDisplay();
        kScreensaverAnims[s_ssShownAnim].render();

        int16_t front = (int16_t)((elapsed * 256UL) / SCREENSAVER_TRANSITION_MS);
        blendWipe(buf, s_ssScratch, front);
        if (front >= 128) {
            badge = kScreensaverAnims[s_ssIncomingAnim].label;
        }
    }

    updateFloatingBadge(badge);

    mutex_enter_blocking(&s_wireMutex);
    s_display.display();
    mutex_exit(&s_wireMutex);
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

} // namespace

void oledInit() {
    // 1. Hardware I2C Bus Recovery / Clear Sequence (NXP I2C Bus Specification UM10204):
    // If a previous crash left SDA held low by the display controller,
    // pulse SCL 9 times to force the slave to release the SDA line, then issue STOP.
    pinMode(OLED_SDA_PIN, INPUT_PULLUP);
    pinMode(OLED_SCL_PIN, OUTPUT);
    for (int i = 0; i < 9; i++) {
        digitalWrite(OLED_SCL_PIN, HIGH);
        delayMicroseconds(10);
        digitalWrite(OLED_SCL_PIN, LOW);
        delayMicroseconds(10);
    }
    // Generate I2C STOP condition
    pinMode(OLED_SDA_PIN, OUTPUT);
    digitalWrite(OLED_SDA_PIN, LOW);
    delayMicroseconds(10);
    digitalWrite(OLED_SCL_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(OLED_SDA_PIN, HIGH);
    delayMicroseconds(10);

    // 2. Initialize hardware I2C peripheral
    pinMode(OLED_SDA_PIN, INPUT_PULLUP);
    pinMode(OLED_SCL_PIN, INPUT_PULLUP);
    gpio_pull_up(OLED_SDA_PIN);
    gpio_pull_up(OLED_SCL_PIN);

    Wire.setSDA(OLED_SDA_PIN);
    Wire.setSCL(OLED_SCL_PIN);
    Wire.begin();
    Wire.setClock(100000); // 100kHz standard mode for robust signal integrity
    Wire.setTimeout(50, true);

    delay(100);

    Serial.println(F("[OLED] Scanning I2C bus on GP0 (SDA) / GP1 (SCL)..."));
    uint8_t count = 0;
    for (uint8_t addr = 1; addr < 127; addr++) {
        Wire.beginTransmission(addr);
        uint8_t err = Wire.endTransmission();
        if (err == 0) {
            Serial.printf("[OLED] I2C ACK received from device at address 0x%02X\n", addr);
            count++;
        }
    }
    if (count == 0) {
        Serial.println(F("[OLED] WARNING: No I2C devices ACKed on GP0/GP1!"));
    }

    bool ok = initDisplayHardware();
    Serial.printf("[OLED] initDisplayHardware: %s\n", ok ? "SUCCESS" : "FAILED");

    if (ok) {
        s_display.clearDisplay();
        s_display.setTextColor(OLED_COLOR_WHITE);

        if (s_fullScreenMode) {
            s_display.drawRect(0, 0, 128, 64, OLED_COLOR_WHITE);
            s_display.setTextSize(2);
            s_display.setCursor(16, 8);
            s_display.println("DRIFTPAD");
            s_display.setTextSize(1);
            s_display.setCursor(20, 28);
            s_display.println("Rapid Trigger");
            s_display.setCursor(14, 40);
            s_display.println("128x64 OLED Mode");
            s_display.setCursor(18, 52);
            s_display.println("USB Connected");
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

        mutex_enter_blocking(&s_wireMutex);
        s_display.display();
        mutex_exit(&s_wireMutex);

        s_lastRenderTime = millis();
        s_initialized = true;
    }
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
        oledWake();
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

    uint8_t next = (static_cast<uint8_t>(s_currentMenu) + 1) % static_cast<uint8_t>(MenuMode::COUNT);
    s_currentMenu = static_cast<MenuMode>(next);
    s_menuLastActive = millis();
    s_lastActivityTime = millis();
    s_forceRender = true;
}

bool oledAdjustCurrentSetting(int32_t delta) {
    if (delta == 0) return false;
    if (consumeEncoderWake()) return false;

    s_menuLastActive = millis();
    s_lastActivityTime = millis();

    DeviceSettings& cfg = configGet();

    switch (s_currentMenu) {
        case MenuMode::ADJUST_RT: {
            float val = HallKey::getRtSensitivity() + (delta * 0.05f);
            HallKey::setRtSensitivity(val);
            cfg.rtSensMm = HallKey::getRtSensitivity();
            break;
        }
        case MenuMode::ADJUST_ACTUATION: {
            float val = HallKey::getActuationPoint() + (delta * 0.10f);
            if (val < 0.3f) val = 0.3f;
            if (val > 3.6f) val = 3.6f;
            HallKey::setActuationPoint(val);
            cfg.actuationMm = val;
            break;
        }
        case MenuMode::TOGGLE_RT: {
            bool nextState = !HallKey::isRapidTrigger();
            HallKey::setRapidTrigger(nextState);
            cfg.rtEnabled = nextState;
            break;
        }
        case MenuMode::CYCLE_LAYER: {
            int8_t l = (int8_t)cfg.activeLayer + (delta > 0 ? 1 : -1);
            if (l < 0) l = NUM_LAYERS - 1;
            if (l >= NUM_LAYERS) l = 0;
            cfg.activeLayer = (uint8_t)l;
            configApplyToHardware();
            break;
        }
        default:
            s_forceRender = true;
            return false;
    }
    s_forceRender = true;
    return true;
}

void oledUpdate(bool force) {
    if (force) {
        s_forceRender = true;
    }

    // When Core 1 is active, display refresh runs asynchronously in loop1()
    // so Core 0's 1000Hz ADC scanning loop is never blocked or starved.
    if (!s_core1Running) {
        uint32_t now = millis();

        if (!s_initialized) {
            if (initDisplayHardware()) {
                s_initialized = true;
                force = true;
            } else {
                return;
            }
        }

        if (!force && (now - s_lastRenderTime) < RENDER_INTERVAL_MS) {
            return;
        }
        s_lastRenderTime = now;
        renderScreen();
    }
}

// RP2040 Core 1 Multicore Execution:
// Dedicates Core 1 to asynchronous OLED I2C rendering.
// This completely offloads the ~23ms I2C display transfer from Core 0.
void setup1() {
    s_core1Running = true;
}

// A key counts as activity when it is pressed or has moved since the last check. A key
// parked at a small resting offset is not activity, otherwise it would hold the display
// awake forever and the screensaver and sleep timeouts would never run.
constexpr float ACTIVITY_MOVE_MM = 0.15f;
float s_activityRefTravel[NUM_KEYS] = {0};

bool keysShowActivity() {
    bool active = false;
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        HallKey& k = HallManager::getKey(i);
        float mm = k.getTravelMm();
        if (fabsf(mm - s_activityRefTravel[i]) > ACTIVITY_MOVE_MM) {
            s_activityRefTravel[i] = mm;
            active = true;
        }
        if (k.isPressed()) {
            active = true;
        }
    }
    return active;
}

void loop1() {
    s_core1Running = true;

    if (!s_initialized) {
        delay(10);
        return;
    }

    uint32_t now = millis();

    // Check activity for auto-wake / auto-screensaver (45s idle) / auto-sleep (1 hour idle)
    if (keysShowActivity()) {
        oledWake();
    } else {
        uint32_t idleMs = now - s_lastActivityTime;
        if (idleMs >= DISPLAY_SLEEP_TIMEOUT_MS) {
            if (!s_displaySleeping) {
                oledSleep();
            }
            delay(100);
            return;
        } else if (!s_screensaverActive && (idleMs >= SCREENSAVER_TIMEOUT_MS)) {
            s_screensaverActive = true;
            s_screensaverStartTime = now;
        }
    }

    if (s_displaySleeping) {
        delay(100);
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

void oledTestPattern() {
    Serial.println(F("[OLED] Running direct test pattern from Core 0..."));
    mutex_enter_blocking(&s_wireMutex);
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
    mutex_exit(&s_wireMutex);
    Serial.println(F("[OLED] Test pattern pushed to display!"));
}

void oledScanBus() {
    mutex_enter_blocking(&s_wireMutex);
    Serial.println(F("[I2C] Scanning I2C bus on GP0 (SDA) / GP1 (SCL)..."));
    uint8_t count = 0;
    for (uint8_t addr = 1; addr < 127; addr++) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) {
            Serial.printf("[I2C] Found device at address 0x%02X\n", addr);
            count++;
        }
    }
    Serial.printf("[I2C] Scan complete: %d device(s) found.\n", count);
    mutex_exit(&s_wireMutex);
}

void oledSetFullScreen(bool enabled) {
    s_fullScreenMode = enabled;
    s_forceRender = true;
}

bool oledIsFullScreen() {
    return s_fullScreenMode;
}

void oledSleep() {
    s_displaySleeping = true;
    s_screensaverActive = false;
    mutex_enter_blocking(&s_wireMutex);
    s_display.clearDisplay();
    s_display.display();
    s_display.ssd1306_command(SSD1306_DISPLAYOFF);
    mutex_exit(&s_wireMutex);
}

bool oledIsSleeping() {
    return s_displaySleeping;
}

void oledWake() {
    s_lastActivityTime = millis();
    if (s_displaySleeping) {
        mutex_enter_blocking(&s_wireMutex);
        s_display.ssd1306_command(SSD1306_DISPLAYON);
        mutex_exit(&s_wireMutex);
        s_displaySleeping = false;
    }
    if (s_screensaverActive) {
        s_screensaverActive = false;
    }
    if (s_isDimmed) {
        mutex_enter_blocking(&s_wireMutex);
        s_display.dim(false);
        mutex_exit(&s_wireMutex);
        s_isDimmed = false;
    }
    discardGridLatches();
    s_forceRender = true;
}

void oledTriggerScreensaver() {
    if (s_displaySleeping) {
        mutex_enter_blocking(&s_wireMutex);
        s_display.ssd1306_command(SSD1306_DISPLAYON);
        mutex_exit(&s_wireMutex);
        s_displaySleeping = false;
    }
    s_screensaverActive = true;
    s_screensaverStartTime = millis();
    s_lastActivityTime = millis();
    s_forceRender = true;
}

bool oledIsScreensaverActive() {
    return s_screensaverActive;
}

void oledSetScreensaverAnim(int8_t animIdx) {
    s_forcedAnim = animIdx;
    s_forceRender = true;
}
