#ifndef TIMING_H
#define TIMING_H

#include <cstdint>
#include "json_writer.h"
#include "tx_queue.h"

/**
 * @file timing.h
 * @brief Scan-loop and background-operation instrumentation behind TIMING and SCAN_RATE.
 *
 * Times are 32-bit microseconds from an injectable clock (the firmware passes micros(); host
 * tests pass a fake). Differences use unsigned arithmetic, so the 71-minute wrap of micros() is
 * harmless for intervals shorter than that.
 *
 * Scan statistics (from scanBegin/scanEnd marks):
 * - scans: scan starts since reset()
 * - scan_hz: scans in the last full second (window of >= 1 s, normalised to per-second)
 * - gap = time between consecutive scan starts; histogram buckets <= 1.1, 1.5, 2, 5, 10, 50 ms
 *   and > 50 ms; max gap; missed deadlines = gaps longer than 1.5 x the scan period
 * - scan duration (begin -> end): max and average
 * Operation statistics: last/max/count per Op (command, telemetry, save, ...).
 *
 * Core 0 only. No heap, no floating point outside the JSON serialiser.
 */
class Timing {
public:
    using ClockFn = uint32_t (*)();

    enum class Op : uint8_t {
        Command = 0,      // one request parsed + handled + reply queued
        Telemetry,        // one telemetry frame built and queued
        Save,             // flash save (scan paused)
        Calibration,      // one guided-calibration step (per scan while active)
        Publish,          // DisplaySnapshot publish to core 1
        DisplayRequest,   // queueing a display command to core 1
        TxDrain,          // one TX drain slice
        Count
    };
    static constexpr uint8_t OP_COUNT = (uint8_t)Op::Count;

    // Upper bounds (inclusive, us) of the gap histogram buckets; the last bucket is "> 50 ms"
    static constexpr uint8_t GAP_BUCKETS = 7;
    static constexpr uint32_t GAP_BUCKET_LIMIT_US[GAP_BUCKETS - 1] = { 1100, 1500, 2000, 5000, 10000, 50000 };

    struct OpStats {
        uint32_t lastUs;
        uint32_t maxUs;
        uint32_t count;
    };

    explicit Timing(uint32_t periodUs = 1000, ClockFn clock = nullptr);

    void setClock(ClockFn clock) { _clock = clock; }
    uint32_t now() const { return _clock != nullptr ? _clock() : 0; }
    uint32_t periodUs() const { return _periodUs; }

    // Marks. The overloads without an argument read the clock.
    void scanBegin(uint32_t nowUs);
    void scanEnd(uint32_t nowUs);
    void scanBegin() { scanBegin(now()); }
    void scanEnd() { scanEnd(now()); }

    void recordOp(Op op, uint32_t durationUs);

    // TIMING RESET: clears every accumulator (scans, histogram, max gap, missed deadlines,
    // durations, operations, the SCAN_RATE max gap). The next scan starts a new gap chain.
    // scan_hz keeps its running one-second window: it is a rate, not an accumulator.
    void reset();

    uint32_t scans() const { return _scans; }
    uint32_t scanRateHz() const { return _rateHz; }
    uint32_t maxGapUs() const { return _maxGapUs; }
    uint32_t missedDeadlines() const { return _missed; }
    uint32_t gapBucket(uint8_t i) const { return i < GAP_BUCKETS ? _gapHist[i] : 0; }
    uint32_t scanMaxUs() const { return _durMaxUs; }
    uint32_t scanDurations() const { return _durCount; }
    // Average scan duration in 1/10 us (integer, so callers need no float)
    uint32_t scanAvgTenthsUs() const;
    OpStats op(Op o) const;
    static const char* opName(Op o);   // "command", "telemetry", "save", ...

    // TIMING reply body: adds the documented fields to an object the caller has opened
    // (after "type":"timing"). `tx` may be nullptr (tx_* fields are then omitted).
    void writeTimingFields(proto::JsonWriter& w, uint32_t uptimeMs, const proto::TxQueue* tx) const;

    // Legacy v1 SCAN_RATE fields "hz" and "max_gap_us". As in v1, max_gap_us is the largest gap
    // since the previous SCAN_RATE and restarts after being reported when `consume` is true.
    void writeScanRateFields(proto::JsonWriter& w, bool consume = true);

    // Times a scope into an Op with the Timing clock.
    class Scoped {
    public:
        Scoped(Timing& t, Op op) : _t(t), _op(op), _start(t.now()) {}
        ~Scoped() { _t.recordOp(_op, _t.now() - _start); }
        Scoped(const Scoped&) = delete;
        Scoped& operator=(const Scoped&) = delete;
    private:
        Timing&  _t;
        Op       _op;
        uint32_t _start;
    };

private:
    ClockFn  _clock;
    uint32_t _periodUs;

    bool     _haveLastStart;
    uint32_t _lastStartUs;
    bool     _inScan;

    uint32_t _scans;
    uint32_t _maxGapUs;
    uint32_t _legacyMaxGapUs;
    uint32_t _missed;
    uint32_t _gapHist[GAP_BUCKETS];

    uint32_t _durMaxUs;
    uint32_t _durCount;
    uint64_t _durSumUs;

    bool     _windowStarted;
    uint32_t _windowStartUs;
    uint32_t _windowScans;
    uint32_t _rateHz;

    OpStats  _ops[OP_COUNT];
};

#endif // TIMING_H
