#include "timing.h"

#include <cstring>

namespace {

constexpr uint32_t RATE_WINDOW_US = 1000000;

const char* const OP_NAMES[Timing::OP_COUNT] = {
    "command", "telemetry", "save", "calibration", "publish", "display_request", "tx_drain",
};

// "<prefix><suffix>" into a small stack buffer for composed JSON keys
const char* joinKey(char* out, size_t outSize, const char* prefix, const char* suffix) {
    size_t a = strlen(prefix);
    size_t b = strlen(suffix);
    if (a + b + 1 > outSize) {
        out[0] = '\0';
        return out;
    }
    memcpy(out, prefix, a);
    memcpy(out + a, suffix, b + 1);
    return out;
}

// "le_1100" / "gt_50000"
const char* bucketKey(char* out, size_t outSize, const char* prefix, uint32_t limitUs) {
    char digits[11];
    uint8_t n = 0;
    do {
        digits[n++] = (char)('0' + limitUs % 10u);
        limitUs /= 10u;
    } while (limitUs != 0 && n < sizeof(digits));
    size_t p = strlen(prefix);
    if (p + n + 1 > outSize) {
        out[0] = '\0';
        return out;
    }
    memcpy(out, prefix, p);
    for (uint8_t i = 0; i < n; ++i) out[p + i] = digits[n - 1 - i];
    out[p + n] = '\0';
    return out;
}

} // namespace

Timing::Timing(uint32_t periodUs, ClockFn clock)
    : _clock(clock), _periodUs(periodUs == 0 ? 1 : periodUs), _windowStarted(false),
      _windowStartUs(0), _windowScans(0), _rateHz(0) {
    reset();
}

void Timing::reset() {
    _haveLastStart = false;
    _lastStartUs = 0;
    _inScan = false;
    _scans = 0;
    _maxGapUs = 0;
    _legacyMaxGapUs = 0;
    _missed = 0;
    memset(_gapHist, 0, sizeof(_gapHist));
    _durMaxUs = 0;
    _durCount = 0;
    _durSumUs = 0;
    memset(_ops, 0, sizeof(_ops));
}

void Timing::scanBegin(uint32_t nowUs) {
    if (_haveLastStart) {
        uint32_t gap = nowUs - _lastStartUs;
        if (gap > _maxGapUs) _maxGapUs = gap;
        if (gap > _legacyMaxGapUs) _legacyMaxGapUs = gap;
        // Missed deadline: the scan came more than half a period late
        if (gap > _periodUs + _periodUs / 2) _missed++;
        uint8_t b = 0;
        while (b < GAP_BUCKETS - 1 && gap > GAP_BUCKET_LIMIT_US[b]) ++b;
        _gapHist[b]++;
    }
    _haveLastStart = true;
    _lastStartUs = nowUs;
    _inScan = true;
    _scans++;

    // scan_hz: scans in the last window of at least one second, normalised to per-second so a
    // stall longer than a second still reports a true rate
    if (!_windowStarted) {
        _windowStarted = true;
        _windowStartUs = nowUs;
        _windowScans = 0;
    }
    uint32_t elapsed = nowUs - _windowStartUs;
    if (elapsed >= RATE_WINDOW_US) {
        _rateHz = (uint32_t)(((uint64_t)_windowScans * RATE_WINDOW_US + elapsed / 2) / elapsed);
        _windowStartUs = nowUs;
        _windowScans = 0;
    }
    _windowScans++;
}

void Timing::scanEnd(uint32_t nowUs) {
    if (!_inScan) return;
    _inScan = false;
    uint32_t dur = nowUs - _lastStartUs;
    if (dur > _durMaxUs) _durMaxUs = dur;
    _durCount++;
    _durSumUs += dur;
}

void Timing::recordOp(Op op, uint32_t durationUs) {
    uint8_t i = (uint8_t)op;
    if (i >= OP_COUNT) return;
    _ops[i].lastUs = durationUs;
    if (durationUs > _ops[i].maxUs) _ops[i].maxUs = durationUs;
    _ops[i].count++;
}

uint32_t Timing::scanAvgTenthsUs() const {
    if (_durCount == 0) return 0;
    uint64_t tenths = (_durSumUs * 10u + _durCount / 2) / _durCount;
    return tenths > 0xFFFFFFFFu ? 0xFFFFFFFFu : (uint32_t)tenths;
}

Timing::OpStats Timing::op(Op o) const {
    uint8_t i = (uint8_t)o;
    if (i >= OP_COUNT) return OpStats{ 0, 0, 0 };
    return _ops[i];
}

const char* Timing::opName(Op o) {
    uint8_t i = (uint8_t)o;
    return i < OP_COUNT ? OP_NAMES[i] : "unknown";
}

void Timing::writeTimingFields(proto::JsonWriter& w, uint32_t uptimeMs, const proto::TxQueue* tx) const {
    char key[40];

    w.key("uptime_ms").u32(uptimeMs);
    w.key("period_us").u32(_periodUs);
    w.key("scans").u32(_scans);
    w.key("scan_hz").u32(_rateHz);
    w.key("max_gap_us").u32(_maxGapUs);
    w.key("missed_deadlines").u32(_missed);

    w.key("gap_hist_us").beginObject();
    for (uint8_t b = 0; b < GAP_BUCKETS - 1; ++b) {
        w.key(bucketKey(key, sizeof(key), "le_", GAP_BUCKET_LIMIT_US[b])).u32(_gapHist[b]);
    }
    w.key(bucketKey(key, sizeof(key), "gt_", GAP_BUCKET_LIMIT_US[GAP_BUCKETS - 2]))
     .u32(_gapHist[GAP_BUCKETS - 1]);
    w.endObject();

    w.key("scan_max_us").u32(_durMaxUs);
    w.key("scan_avg_us").scaled((int32_t)(scanAvgTenthsUs() & 0x7FFFFFFF), 1);

    for (uint8_t i = 0; i < OP_COUNT; ++i) {
        w.key(joinKey(key, sizeof(key), OP_NAMES[i], "_last_us")).u32(_ops[i].lastUs);
        w.key(joinKey(key, sizeof(key), OP_NAMES[i], "_max_us")).u32(_ops[i].maxUs);
        w.key(joinKey(key, sizeof(key), OP_NAMES[i], "_count")).u32(_ops[i].count);
    }

    if (tx != nullptr) {
        const proto::TxQueue::Stats& s = tx->stats();
        w.key("tx_queue_bytes").u32((uint32_t)proto::TX_QUEUE_BYTES);
        w.key("tx_used").u32((uint32_t)tx->used());
        w.key("tx_high_water").u32(s.highWater);
        w.key("tx_bytes_queued").u32(s.bytesQueued);
        w.key("tx_bytes_sent").u32(s.bytesSent);
        w.key("tx_events_dropped").u32(s.eventsDropped);
        w.key("tx_replies_rejected").u32(s.repliesRejected);
    }
}

void Timing::writeScanRateFields(proto::JsonWriter& w, bool consume) {
    w.key("hz").u32(_rateHz);
    w.key("max_gap_us").u32(_legacyMaxGapUs);
    if (consume) _legacyMaxGapUs = 0;
}
