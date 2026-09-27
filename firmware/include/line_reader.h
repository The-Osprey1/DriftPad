#ifndef LINE_READER_H
#define LINE_READER_H

#include <cstdint>
#include "settings_limits.h"

/**
 * @file line_reader.h
 * @brief Assembles serial request lines from single bytes into a fixed buffer.
 *
 * - '\n' or '\r' ends a line; "\r\n" counts once (the '\n' then ends an empty line, which is
 *   ignored like every empty line). A line of spaces only counts as empty.
 * - At most limits::LINE_MAX_LEN bytes per line, terminator excluded. A longer line is never
 *   truncated and executed: its bytes are dropped until the terminator arrives and then it is
 *   reported as Overflow (the caller replies line_too_long).
 * - NUL, the other control bytes (0x01..0x1F except the terminators) and DEL make the line
 *   Invalid (the caller replies bad_request) instead of passing silently. Bytes >= 0x80 are
 *   stored; label validation rejects them later where they matter.
 *
 * For Invalid and Overflow the buffer still holds the (first LINE_MAX_LEN) bytes so the caller
 * can echo a well-formed "@id" prefix; the content is never executed.
 */
namespace proto {

class LineReader {
public:
    enum class Event : uint8_t {
        None = 0,   // byte consumed, no line finished (or an empty line was ignored)
        Line,       // a complete, valid, non-empty line is in line()
        Overflow,   // a line longer than LINE_MAX_LEN ended; discarded
        Invalid,    // a line with a control byte ended; discarded
    };

    struct Stats {
        uint32_t bytes;
        uint32_t lines;
        uint32_t overflows;
        uint32_t invalid;
    };

    LineReader();

    Event feed(uint8_t byte);

    // The line reported by the last non-None event, NUL terminated. Valid until the next feed().
    // Mutable so the parser can tokenise it in place.
    char* line() { return _buf; }
    uint16_t length() const { return _lineLen; }

    // Drops any partial line (e.g. when the host reconnects)
    void reset();

    const Stats& stats() const { return _stats; }

private:
    char     _buf[limits::LINE_MAX_LEN + 1];
    uint16_t _len;        // bytes of the line being assembled
    uint16_t _lineLen;    // length of the finished line
    bool     _overflow;
    bool     _invalid;
    bool     _nonSpace;   // the line holds something other than spaces
    Stats    _stats;
};

} // namespace proto

#endif // LINE_READER_H
