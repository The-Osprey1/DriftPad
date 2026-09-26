#include "oled.h"
#include "pins.h"
#include "hall.h"
#include "config.h"

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>

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
constexpr uint32_t SCREENSAVER_ANIM_CYCLE_MS = 20000;   // 20s per animation cycle (0 -> 1 -> 2)
constexpr uint32_t DISPLAY_SLEEP_TIMEOUT_MS = 3600000UL; // 1 hour (3600s) -> turn display OFF
volatile uint32_t s_menuLastActive = 0;
volatile uint32_t s_lastActivityTime = 0;
volatile bool s_isDimmed = false;
auto_init_mutex(s_wireMutex);

// Core 1 local copies of edge counters for lock-free display rendering
static uint8_t s_lastPressCount[NUM_KEYS] = {0};
static uint8_t s_lastReleaseCount[NUM_KEYS] = {0};
static uint8_t s_overshootFrames[NUM_KEYS] = {0};
static bool s_gridCountersSynced = false;

// Discards stale latches/counts accumulated while non-grid screens were visible
void discardGridLatches() {
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        s_lastPressCount[i] = HallManager::getKey(i).getPressCount();
        s_lastReleaseCount[i] = HallManager::getKey(i).getReleaseCount();
        s_overshootFrames[i] = 0;
    }
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
        s_display.print(k.getTravelMm(), 2);
        s_display.print("mm");

        int16_t barW = (int16_t)((k.getTravelMm() / 4.0f) * 122.0f);
        if (barW < 0) barW = 0;
        if (barW > 122) barW = 122;
        s_display.drawRect(2, 59, 124, 4, OLED_COLOR_WHITE);
        if (barW > 0) {
            s_display.fillRect(2, 59, barW, 4, OLED_COLOR_WHITE);
        }
    } else {
        s_display.print("Ready | USB Connected");
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

void renderMenuOverlay() {
    s_display.clearDisplay();

    // 1. Motorsport Header Box (Y: 0..10)
    // Micro Checkered Flag (X: 0..7, Y: 1..8)
    for (int8_t r = 0; r < 4; ++r) {
        for (int8_t c = 0; c < 4; ++c) {
            if ((r + c) % 2 == 0) {
                s_display.fillRect(c * 2, 1 + r * 2, 2, 2, OLED_COLOR_WHITE);
            }
        }
    }

    // Inverted Drift Speed Banner (X: 9..83, Y: 0..10)
    s_display.fillRect(9, 0, 75, 10, OLED_COLOR_WHITE);
    s_display.setTextColor(OLED_COLOR_BLACK, OLED_COLOR_WHITE);
    s_display.setTextSize(1);
    s_display.setCursor(11, 1);
    s_display.print("/// DRIFTPAD // TUNE");

    // Speed line accents
    s_display.drawLine(86, 0, 81, 10, OLED_COLOR_WHITE);
    s_display.drawLine(90, 0, 85, 10, OLED_COLOR_WHITE);

    // Pill badge for MENU
    s_display.drawRoundRect(93, 0, 34, 11, 2, OLED_COLOR_WHITE);
    s_display.setTextColor(OLED_COLOR_WHITE);
    s_display.setCursor(97, 2);
    s_display.print("MENU");

    // Hairline divider with accent tick
    s_display.drawFastHLine(0, 11, 128, OLED_COLOR_WHITE);

    // Tactical Corner HUD Brackets
    s_display.drawFastHLine(0, 0, 8, OLED_COLOR_WHITE);
    s_display.drawFastVLine(0, 0, 6, OLED_COLOR_WHITE);
    s_display.drawFastHLine(119, 0, 9, OLED_COLOR_WHITE);
    s_display.drawFastVLine(127, 0, 6, OLED_COLOR_WHITE);
    s_display.drawFastHLine(0, 63, 8, OLED_COLOR_WHITE);
    s_display.drawFastVLine(0, 57, 7, OLED_COLOR_WHITE);
    s_display.drawFastHLine(119, 63, 9, OLED_COLOR_WHITE);
    s_display.drawFastVLine(127, 57, 7, OLED_COLOR_WHITE);

    s_display.setTextColor(OLED_COLOR_WHITE);

    switch (s_currentMenu) {
        case MenuMode::ADJUST_RT: {
            s_display.setCursor(8, 16);
            s_display.print("RAPID TRIGGER SENS");

            s_display.setTextSize(2);
            s_display.setCursor(20, 27);
            s_display.print(HallKey::getRtSensitivity(), 2);
            s_display.setTextSize(1);
            s_display.print(" mm");

            // Precision Slider Bar (RT_SENS_MIN_MM to RT_SENS_MAX_MM)
            s_display.drawRect(8, 44, 112, 7, OLED_COLOR_WHITE);
            // Calibration ticks along slider
            s_display.drawPixel(8 + 28, 42, OLED_COLOR_WHITE);
            s_display.drawPixel(8 + 56, 42, OLED_COLOR_WHITE);
            s_display.drawPixel(8 + 84, 42, OLED_COLOR_WHITE);

            float ratio = (HallKey::getRtSensitivity() - HallKey::RT_SENS_MIN_MM) /
                          (HallKey::RT_SENS_MAX_MM - HallKey::RT_SENS_MIN_MM);
            if (ratio < 0.0f) ratio = 0.0f;
            if (ratio > 1.0f) ratio = 1.0f;
            int16_t knobX = 8 + (int16_t)(ratio * 108.0f);
            s_display.fillRect(8, 44, (int16_t)(ratio * 112.0f), 7, OLED_COLOR_WHITE);
            s_display.fillRect(knobX, 42, 4, 11, OLED_COLOR_WHITE);
            break;
        }
        case MenuMode::ADJUST_ACTUATION: {
            s_display.setCursor(14, 16);
            s_display.print("ACTUATION POINT");

            s_display.setTextSize(2);
            s_display.setCursor(20, 27);
            s_display.print(HallKey::getActuationPoint(), 1);
            s_display.setTextSize(1);
            s_display.print(" mm");

            // Precision Slider Bar (0.3mm to 3.6mm)
            s_display.drawRect(8, 44, 112, 7, OLED_COLOR_WHITE);
            s_display.drawPixel(8 + 34, 42, OLED_COLOR_WHITE);
            s_display.drawPixel(8 + 68, 42, OLED_COLOR_WHITE);

            float ratio = (HallKey::getActuationPoint() - 0.3f) / (3.6f - 0.3f);
            if (ratio < 0.0f) ratio = 0.0f;
            if (ratio > 1.0f) ratio = 1.0f;
            int16_t knobX = 8 + (int16_t)(ratio * 108.0f);
            s_display.fillRect(8, 44, (int16_t)(ratio * 112.0f), 7, OLED_COLOR_WHITE);
            s_display.fillRect(knobX, 42, 4, 11, OLED_COLOR_WHITE);
            break;
        }
        case MenuMode::TOGGLE_RT: {
            s_display.setCursor(10, 16);
            s_display.print("RAPID TRIGGER MODE");

            s_display.setTextSize(2);
            s_display.setCursor(24, 27);
            s_display.print(HallKey::isRapidTrigger() ? "ACTIVE" : "OFF");

            s_display.setTextSize(1);
            s_display.setCursor(8, 46);
            if (HallKey::isRapidTrigger()) {
                s_display.print("Continuous Reversal ON");
            } else {
                s_display.print("Fixed Actuation Only");
            }
            break;
        }
        case MenuMode::CYCLE_LAYER: {
            s_display.setCursor(26, 16);
            s_display.print("ACTIVE LAYER");

            uint8_t cur = configGet().activeLayer;
            s_display.setTextSize(2);
            s_display.setCursor(16, 27);
            if (cur == 0) s_display.print("0: NUMPAD");
            else if (cur == 1) s_display.print("1: NAV");
            else s_display.print("2: GAMING");

            s_display.setTextSize(1);
            s_display.setCursor(14, 46);
            s_display.print("Flash Stored Map");
            break;
        }
        default:
            break;
    }

    // Auto-return timeout indicator bar at bottom
    uint32_t elapsed = millis() - s_menuLastActive;
    if (elapsed < 2800) {
        int16_t remW = 126 - (int16_t)((elapsed / 2800.0f) * 126.0f);
        if (remW > 0) {
            s_display.drawFastHLine(1, 62, remW, OLED_COLOR_WHITE);
        }
    }
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

    s_display.clearDisplay();

    // 1. Header: Motorsport Checkered Flag + DriftPad V2 Banner + Status Pill (Y: 0..10)
    // Micro Checkered Flag (X: 0..5, Y: 1..8) - 3 cols x 4 rows of 2x2 squares
    for (int8_t r = 0; r < 4; ++r) {
        for (int8_t c = 0; c < 3; ++c) {
            if ((r + c) % 2 == 0) {
                s_display.fillRect(c * 2, 1 + r * 2, 2, 2, OLED_COLOR_WHITE);
            }
        }
    }

    // Inverted Drift Speed Banner (X: 7..72, Y: 0..10) - 66 pixels wide
    s_display.fillRect(7, 0, 66, 10, OLED_COLOR_WHITE);
    s_display.setTextColor(OLED_COLOR_BLACK, OLED_COLOR_WHITE);
    s_display.setTextSize(1);
    s_display.setCursor(8, 1);
    s_display.print("DRIFTPAD V2"); // 11 chars * 6 - 1 = 65 px, spans X: 8..72 cleanly inside 7..72

    // Slanted Kinetic Speed Chevrons /// (X: 77..85)
    // 2px+ positive margin from banner at Y=10 (X: 72 vs X: 74)
    s_display.drawLine(77, 0, 74, 10, OLED_COLOR_WHITE);
    s_display.drawLine(81, 0, 78, 10, OLED_COLOR_WHITE);
    s_display.drawLine(85, 0, 82, 10, OLED_COLOR_WHITE);

    // Right Status Pill (X: 87..126, Y: 0..10) - 40 pixels wide
    constexpr int16_t PILL_X = 87;
    constexpr int16_t PILL_W = 40;
    s_display.drawRoundRect(PILL_X, 0, PILL_W, 11, 2, OLED_COLOR_WHITE);
    s_display.setTextColor(OLED_COLOR_WHITE);

    char pillBuf[12];
    uint8_t curLayer = configGet().activeLayer;
    snprintf(pillBuf, sizeof(pillBuf), "L%d:%s", curLayer, HallKey::isRapidTrigger() ? "RT" : "NRM");
    int16_t pillTextW = (int16_t)(strlen(pillBuf) * 6 - 1);
    int16_t pillTextX = PILL_X + (PILL_W - pillTextW) / 2;
    s_display.setCursor(pillTextX, 2);
    s_display.print(pillBuf);

    // Hairline divider with accent gap (Y: 11)
    s_display.drawFastHLine(0, 11, 65, OLED_COLOR_WHITE);
    s_display.drawFastHLine(68, 11, 60, OLED_COLOR_WHITE);

    // 2. Center Laser Divider (X: 66, Y: 12..62)
    for (int16_t y = 13; y <= 61; y += 3) {
        s_display.drawPixel(66, y, OLED_COLOR_WHITE);
    }
    s_display.drawFastHLine(64, 13, 5, OLED_COLOR_WHITE);
    s_display.drawFastHLine(64, 61, 5, OLED_COLOR_WHITE);

    // 3. Left Side: Showing what input in text you pressed (X: 1..65, Y: 12..63)
    int8_t lastKey = HallManager::getLastActiveKey();
    bool lastKeyPressChanged = (lastKey >= 0 && lastKey < NUM_KEYS && 
        (HallManager::getKey((uint8_t)lastKey).getPressCount() != s_lastPressCount[(uint8_t)lastKey]));
    bool lastKeyReleaseChanged = (lastKey >= 0 && lastKey < NUM_KEYS && 
        (HallManager::getKey((uint8_t)lastKey).getReleaseCount() != s_lastReleaseCount[(uint8_t)lastKey]));

    bool hasActiveKey = (lastKey >= 0 && lastKey < NUM_KEYS && 
                        (HallManager::getKey((uint8_t)lastKey).isPressed() || 
                         lastKeyPressChanged || 
                         HallManager::getKey((uint8_t)lastKey).getTravelMm() > 0.10f));

    if (hasActiveKey) {
        HallKey& k = HallManager::getKey((uint8_t)lastKey);
        const char* lbl = k.getLabel();
        uint8_t len = strlen(lbl);
        float currentTravel = k.getTravelMm();

        // RT re-press within one frame: key was released while still pressed -> render unpressed frame
        bool isRtRepress = (k.isPressed() && lastKeyReleaseChanged);
        bool keyTriggered = (k.isPressed() || lastKeyPressChanged) && !isRtRepress;

        s_display.setTextSize(1);
        s_display.setTextColor(OLED_COLOR_WHITE);
        s_display.setCursor(6, 13);
        if (keyTriggered) {
            s_display.print("TRIGGERED"); // 9 chars * 6 - 1 = 53 px, spans X: 6..58
        } else {
            s_display.print("STROKE:RT"); // 9 chars * 6 - 1 = 53 px, spans X: 6..58
        }

        // Cyber-Cockpit Chamfered Key Card (X: 5, Y: 23, W: 54, H: 26)
        constexpr int16_t cx = 5;
        constexpr int16_t cy = 23;
        constexpr int16_t cw = 54;
        constexpr int16_t ch = 26;

        // Top/bottom framing accents with clear spacing (no collision with TRIGGERED font)
        s_display.drawFastHLine(14, 21, 36, OLED_COLOR_WHITE);
        s_display.drawFastHLine(14, 50, 36, OLED_COLOR_WHITE);

        if (keyTriggered) {
            // Inverted filled card with chamfered corners
            s_display.fillRect(cx + 3, cy, cw - 3, ch, OLED_COLOR_WHITE);
            s_display.fillRect(cx, cy + 3, 3, ch - 3, OLED_COLOR_WHITE);
            // Diagonal cuts at top-left and bottom-right
            s_display.drawPixel(cx, cy, OLED_COLOR_BLACK);
            s_display.drawPixel(cx + 1, cy, OLED_COLOR_BLACK);
            s_display.drawPixel(cx, cy + 1, OLED_COLOR_BLACK);
            s_display.drawPixel(cx + cw - 1, cy + ch - 1, OLED_COLOR_BLACK);
            s_display.drawPixel(cx + cw - 2, cy + ch - 1, OLED_COLOR_BLACK);
            s_display.drawPixel(cx + cw - 1, cy + ch - 2, OLED_COLOR_BLACK);

            s_display.setTextColor(OLED_COLOR_BLACK, OLED_COLOR_WHITE);

            // Inverted speed chevrons flanking letter // D //
            if (len == 1) {
                s_display.drawLine(12, 27, 9, 44, OLED_COLOR_BLACK);
                s_display.drawLine(15, 27, 12, 44, OLED_COLOR_BLACK);
                s_display.drawLine(49, 27, 46, 44, OLED_COLOR_BLACK);
                s_display.drawLine(52, 27, 49, 44, OLED_COLOR_BLACK);
            } else if (len == 2) {
                s_display.drawLine(10, 27, 8, 44, OLED_COLOR_BLACK);
                s_display.drawLine(54, 27, 52, 44, OLED_COLOR_BLACK);
            }
        } else {
            // Outlined chamfered frame
            s_display.drawLine(cx + 3, cy, cx + cw - 1, cy, OLED_COLOR_WHITE);
            s_display.drawLine(cx + cw - 1, cy, cx + cw - 1, cy + ch - 4, OLED_COLOR_WHITE);
            s_display.drawLine(cx + cw - 1, cy + ch - 4, cx + cw - 4, cy + ch - 1, OLED_COLOR_WHITE);
            s_display.drawLine(cx + cw - 4, cy + ch - 1, cx, cy + ch - 1, OLED_COLOR_WHITE);
            s_display.drawLine(cx, cy + ch - 1, cx, cy + 3, OLED_COLOR_WHITE);
            s_display.drawLine(cx, cy + 3, cx + 3, cy, OLED_COLOR_WHITE);

            s_display.setTextColor(OLED_COLOR_WHITE);
        }

        // Bold centered key label
        if (len == 1) {
            s_display.setTextSize(3);
            s_display.setCursor(cx + (cw - 15) / 2, cy + (ch - 21) / 2);
        } else if (len == 2) {
            s_display.setTextSize(2);
            s_display.setCursor(cx + (cw - 22) / 2, cy + (ch - 14) / 2);
        } else if (len == 3) {
            s_display.setTextSize(2);
            s_display.setCursor(cx + (cw - 34) / 2, cy + (ch - 14) / 2);
        } else if (len == 4) {
            s_display.setTextSize(2);
            s_display.setCursor(cx + (cw - 46) / 2, cy + (ch - 14) / 2);
        } else {
            s_display.setTextSize(1);
            s_display.setCursor(cx + 4, cy + (ch - 8) / 2);
        }
        s_display.print(lbl);

        // Sub-Telemetry: Depth readout (X: 3..37) + Formula Drift Motec Tachometer (X: 41..63)
        s_display.setTextColor(OLED_COLOR_WHITE);
        s_display.setTextSize(1);
        s_display.setCursor(3, 53);
        s_display.print(currentTravel, 2);
        s_display.print("mm"); // spans X: 3..37

        // 6-Stage Motec Tachometer with Angled Speed Chevrons /// (X: 41..63, Y: 52..59)
        int8_t activeSegs = (int8_t)((currentTravel / 4.0f) * 6.0f);
        if (keyTriggered && activeSegs < 3) activeSegs = 3;
        if (activeSegs > 6) activeSegs = 6;

        for (int8_t s = 0; s < 5; ++s) {
            int16_t sx = 41 + s * 4;
            if (s < activeSegs) {
                s_display.drawLine(sx, 59, sx + 2, 53, OLED_COLOR_WHITE);
                s_display.drawLine(sx + 1, 59, sx + 3, 53, OLED_COLOR_WHITE);
            } else {
                s_display.drawPixel(sx + 1, 59, OLED_COLOR_WHITE); // Track dot
            }
        }
        // Segment 5: Redline Shift Block (X: 61..63)
        if (activeSegs >= 6 || keyTriggered) {
            if (keyTriggered && ((millis() / 50) % 2 == 0)) {
                s_display.fillRect(61, 52, 3, 8, OLED_COLOR_WHITE); // Strobe F1 Shift Light!
            } else {
                s_display.drawRect(61, 52, 3, 8, OLED_COLOR_WHITE);
            }
        } else {
            s_display.drawPixel(62, 59, OLED_COLOR_WHITE);
        }
    } else {
        // Cockpit Standby Telemetry Card (X: 4..60, Y: 14..61) - 57 pixels wide
        s_display.drawRoundRect(4, 14, 57, 47, 2, OLED_COLOR_WHITE);
        s_display.setTextColor(OLED_COLOR_WHITE);

        // Header: STATUS: with status diamond
        s_display.setTextSize(1);
        s_display.setCursor(8, 17);
        s_display.print("STATUS:");
        s_display.fillRect(50, 18, 5, 5, OLED_COLOR_WHITE);
        s_display.drawPixel(50, 18, OLED_COLOR_BLACK);
        s_display.drawPixel(54, 18, OLED_COLOR_BLACK);
        s_display.drawPixel(50, 22, OLED_COLOR_BLACK);
        s_display.drawPixel(54, 22, OLED_COLOR_BLACK);

        // Bold Inverted STANDBY Badge (X: 7..57, W: 51)
        s_display.fillRect(7, 26, 51, 10, OLED_COLOR_WHITE);
        s_display.setTextColor(OLED_COLOR_BLACK, OLED_COLOR_WHITE);
        s_display.setCursor(13, 27);
        s_display.print("STANDBY");
        s_display.setTextColor(OLED_COLOR_WHITE);

        // Informative Rapid Trigger Sensitivity Readout: "RT 0.15mm" (9 chars = 53 px, X: 6..58)
        s_display.setCursor(6, 38);
        s_display.print("RT ");
        s_display.print(HallKey::getRtSensitivity(), 2);
        s_display.print("mm");

        // Active Layer Configuration (Centered at X=15, 35px wide)
        s_display.setCursor(15, 47);
        uint8_t l = configGet().activeLayer;
        s_display.print(l == 0 ? "NUMPAD" : l == 1 ? "NAVIG" : "GAMING");

        // Live Hall-Effect Sensor Telemetry Oscilloscope Waveform (X: 7..57, Y: 56..60)
        const int8_t sineTable[16] = {0, 1, 2, 2, 3, 2, 2, 1, 0, -1, -2, -2, -3, -2, -2, -1};
        uint8_t waveClock = (millis() / 35);
        for (int16_t x = 7; x <= 57; ++x) {
            int16_t wy = 58 + sineTable[(x + waveClock) % 16] / 2;
            s_display.drawPixel(x, wy, OLED_COLOR_WHITE);
        }
    }

    // 4. Right Side: Live Diagram of All 16 Buttons with A1 Plunge Animation (X: 69..123, Y: 15..60)
    constexpr int16_t GRID_X = 69;
    constexpr int16_t GRID_Y = 15;
    constexpr int16_t BOX_W  = 11;
    constexpr int16_t BOX_H  = 9;
    constexpr int16_t GAP_X  = 3;
    constexpr int16_t GAP_Y  = 3;

    for (uint8_t row = 0; row < 4; ++row) {
        for (uint8_t col = 0; col < 4; ++col) {
            uint8_t keyIdx = row * 4 + col;
            int16_t bx = GRID_X + col * (BOX_W + GAP_X);
            int16_t by = GRID_Y + row * (BOX_H + GAP_Y);
            HallKey& k = HallManager::getKey(keyIdx);

            uint8_t curPress = k.getPressCount();
            uint8_t curRelease = k.getReleaseCount();
            bool livePressed = k.isPressed();
            bool isMacro = (keyIdx == 4 || keyIdx == 8 || keyIdx == 12 || keyIdx == 13);

            bool pressChanged = (curPress != s_lastPressCount[keyIdx]);
            bool releaseChanged = (curRelease != s_lastReleaseCount[keyIdx]);

            bool active = false;
            int16_t inset = 0;

            if (livePressed && releaseChanged) {
                // RT re-press within one frame: key was released and re-actuated while held!
                // Render one un-pressed frame so RT resets during a hold are visible.
                active = false;
                inset = (int16_t)(k.getTravelMm() / 4.0f * 4.0f + 0.5f);
                if (inset > 3) inset = 3;
                if (inset < 0) inset = 0;

                s_lastReleaseCount[keyIdx] = curRelease;
                s_lastPressCount[keyIdx] = curPress;
            } else if (livePressed) {
                // Key is actively pressed
                active = true;
                inset = (int16_t)(k.getTravelMm() / 4.0f * 4.0f + 0.5f);
                if (inset > 3) inset = 3;
                if (inset < 0) inset = 0;

                s_lastPressCount[keyIdx] = curPress;
                s_lastReleaseCount[keyIdx] = curRelease;
            } else if (pressChanged) {
                // Fast tap: actuation occurred between frames, but key is now released
                active = true;
                inset = (int16_t)(k.getTravelMm() / 4.0f * 4.0f + 0.5f);
                if (inset > 3) inset = 3;
                if (inset < 0) inset = 0;

                s_lastPressCount[keyIdx] = curPress;
                if (releaseChanged) {
                    s_overshootFrames[keyIdx] = 1;
                    s_lastReleaseCount[keyIdx] = curRelease;
                }
            } else if (releaseChanged || s_overshootFrames[keyIdx] > 0) {
                // Release overshoot: 1-frame release spring rebound
                active = false;
                inset = -1; // cap top at by - 1
                s_overshootFrames[keyIdx] = 0;

                s_lastReleaseCount[keyIdx] = curRelease;
                s_lastPressCount[keyIdx] = curPress;
            } else {
                // Normal resting / analog travel outline
                active = false;
                inset = (int16_t)(k.getTravelMm() / 4.0f * 4.0f + 0.5f);
                if (inset > 3) inset = 3;
                if (inset < 0) inset = 0;

                s_lastPressCount[keyIdx] = curPress;
                s_lastReleaseCount[keyIdx] = curRelease;
            }

            int16_t top = by + inset;

            if (active) {
                // A1 Plunge: Solid fill on actuation
                s_display.fillRoundRect(bx, top, BOX_W, BOX_H - inset, 2, OLED_COLOR_WHITE);
            } else {
                // A1 Plunge: Unpressed outline sinking with analog travel
                s_display.drawRoundRect(bx, top, BOX_W, BOX_H - inset, 1, OLED_COLOR_WHITE);
                if (inset <= 0) {
                    // Specular highlight line only when fully up
                    s_display.drawFastHLine(bx + 2, top + 1, BOX_W - 4, OLED_COLOR_WHITE);
                }
                if (isMacro) {
                    s_display.drawPixel(bx + 2, top + 2, OLED_COLOR_WHITE);
                }
            }

            // Fixed switch-plate base lip (1px below box: by + BOX_H = by + 9)
            s_display.drawFastHLine(bx + 1, by + BOX_H, BOX_W - 2, OLED_COLOR_WHITE);
        }
    }

    // 5. Tactical HUD Corner Reticles / Brackets
    // Top-Left
    s_display.drawFastHLine(0, 0, 8, OLED_COLOR_WHITE);
    s_display.drawFastVLine(0, 0, 6, OLED_COLOR_WHITE);
    // Top-Right
    s_display.drawFastHLine(119, 0, 9, OLED_COLOR_WHITE);
    s_display.drawFastVLine(127, 0, 6, OLED_COLOR_WHITE);
    // Bottom-Left
    s_display.drawFastHLine(0, 63, 8, OLED_COLOR_WHITE);
    s_display.drawFastVLine(0, 57, 7, OLED_COLOR_WHITE);
    // Bottom-Right
    s_display.drawFastHLine(119, 63, 9, OLED_COLOR_WHITE);
    s_display.drawFastVLine(127, 57, 7, OLED_COLOR_WHITE);

    mutex_enter_blocking(&s_wireMutex);
    s_display.display();
    mutex_exit(&s_wireMutex);
}

void updateFloatingBadge(int16_t w, int16_t h, const char* text) {
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

    updateFloatingBadge(56, 14, "DRIFTPAD");
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

    updateFloatingBadge(56, 14, "CYBER RT");
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

    updateFloatingBadge(62, 14, "HALL FLUX");
}

void renderScreensaver() {
    discardGridLatches();
    s_display.clearDisplay();

    uint8_t animIdx = 0;
    if (s_forcedAnim >= 0 && s_forcedAnim <= 2) {
        animIdx = (uint8_t)s_forcedAnim;
    } else {
        // Cycle between the 3 animations every SCREENSAVER_ANIM_CYCLE_MS (20s)
        animIdx = ((millis() - s_screensaverStartTime) / SCREENSAVER_ANIM_CYCLE_MS) % 3;
    }

    switch (animIdx) {
        case 0:
            renderAnimStarfield();
            break;
        case 1:
            renderAnimMatrixRain();
            break;
        case 2:
        default:
            renderAnimOscilloscope();
            break;
    }

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

void oledCycleMenu() {
    if (s_displaySleeping || s_screensaverActive) {
        oledWake();
    }
    uint8_t next = (static_cast<uint8_t>(s_currentMenu) + 1) % static_cast<uint8_t>(MenuMode::COUNT);
    s_currentMenu = static_cast<MenuMode>(next);
    s_menuLastActive = millis();
    s_lastActivityTime = millis();
    s_forceRender = true;
}

void oledAdjustCurrentSetting(int32_t delta) {
    if (delta == 0) return;

    if (s_displaySleeping || s_screensaverActive) {
        oledWake();
    }
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
            break;
    }
    s_forceRender = true;
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

void loop1() {
    s_core1Running = true;

    if (!s_initialized) {
        delay(10);
        return;
    }

    uint32_t now = millis();

    // Check activity for auto-wake / auto-screensaver (45s idle) / auto-sleep (1 hour idle)
    int8_t activeKey = HallManager::getLastActiveKey();
    if (activeKey >= 0 && (HallManager::getKey((uint8_t)activeKey).isPressed() || HallManager::getKey((uint8_t)activeKey).getTravelMm() > 0.20f)) {
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
