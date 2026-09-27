// Fakes behind tests/firmware_host/Arduino.h: Print formatting, String, Serial with a scripted RX
// stream and a captured TX stream, pins, and rp2040. Tests drive them through the C ABI below.
#include <cctype>
#include <cstdio>
#include <string>
#include "Arduino.h"

HostSerial Serial;
HostRP2040 rp2040;

namespace {
std::string s_rx;
size_t      s_rxPos = 0;
std::string s_tx;
bool        s_dtr = true;
int         s_txSpace = 4096;        // bytes the fake CDC FIFO accepts per availableForWrite()
uint32_t    s_writesWhenFull = 0;    // Serial.write() calls made with no FIFO space (would block)
int         s_bootloaderRequests = 0;
int         s_reboots = 0;
int         s_idleOtherCore = 0;
uint8_t     s_pinLevel[32];
bool        s_pinsInit = false;

void initPins() {
    if (s_pinsInit) return;
    for (auto& l : s_pinLevel) l = HIGH;
    s_pinsInit = true;
}
} // namespace

// ---- Print -----------------------------------------------------------------------------------
size_t Print::print(long v, int base) {
    char buf[40];
    if (base == 16) snprintf(buf, sizeof(buf), "%lx", v);
    else snprintf(buf, sizeof(buf), "%ld", v);
    return write(buf);
}

size_t Print::print(unsigned long v, int base) {
    char buf[40];
    if (base == 16) snprintf(buf, sizeof(buf), "%lx", v);
    else snprintf(buf, sizeof(buf), "%lu", v);
    return write(buf);
}

size_t Print::print(double v, int digits) {
    char buf[64];
    snprintf(buf, sizeof(buf), "%.*f", digits, v);
    return write(buf);
}

size_t Print::printf(const char* fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    if (n < 0) return 0;
    return write((const uint8_t*)buf, (size_t)(n < (int)sizeof(buf) ? n : (int)sizeof(buf) - 1));
}

// ---- String ------------------------------------------------------------------------------------
String::String(double v, unsigned int decimals) {
    char buf[64];
    snprintf(buf, sizeof(buf), "%.*f", (int)decimals, v);
    _s = buf;
}

void String::trim() {
    size_t b = 0, e = _s.size();
    while (b < e && isspace((unsigned char)_s[b])) ++b;
    while (e > b && isspace((unsigned char)_s[e - 1])) --e;
    _s = _s.substr(b, e - b);
}

String String::substring(unsigned int left, unsigned int right) const {
    if (left > right) { unsigned int t = left; left = right; right = t; }
    if (left >= _s.size()) return String("");
    if (right > _s.size()) right = (unsigned int)_s.size();
    return String(_s.substr(left, right - left));
}

long String::toInt() const { return atol(_s.c_str()); }
float String::toFloat() const { return (float)atof(_s.c_str()); }

bool String::equalsIgnoreCase(const String& o) const {
    if (_s.size() != o._s.size()) return false;
    for (size_t i = 0; i < _s.size(); ++i) {
        if (tolower((unsigned char)_s[i]) != tolower((unsigned char)o._s[i])) return false;
    }
    return true;
}

int String::indexOf(char c, unsigned int from) const {
    size_t p = _s.find(c, from);
    return p == std::string::npos ? -1 : (int)p;
}

int String::indexOf(const char* s, unsigned int from) const {
    size_t p = _s.find(s ? s : "", from);
    return p == std::string::npos ? -1 : (int)p;
}

// ---- Serial ------------------------------------------------------------------------------------
int HostSerial::available() { return (int)(s_rx.size() - s_rxPos); }
int HostSerial::read() { return s_rxPos < s_rx.size() ? (uint8_t)s_rx[s_rxPos++] : -1; }
int HostSerial::peek() { return s_rxPos < s_rx.size() ? (uint8_t)s_rx[s_rxPos] : -1; }
int HostSerial::availableForWrite() { return s_dtr ? s_txSpace : 0; }
HostSerial::operator bool() { return s_dtr; }

size_t HostSerial::write(uint8_t c) { return write(&c, 1); }

size_t HostSerial::write(const uint8_t* buffer, size_t size) {
    // arduino-pico's SerialUSB::write() waits (up to 1 s) when the FIFO is full; the fake records
    // that such a call happened instead of waiting
    if (s_dtr && (int)size > s_txSpace) s_writesWhenFull++;
    s_tx.append((const char*)buffer, size);
    return size;
}

// ---- pins / rp2040 -----------------------------------------------------------------------------
void pinMode(uint8_t, uint8_t) { initPins(); }
void digitalWrite(uint8_t pin, uint8_t value) { initPins(); if (pin < 32) s_pinLevel[pin] = value ? HIGH : LOW; }
int digitalRead(uint8_t pin) { initPins(); return pin < 32 ? s_pinLevel[pin] : HIGH; }
int analogRead(uint8_t) { return 2048; }

void HostRP2040::rebootToBootloader() { s_bootloaderRequests++; }
void HostRP2040::reboot() { s_reboots++; }
void HostRP2040::idleOtherCore() { s_idleOtherCore++; }
void HostRP2040::resumeOtherCore() {}

// ---- C ABI -------------------------------------------------------------------------------------
extern "C" {

void serial_fake_reset() {
    s_rx.clear();
    s_rxPos = 0;
    s_tx.clear();
    s_dtr = true;
    s_txSpace = 4096;
    s_writesWhenFull = 0;
    s_bootloaderRequests = 0;
    s_reboots = 0;
    s_idleOtherCore = 0;
    s_pinsInit = false;
    initPins();
}

void serial_fake_feed(const char* data, int len) {
    if (s_rxPos > 0 && s_rxPos == s_rx.size()) {
        s_rx.clear();
        s_rxPos = 0;
    }
    s_rx.append(data, (size_t)len);
}

int serial_fake_rx_pending() { return (int)(s_rx.size() - s_rxPos); }

// Copies and removes up to `cap` bytes of captured output; returns the count
int serial_fake_take(char* out, int cap) {
    int n = (int)s_tx.size() < cap ? (int)s_tx.size() : cap;
    memcpy(out, s_tx.data(), (size_t)n);
    s_tx.erase(0, (size_t)n);
    return n;
}

void serial_fake_set_dtr(int on) { s_dtr = on != 0; }
void serial_fake_set_tx_space(int bytes) { s_txSpace = bytes; }
uint32_t serial_fake_writes_when_full() { return s_writesWhenFull; }
int rp2040_fake_bootloader_requests() { return s_bootloaderRequests; }
int rp2040_fake_idle_other_core() { return s_idleOtherCore; }
void pin_fake_set(int pin, int level) { initPins(); if (pin >= 0 && pin < 32) s_pinLevel[pin] = level ? HIGH : LOW; }

}
