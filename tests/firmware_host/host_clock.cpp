// Fake Arduino time base for host tests. Nothing advances on its own: tests (and delay calls
// inside the code under test) move it forward.
#include "Arduino.h"

namespace {
uint64_t s_nowUs = 0;
}

extern "C" {
uint64_t host_clock_now_us() { return s_nowUs; }
void host_clock_advance_us(uint64_t us) { s_nowUs += us; }
void host_clock_set_us(uint64_t us) { s_nowUs = us; }
}

uint32_t millis() { return (uint32_t)(s_nowUs / 1000); }
uint32_t micros() { return (uint32_t)s_nowUs; }
void delay(uint32_t ms) { s_nowUs += (uint64_t)ms * 1000; }
void delayMicroseconds(unsigned int us) { s_nowUs += us; }
