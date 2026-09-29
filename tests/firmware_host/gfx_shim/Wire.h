// Host stand-in for <Wire.h> for oled_frames.cpp: I2C does nothing and nothing answers a scan.
#pragma once
struct TwoWire {
    void setSDA(int) {}
    void setSCL(int) {}
    void begin() {}
    void setClock(int) {}
    void setTimeout(int, bool) {}
    void beginTransmission(int) {}
    int endTransmission() { return 4; }
};
extern TwoWire Wire;
inline void gpio_pull_up(int) {}
