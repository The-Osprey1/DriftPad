#include "line_reader.h"

namespace proto {

LineReader::LineReader() : _stats{} {
    reset();
    _lineLen = 0;
}

void LineReader::reset() {
    _len = 0;
    _overflow = false;
    _invalid = false;
    _nonSpace = false;
    _buf[0] = '\0';
}

LineReader::Event LineReader::feed(uint8_t byte) {
    _stats.bytes++;

    if (byte == '\n' || byte == '\r') {
        Event ev = Event::None;
        if (_overflow) {
            ev = Event::Overflow;
            _stats.overflows++;
        } else if (_invalid) {
            ev = Event::Invalid;
            _stats.invalid++;
        } else if (_nonSpace) {
            ev = Event::Line;
            _stats.lines++;
        }
        _buf[_len] = '\0';
        _lineLen = _len;
        _len = 0;
        _overflow = false;
        _invalid = false;
        _nonSpace = false;
        return ev;
    }

    if (byte < 0x20 || byte == 0x7F) {
        _invalid = true;
        _nonSpace = true;
    } else if (byte != ' ') {
        _nonSpace = true;
    }

    if (_len < limits::LINE_MAX_LEN) {
        _buf[_len++] = (char)byte;
    } else {
        // Keep the first LINE_MAX_LEN bytes for the id echo; the line itself is dead
        _overflow = true;
    }
    return Event::None;
}

} // namespace proto
