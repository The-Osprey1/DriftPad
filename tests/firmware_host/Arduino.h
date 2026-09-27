// Host-build stand-in for the Arduino core (arduino-pico). Only what the firmware modules, the
// pre-fix firmware used by defect-reproduction tests, and the real arduino-pico Keyboard /
// HID_Keyboard libraries use when compiled for host tests.
//
// Time is a fake clock (host_clock.cpp). Serial, pins and rp2040 are fakes (arduino_host.cpp)
// that tests drive through a C ABI.
#ifndef DRIFTPAD_HOST_ARDUINO_H
#define DRIFTPAD_HOST_ARDUINO_H

#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <cmath>

uint32_t millis();
uint32_t micros();
void delay(uint32_t ms);                  // advances the fake clock
void delayMicroseconds(unsigned int us);  // advances the fake clock
inline void noInterrupts() {}
inline void interrupts() {}
inline void yield() {}

#define pgm_read_byte(addr) (*(const uint8_t*)(addr))
#define PROGMEM
#define F(s) (s)
inline void bzero(void* p, size_t n) { memset(p, 0, n); }

// ---- pins ------------------------------------------------------------------------------------
#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
#define LED_BUILTIN 25
void pinMode(uint8_t pin, uint8_t mode);
void digitalWrite(uint8_t pin, uint8_t value);
int digitalRead(uint8_t pin);             // HIGH unless a test drives the pin low
int analogRead(uint8_t pin);
inline void analogReadResolution(int) {}

#include "WString.h"

// ---- Print -----------------------------------------------------------------------------------
class Print {
public:
    virtual ~Print() {}
    virtual size_t write(uint8_t) = 0;
    virtual size_t write(const uint8_t* buffer, size_t size) {
        size_t n = 0;
        while (size--) n += write(*buffer++);
        return n;
    }
    size_t write(const char* s) { return s ? write((const uint8_t*)s, strlen(s)) : 0; }
    int getWriteError() { return _writeError; }
    void clearWriteError() { _writeError = 0; }

    size_t print(const char* s) { return write(s); }
    size_t print(const String& s) { return write(s.c_str()); }
    size_t print(char c) { return write((uint8_t)c); }
    size_t print(unsigned char v, int base = 10) { return print((unsigned long)v, base); }
    size_t print(int v, int base = 10) { return print((long)v, base); }
    size_t print(unsigned int v, int base = 10) { return print((unsigned long)v, base); }
    size_t print(long v, int base = 10);
    size_t print(unsigned long v, int base = 10);
    size_t print(double v, int digits = 2);
    template <typename T> size_t println(const T& v) { size_t n = print(v); return n + println(); }
    template <typename T> size_t println(const T& v, int arg) { size_t n = print(v, arg); return n + println(); }
    size_t println() { return write("\r\n"); }
    size_t printf(const char* fmt, ...);

protected:
    void setWriteError(int err = 1) { _writeError = err; }

private:
    int _writeError = 0;
};

// ---- Serial (USB CDC) --------------------------------------------------------------------------
class HostSerial : public Print {
public:
    void begin(unsigned long) {}
    int available();
    int read();
    int peek();
    int availableForWrite();
    void flush() {}
    size_t write(uint8_t c) override;
    size_t write(const uint8_t* buffer, size_t size) override;
    using Print::write;
    operator bool();                      // DTR: the host has the port open
};
extern HostSerial Serial;

// ---- rp2040 ------------------------------------------------------------------------------------
class HostRP2040 {
public:
    void rebootToBootloader();
    void reboot();
    void idleOtherCore();
    void resumeOtherCore();
};
extern HostRP2040 rp2040;

#endif
