// Host stand-in for <Wire.h>: an optional OLED ACKs at 0x3C; transfers do nothing.
#pragma once
struct TwoWire {
    int address = 0;
    bool oledPresent = true;
    void setSDA(int) {}
    void setSCL(int) {}
    void begin() {}
    void setClock(int) {}
    void setTimeout(int, bool) {}
    void beginTransmission(int value) { address = value; }
    int endTransmission() { return oledPresent && address == 0x3C ? 0 : 4; }
};
extern TwoWire Wire;
inline void gpio_pull_up(int) {}
