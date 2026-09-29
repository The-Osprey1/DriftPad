// Host stand-in for the SSD1306 driver: the real Adafruit_GFX draws into this framebuffer, laid
// out like the panel's (page-major, one byte = 8 vertical pixels). Commands are recorded so tests
// can see what the firmware sent to the controller.
#pragma once
#include <Adafruit_GFX.h>
#include "Wire.h"

#define SSD1306_WHITE 1
#define SSD1306_BLACK 0
#define SSD1306_INVERSE 2
#define SSD1306_SWITCHCAPVCC 2
#define SSD1306_SETMULTIPLEX 0xA8
#define SSD1306_SETDISPLAYOFFSET 0xD3
#define SSD1306_SETSTARTLINE 0x40
#define SSD1306_SETCOMPINS 0xDA
#define SSD1306_SETCONTRAST 0x81
#define SSD1306_SETPRECHARGE 0xD9
#define SSD1306_SETVCOMDETECT 0xDB
#define SSD1306_DISPLAYON 0xAF
#define SSD1306_DISPLAYOFF 0xAE

class Adafruit_SSD1306 : public Adafruit_GFX {
public:
    uint8_t buf[128 * 64 / 8] = {0};
    uint8_t lastContrast = 0;      // the value that followed the newest SETCONTRAST command
    uint8_t lastPrecharge = 0;     // ... SETPRECHARGE
    uint8_t lastVcomh = 0;         // ... SETVCOMDETECT
    uint8_t pendingCmd = 0;        // a command that takes one parameter byte, waiting for it
    bool textWrapEnabled() const { return wrap; }

    Adafruit_SSD1306(int w, int h, TwoWire*, int) : Adafruit_GFX(w, h) {}
    bool begin(uint8_t, uint8_t, bool, bool) { return true; }
    void ssd1306_command(uint8_t c) {
        if (pendingCmd) {
            if (pendingCmd == SSD1306_SETCONTRAST) lastContrast = c;
            else if (pendingCmd == SSD1306_SETPRECHARGE) lastPrecharge = c;
            else if (pendingCmd == SSD1306_SETVCOMDETECT) lastVcomh = c;
            pendingCmd = 0;
        } else if (c == SSD1306_SETCONTRAST || c == SSD1306_SETPRECHARGE || c == SSD1306_SETVCOMDETECT) {
            pendingCmd = c;
        }
    }
    void dim(bool) {}
    uint8_t* getBuffer() { return buf; }
    void clearDisplay() { memset(buf, 0, sizeof buf); }
    void display() {}
    void drawPixel(int16_t x, int16_t y, uint16_t c) override {
        if (x < 0 || y < 0 || x >= 128 || y >= 64) return;
        uint8_t bit = 1 << (y & 7);
        uint8_t& b = buf[x + (y / 8) * 128];
        if (c == SSD1306_INVERSE) b ^= bit;
        else if (c) b |= bit;
        else b &= ~bit;
    }
};
