// Host-build stand-in for the Arduino core. Only what the firmware modules and the real
// arduino-pico Keyboard/HID_Keyboard libraries use when compiled for host tests.
// Time is a fake clock (host_clock.cpp) that tests advance explicitly.
#ifndef DRIFTPAD_HOST_ARDUINO_H
#define DRIFTPAD_HOST_ARDUINO_H

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cmath>

uint32_t millis();
uint32_t micros();
void delay(uint32_t ms);                  // advances the fake clock
void delayMicroseconds(unsigned int us);  // advances the fake clock
inline void noInterrupts() {}
inline void interrupts() {}

#define pgm_read_byte(addr) (*(const uint8_t*)(addr))
#define PROGMEM
inline void bzero(void* p, size_t n) { memset(p, 0, n); }

class Print {
public:
    virtual ~Print() {}
    virtual size_t write(uint8_t) = 0;
    virtual size_t write(const uint8_t* buffer, size_t size) {
        size_t n = 0;
        while (size--) n += write(*buffer++);
        return n;
    }
    int getWriteError() { return _writeError; }
    void clearWriteError() { _writeError = 0; }

protected:
    void setWriteError(int err = 1) { _writeError = err; }

private:
    int _writeError = 0;
};

#endif
