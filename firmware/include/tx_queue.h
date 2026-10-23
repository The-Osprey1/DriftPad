#ifndef TX_QUEUE_H
#define TX_QUEUE_H

#include <cstddef>
#include <cstdint>

/**
 * @file tx_queue.h
 * @brief Bounded ring of complete output lines, drained without ever blocking.
 *
 * All serial output goes through one TxQueue. arduino-pico's SerialUSB::write() waits up to
 * 1 s for the host when the CDC FIFO is full, which would stall the 1 kHz scan, so drain()
 * only hands the sink as many bytes as sink.availableForWrite() reports.
 *
 * - Lines are stored whole with their '\n' appended by enqueue(). A line is accepted completely
 *   or not at all, so the host never sees a truncated line or two lines spliced together.
 * - Replies: enqueue(..., Reply) succeeds whenever the caller checked hasRoomForReply() first
 *   and the reply is at most MAX_REPLY_LEN bytes. Commands are only parsed while that holds.
 * - Events (telemetry, raw chunks, cal progress) must leave room for one maximum reply after
 *   them; otherwise they are dropped whole and counted. Replies therefore never wait behind a
 *   flood of telemetry.
 *
 * Sizing: GET_CONFIG is the largest reply. Its worst case with 12-char ids, 3x16 keys at
 * {"idx":15,"code":255,"label":"ABCD"} and every settings field is about 2.0 KB (labels need no
 * escaping by the label rule). MAX_REPLY_LEN = 3072 leaves ~1 KB of margin for new fields;
 * the integration test must keep the real GET_CONFIG / INFO / STATUS replies below it. The ring
 * holds two maximum replies plus room for events.
 *
 * Core 0 only. Not thread safe. No heap.
 */
namespace proto {

constexpr size_t TX_QUEUE_BYTES = 8192;   // ring capacity (contract: >= 4 KB)
constexpr size_t MAX_REPLY_LEN  = 3072;   // longest reply line, '\n' excluded

static_assert(TX_QUEUE_BYTES >= 4096, "contract section 7: TX ring of at least 4 KB");
static_assert(TX_QUEUE_BYTES >= 2 * (MAX_REPLY_LEN + 1), "ring must hold a reply plus the event reserve");

enum class TxPriority : uint8_t {
    Reply = 0,   // answers a request; never dropped when hasRoomForReply() was checked
    Event,       // unsolicited (telemetry/raw/cal/log); dropped and counted when space is short
};

// Output device. The firmware wraps Serial; host tests use a fake with controllable space.
class TxSink {
public:
    // Bytes that can be written now without blocking (<= 0: none)
    virtual int availableForWrite() = 0;
    // Writes up to `len` bytes, returns how many were taken (may be fewer, e.g. host went away)
    virtual size_t write(const uint8_t* data, size_t len) = 0;
protected:
    ~TxSink() = default;
};

class TxQueue {
public:
    struct Stats {
        uint32_t bytesQueued;      // including the '\n' terminators
        uint32_t bytesSent;
        uint32_t linesQueued;
        uint32_t repliesQueued;
        uint32_t eventsQueued;
        uint32_t eventsDropped;    // events rejected for lack of space
        uint32_t repliesRejected;  // replies that did not fit (caller skipped hasRoomForReply())
        uint32_t linesInvalid;     // rejected: empty, containing '\n'/'\r', or longer than the ring
        uint32_t bytesCleared;     // discarded by clear()
        uint32_t highWater;        // most bytes ever queued at once
    };

    TxQueue();

    // Appends `line` (without terminator) plus '\n'. Returns false when it was not queued.
    bool enqueue(const char* line, size_t len, TxPriority priority);

    // True when a reply of MAX_REPLY_LEN bytes would be accepted now
    bool hasRoomForReply() const { return freeSpace() >= MAX_REPLY_LEN + 1; }

    // Writes at most min(maxBytes, sink.availableForWrite()) bytes; never blocks and never calls
    // sink.write() with more than the sink said it can take. Returns bytes written.
    size_t drain(TxSink& sink, size_t maxBytes = (size_t)-1);

    // Drops queued output (host closed the port). A line already partly written is kept to its
    // end so the byte stream stays line-aligned.
    void clear();

    size_t used() const { return _count; }
    size_t freeSpace() const { return TX_QUEUE_BYTES - _count; }
    bool empty() const { return _count == 0; }
    // True when the last byte handed to the sink was not a '\n' (a line is half written)
    bool midLine() const { return _midLine; }

    const Stats& stats() const { return _stats; }
    void resetStats();   // keeps the queue contents; highWater restarts from the current fill

private:
    void pushBytes(const uint8_t* data, size_t n);

    uint8_t _buf[TX_QUEUE_BYTES];
    size_t  _head;    // next byte to send
    size_t  _count;   // queued bytes
    bool    _midLine;
    Stats   _stats;
};

} // namespace proto

#endif // TX_QUEUE_H
