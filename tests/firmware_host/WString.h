// Host-build stand-in for the Arduino String class: the members the firmware (and the pre-fix
// firmware used by defect-reproduction tests) call, with Arduino's semantics. In particular
// toInt()/toFloat() follow the core (atol/atof: invalid text becomes 0, trailing junk is ignored),
// which is exactly the behaviour the old command parser relied on.
#ifndef DRIFTPAD_HOST_WSTRING_H
#define DRIFTPAD_HOST_WSTRING_H

#include <string>

class String {
public:
    String(const char* s = "") : _s(s ? s : "") {}
    String(const std::string& s) : _s(s) {}
    explicit String(char c) : _s(1, c) {}
    explicit String(int v) : _s(std::to_string(v)) {}
    explicit String(long v) : _s(std::to_string(v)) {}
    explicit String(unsigned int v) : _s(std::to_string(v)) {}
    explicit String(unsigned long v) : _s(std::to_string(v)) {}
    String(double v, unsigned int decimals = 2);

    unsigned int length() const { return (unsigned int)_s.size(); }
    const char* c_str() const { return _s.c_str(); }
    char charAt(unsigned int i) const { return i < _s.size() ? _s[i] : 0; }
    char operator[](unsigned int i) const { return charAt(i); }

    String& operator+=(char c) { _s += c; return *this; }
    String& operator+=(const char* s) { if (s) _s += s; return *this; }
    String& operator+=(const String& s) { _s += s._s; return *this; }
    friend String operator+(const String& a, const String& b) { return String(a._s + b._s); }
    friend String operator+(const String& a, const char* b) { return String(a._s + (b ? b : "")); }
    bool operator==(const String& o) const { return _s == o._s; }
    bool operator==(const char* o) const { return _s == (o ? o : ""); }
    bool operator!=(const String& o) const { return _s != o._s; }

    void trim();
    String substring(unsigned int left) const { return substring(left, length()); }
    String substring(unsigned int left, unsigned int right) const;
    long toInt() const;
    float toFloat() const;
    bool startsWith(const String& prefix) const { return _s.compare(0, prefix._s.size(), prefix._s) == 0 && _s.size() >= prefix._s.size(); }
    bool startsWith(const char* prefix) const { return startsWith(String(prefix)); }
    bool equals(const String& o) const { return _s == o._s; }
    bool equalsIgnoreCase(const String& o) const;
    bool equalsIgnoreCase(const char* o) const { return equalsIgnoreCase(String(o)); }
    int indexOf(char c, unsigned int from = 0) const;
    int indexOf(const char* s, unsigned int from = 0) const;

private:
    std::string _s;
};

#endif
