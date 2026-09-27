#ifndef JSON_WRITER_H
#define JSON_WRITER_H

#include <cstddef>
#include <cstdint>

/**
 * @file json_writer.h
 * @brief Builds one JSON text into a caller-owned buffer, with overflow detection.
 *
 * - Commas and colons are placed automatically: call key() then exactly one value inside an
 *   object, values only inside an array.
 * - Strings are escaped: '"' and '\\' with a backslash, every byte below 0x20 and every byte
 *   from 0x7F up as \u00XX. Device strings are ASCII by contract; the \u00XX form for bytes
 *   >= 0x80 only guarantees the output stays valid JSON (each byte is shown as a Latin-1 char).
 * - Millimetres come from integer centi-millimetres and are printed with exactly 2 decimals
 *   (mm(380) -> 3.80) without floating point. fixed() is for diagnostics only.
 * - Once anything does not fit, overflow() is set, later calls are ignored and the text must not
 *   be sent. Misuse (key() in an array, unbalanced end, nesting deeper than MAX_DEPTH) sets
 *   misuse(). ok() is false in both cases.
 *
 * The buffer always holds a NUL-terminated prefix of the text. No heap, no printf.
 */
namespace proto {

class JsonWriter {
public:
    static constexpr uint8_t MAX_DEPTH = 8;
    static constexpr uint8_t MAX_FIXED_DECIMALS = 6;

    // `capacity` is the buffer size in bytes including the terminating NUL
    JsonWriter(char* buffer, size_t capacity);

    void reset();

    JsonWriter& beginObject();
    JsonWriter& endObject();
    JsonWriter& beginArray();
    JsonWriter& endArray();
    JsonWriter& key(const char* name);

    JsonWriter& str(const char* text);                  // nullptr writes null
    JsonWriter& str(const char* text, size_t length);   // exactly `length` bytes (NUL included if present)
    JsonWriter& boolean(bool value);
    JsonWriter& i32(int32_t value);
    JsonWriter& u32(uint32_t value);
    JsonWriter& mm(int32_t cmm);                        // 0 -> 0.00, 5 -> 0.05, 380 -> 3.80, -25 -> -0.25
    // Fixed-point integer: scaled(123, 1) -> 12.3, scaled(-5, 3) -> -0.005. Exact, no float.
    JsonWriter& scaled(int32_t value, uint8_t decimals);  // decimals capped at 6
    JsonWriter& fixed(float value, uint8_t decimals);   // diagnostics; NaN/inf -> null, decimals capped at 6
    JsonWriter& null();
    JsonWriter& raw(const char* json);                  // pre-built JSON value, written as is (trusted)

    const char* data() const { return _buf; }
    size_t length() const { return _len; }
    size_t capacity() const { return _cap; }
    uint8_t depth() const { return _depth; }
    bool overflow() const { return _overflow; }
    bool misuse() const { return _misuse; }
    bool ok() const { return !_overflow && !_misuse; }
    // A finished top-level value: ok(), nothing left open, something written
    bool complete() const { return ok() && _depth == 0 && _len > 0 && !_afterKey; }

private:
    void beforeValue();
    void put(char c);
    void putn(const char* s, size_t n);
    void putEscaped(const char* s, size_t n);
    void putU64(uint64_t v);
    void putFraction(uint32_t frac, uint8_t decimals);   // ".ddd", zero padded; nothing for 0 decimals
    JsonWriter& open(char c, bool isObject);
    JsonWriter& close(char c, bool isObject);

    char*    _buf;
    size_t   _cap;
    size_t   _len;
    uint8_t  _depth;
    uint16_t _hasItems;   // bit d: container at depth d already holds an element
    uint16_t _isObject;   // bit d: container at depth d is an object
    bool     _afterKey;
    bool     _overflow;
    bool     _misuse;
};

} // namespace proto

#endif // JSON_WRITER_H
