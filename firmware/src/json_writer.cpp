#include "json_writer.h"

#include <cmath>
#include <cstring>

namespace proto {

namespace {

const char HEX_DIGITS[] = "0123456789abcdef";
const uint32_t POW10[JsonWriter::MAX_FIXED_DECIMALS + 1] = { 1, 10, 100, 1000, 10000, 100000, 1000000 };

inline uint16_t levelBit(uint8_t depth) { return (uint16_t)(1u << depth); }

} // namespace

JsonWriter::JsonWriter(char* buffer, size_t capacity)
    : _buf(buffer), _cap(buffer != nullptr ? capacity : 0) {
    reset();
}

void JsonWriter::reset() {
    _len = 0;
    _depth = 0;
    _hasItems = 0;
    _isObject = 0;
    _afterKey = false;
    _overflow = false;
    _misuse = false;
    if (_cap > 0) _buf[0] = '\0';
}

void JsonWriter::put(char c) {
    if (_overflow) return;
    if (_len + 1 >= _cap) {   // keep room for the terminator
        _overflow = true;
        return;
    }
    _buf[_len++] = c;
    _buf[_len] = '\0';
}

void JsonWriter::putn(const char* s, size_t n) {
    if (_overflow) return;
    if (n >= _cap || _len + n >= _cap) {
        _overflow = true;
        return;
    }
    memcpy(_buf + _len, s, n);
    _len += n;
    _buf[_len] = '\0';
}

void JsonWriter::putEscaped(const char* s, size_t n) {
    for (size_t i = 0; i < n && !_overflow; ++i) {
        uint8_t c = (uint8_t)s[i];
        if (c == '"' || c == '\\') {
            put('\\');
            put((char)c);
        } else if (c < 0x20 || c >= 0x7F) {
            char esc[6] = { '\\', 'u', '0', '0', HEX_DIGITS[c >> 4], HEX_DIGITS[c & 0x0F] };
            putn(esc, sizeof(esc));
        } else {
            put((char)c);
        }
    }
}

void JsonWriter::putU64(uint64_t v) {
    char tmp[20];
    uint8_t n = 0;
    do {
        tmp[n++] = (char)('0' + (uint8_t)(v % 10u));
        v /= 10u;
    } while (v != 0);
    char out[20];
    for (uint8_t i = 0; i < n; ++i) out[i] = tmp[n - 1 - i];
    putn(out, n);
}

void JsonWriter::beforeValue() {
    if (_afterKey) {
        _afterKey = false;
        return;
    }
    if (_depth == 0) {
        // Exactly one top-level value
        if (_hasItems & levelBit(0)) _misuse = true;
        _hasItems |= levelBit(0);
        return;
    }
    if (_isObject & levelBit(_depth)) {
        _misuse = true;   // object members need key() first
        return;
    }
    if (_hasItems & levelBit(_depth)) put(',');
    _hasItems |= levelBit(_depth);
}

JsonWriter& JsonWriter::open(char c, bool isObject) {
    if (!ok()) return *this;
    beforeValue();
    if (_depth >= MAX_DEPTH) _misuse = true;
    if (!ok()) return *this;
    ++_depth;
    _hasItems &= (uint16_t)~levelBit(_depth);
    if (isObject) _isObject |= levelBit(_depth);
    else _isObject &= (uint16_t)~levelBit(_depth);
    put(c);
    return *this;
}

JsonWriter& JsonWriter::close(char c, bool isObject) {
    if (!ok()) return *this;
    bool levelIsObject = (_isObject & levelBit(_depth)) != 0;
    if (_depth == 0 || _afterKey || levelIsObject != isObject) {
        _misuse = true;
        return *this;
    }
    put(c);
    --_depth;
    return *this;
}

JsonWriter& JsonWriter::beginObject() { return open('{', true); }
JsonWriter& JsonWriter::endObject()   { return close('}', true); }
JsonWriter& JsonWriter::beginArray()  { return open('[', false); }
JsonWriter& JsonWriter::endArray()    { return close(']', false); }

JsonWriter& JsonWriter::key(const char* name) {
    if (!ok()) return *this;
    if (_depth == 0 || !(_isObject & levelBit(_depth)) || _afterKey || name == nullptr) {
        _misuse = true;
        return *this;
    }
    if (_hasItems & levelBit(_depth)) put(',');
    _hasItems |= levelBit(_depth);
    put('"');
    putEscaped(name, strlen(name));
    put('"');
    put(':');
    _afterKey = true;
    return *this;
}

JsonWriter& JsonWriter::str(const char* text) {
    if (text == nullptr) return null();
    return str(text, strlen(text));
}

JsonWriter& JsonWriter::str(const char* text, size_t length) {
    if (!ok()) return *this;
    if (text == nullptr && length > 0) return null();
    beforeValue();
    put('"');
    putEscaped(text, length);
    put('"');
    return *this;
}

JsonWriter& JsonWriter::boolean(bool value) {
    if (!ok()) return *this;
    beforeValue();
    if (value) putn("true", 4);
    else putn("false", 5);
    return *this;
}

JsonWriter& JsonWriter::null() {
    if (!ok()) return *this;
    beforeValue();
    putn("null", 4);
    return *this;
}

JsonWriter& JsonWriter::i32(int32_t value) {
    if (!ok()) return *this;
    beforeValue();
    uint32_t magnitude = value < 0 ? 0u - (uint32_t)value : (uint32_t)value;
    if (value < 0) put('-');
    putU64(magnitude);
    return *this;
}

JsonWriter& JsonWriter::u32(uint32_t value) {
    if (!ok()) return *this;
    beforeValue();
    putU64(value);
    return *this;
}

void JsonWriter::putFraction(uint32_t frac, uint8_t decimals) {
    if (decimals == 0) return;
    char digits[MAX_FIXED_DECIMALS + 1];
    digits[0] = '.';
    for (uint8_t i = decimals; i > 0; --i) {
        digits[i] = (char)('0' + frac % 10u);
        frac /= 10u;
    }
    putn(digits, (size_t)decimals + 1);
}

JsonWriter& JsonWriter::mm(int32_t cmm) {
    return scaled(cmm, 2);
}

JsonWriter& JsonWriter::scaled(int32_t value, uint8_t decimals) {
    if (!ok()) return *this;
    if (decimals > MAX_FIXED_DECIMALS) decimals = MAX_FIXED_DECIMALS;
    beforeValue();
    uint32_t magnitude = value < 0 ? 0u - (uint32_t)value : (uint32_t)value;
    if (value < 0) put('-');
    putU64(magnitude / POW10[decimals]);
    putFraction(magnitude % POW10[decimals], decimals);
    return *this;
}

JsonWriter& JsonWriter::fixed(float value, uint8_t decimals) {
    if (!ok()) return *this;
    if (std::isnan(value) || std::isinf(value)) return null();
    if (decimals > MAX_FIXED_DECIMALS) decimals = MAX_FIXED_DECIMALS;

    double x = value;
    bool negative = x < 0.0;
    if (negative) x = -x;
    double scaled = x * (double)POW10[decimals] + 0.5;   // round half away from zero
    if (scaled >= 1.8e19) return null();                 // beyond uint64; not a useful diagnostic
    uint64_t n = (uint64_t)scaled;

    beforeValue();
    if (negative && n != 0) put('-');                    // no "-0.00"
    putU64(n / POW10[decimals]);
    putFraction((uint32_t)(n % POW10[decimals]), decimals);
    return *this;
}

JsonWriter& JsonWriter::raw(const char* json) {
    if (!ok()) return *this;
    if (json == nullptr || json[0] == '\0') return null();
    beforeValue();
    putn(json, strlen(json));
    return *this;
}

} // namespace proto
