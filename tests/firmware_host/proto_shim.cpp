// C ABI over the real protocol core (firmware/src/json_writer.cpp, line_reader.cpp, tx_queue.cpp,
// protocol.cpp, timing.cpp and include/build_info.h) for tests/test_protocol_core.py and
// tests/test_timing.py.
//
// Built with ONLY firmware/include on the include path (no Arduino stubs), which also proves the
// protocol core compiles without Arduino headers. Everything behavioural runs in the firmware
// sources; this file only adapts types, provides fakes (TX sink with controllable space, RX FIFO,
// clock) and a small command table shaped like the real one so the dispatcher, reply builder,
// deferral and scheduler can be driven from Python.
#include <cstdint>
#include <cstring>
#include <deque>
#include <string>
#include <vector>

#include "build_info.h"
#include "json_writer.h"
#include "line_reader.h"
#include "protocol.h"
#include "timing.h"
#include "tx_queue.h"

#if defined(_WIN32)
#define API extern "C" __declspec(dllexport)
#else
#define API extern "C" __attribute__((visibility("default")))
#endif

using namespace proto;

namespace {

uint32_t s_fakeUs = 0;
uint32_t fakeClock() { return s_fakeUs; }

int copyOut(const std::string& s, char* out, int cap) {
    if (out == nullptr || cap <= 0) return (int)s.size();
    int n = (int)s.size() < cap - 1 ? (int)s.size() : cap - 1;
    memcpy(out, s.data(), (size_t)n);
    out[n] = '\0';
    return (int)s.size();
}

// TX sink: reports `avail` bytes of space; counts any write larger than the space offered
struct FakeSink final : TxSink {
    int         avail = 0;
    int         shortWrite = -1;   // >= 0: accept at most this many bytes per write() call
    uint32_t    writes = 0;
    uint32_t    violations = 0;
    std::string out;

    int availableForWrite() override { return avail; }
    size_t write(const uint8_t* data, size_t len) override {
        writes++;
        if (avail < 0 || len > (size_t)avail) violations++;
        size_t n = len;
        if (shortWrite >= 0 && n > (size_t)shortWrite) n = (size_t)shortWrite;
        out.append(reinterpret_cast<const char*>(data), n);
        avail -= (int)n;
        return n;
    }
};

struct FifoRx final : RxSource {
    std::deque<uint8_t> bytes;
    int read() override {
        if (bytes.empty()) return -1;
        int b = bytes.front();
        bytes.pop_front();
        return b;
    }
};

} // namespace

// =============================================================================================
// JsonWriter
// =============================================================================================
// The writer gets `cap` bytes; 16 canary bytes (0xA5) follow to detect any overrun
constexpr size_t JW_CANARY = 16;
struct JwHandle {
    std::vector<char> buf;
    JsonWriter        w;
    explicit JwHandle(int cap)
        : buf((size_t)(cap > 0 ? cap : 0) + JW_CANARY, (char)0xA5), w(buf.data(), (size_t)(cap > 0 ? cap : 0)) {}
};

API JwHandle* jw_create(int capacity) { return new JwHandle(capacity); }
API void jw_destroy(JwHandle* h) { delete h; }
API void jw_reset(JwHandle* h) { h->w.reset(); }
API void jw_begin_object(JwHandle* h) { h->w.beginObject(); }
API void jw_end_object(JwHandle* h) { h->w.endObject(); }
API void jw_begin_array(JwHandle* h) { h->w.beginArray(); }
API void jw_end_array(JwHandle* h) { h->w.endArray(); }
API void jw_key(JwHandle* h, const char* k) { h->w.key(k); }
API void jw_str(JwHandle* h, const char* s) { h->w.str(s); }
API void jw_str_n(JwHandle* h, const char* s, int n) { h->w.str(s, (size_t)n); }
API void jw_bool(JwHandle* h, int v) { h->w.boolean(v != 0); }
API void jw_i32(JwHandle* h, int32_t v) { h->w.i32(v); }
API void jw_u32(JwHandle* h, uint32_t v) { h->w.u32(v); }
API void jw_mm(JwHandle* h, int32_t cmm) { h->w.mm(cmm); }
API void jw_scaled(JwHandle* h, int32_t v, int decimals) { h->w.scaled(v, (uint8_t)decimals); }
API void jw_fixed(JwHandle* h, float v, int decimals) { h->w.fixed(v, (uint8_t)decimals); }
API void jw_null(JwHandle* h) { h->w.null(); }
API void jw_raw(JwHandle* h, const char* json) { h->w.raw(json); }
API const char* jw_data(JwHandle* h) { return h->w.data(); }
API int jw_len(JwHandle* h) { return (int)h->w.length(); }
API int jw_ok(JwHandle* h) { return h->w.ok() ? 1 : 0; }
API int jw_overflow(JwHandle* h) { return h->w.overflow() ? 1 : 0; }
API int jw_misuse(JwHandle* h) { return h->w.misuse() ? 1 : 0; }
API int jw_complete(JwHandle* h) { return h->w.complete() ? 1 : 0; }
API int jw_depth(JwHandle* h) { return h->w.depth(); }
// Canary: the byte just past the capacity must never be written
API int jw_buffer_byte(JwHandle* h, int i) { return (unsigned char)h->buf[(size_t)i]; }

// =============================================================================================
// LineReader
// =============================================================================================
API LineReader* lr_create() { return new LineReader(); }
API void lr_destroy(LineReader* r) { delete r; }
API void lr_reset(LineReader* r) { r->reset(); }
API int lr_feed(LineReader* r, int byte) { return (int)r->feed((uint8_t)byte); }
API int lr_line(LineReader* r, char* out, int cap) {
    int n = r->length();
    if (n > cap) n = cap;
    memcpy(out, r->line(), (size_t)n);
    return r->length();
}
API int lr_max_len() { return limits::LINE_MAX_LEN; }
API void lr_stats(LineReader* r, uint32_t out[4]) {
    const LineReader::Stats& s = r->stats();
    out[0] = s.bytes; out[1] = s.lines; out[2] = s.overflows; out[3] = s.invalid;
}

// =============================================================================================
// Parsers
// =============================================================================================
API int p_uint(const char* text, uint32_t min, uint32_t max, uint32_t* out) {
    return (int)parseUint(text, min, max, *out);
}
API int p_cmm(const char* text, int min, int max, uint32_t* out) {
    uint16_t v = 0xFFFF;
    int r = (int)parseCmm(text, (uint16_t)min, (uint16_t)max, v);
    *out = v;
    return r;
}
API int p_bool(const char* text, int* out) {
    bool v = false;
    int r = (int)parseBool(text, v);
    *out = v ? 1 : 0;
    return r;
}
API int p_token(const char* text, char* out, int outSize) { return parseToken(text, out, (size_t)outSize) ? 1 : 0; }
API int p_keyword(const char* text, const char* kw) { return keywordIs(text, kw) ? 1 : 0; }
API int p_valid_id(const char* text, int len) { return isValidRequestId(text, (size_t)len) ? 1 : 0; }
API const char* p_result_code(int r) {
    const char* c = parseResultCode((ParseResult)r);
    return c != nullptr ? c : "";
}
API int err_count() { return err::COUNT; }
API const char* err_code(int i) { return (i >= 0 && i < err::COUNT) ? err::ALL[i] : ""; }

// =============================================================================================
// TxQueue
// =============================================================================================
struct TxHandle {
    TxQueue  q;
    FakeSink sink;
};

API TxHandle* tx_create() { return new TxHandle(); }
API void tx_destroy(TxHandle* h) { delete h; }
API int tx_capacity() { return (int)TX_QUEUE_BYTES; }
API int tx_max_reply_len() { return (int)MAX_REPLY_LEN; }
API int tx_enqueue(TxHandle* h, const char* data, int len, int priority) {
    return h->q.enqueue(data, (size_t)len, priority == 0 ? TxPriority::Reply : TxPriority::Event) ? 1 : 0;
}
API int tx_has_room(TxHandle* h) { return h->q.hasRoomForReply() ? 1 : 0; }
API int tx_used(TxHandle* h) { return (int)h->q.used(); }
API int tx_free(TxHandle* h) { return (int)h->q.freeSpace(); }
API int tx_mid_line(TxHandle* h) { return h->q.midLine() ? 1 : 0; }
API void tx_clear(TxHandle* h) { h->q.clear(); }
API void tx_reset_stats(TxHandle* h) { h->q.resetStats(); }
// Offers `avail` bytes of sink space (shortWrite >= 0 limits each write() call) and drains
API int tx_drain(TxHandle* h, int avail, int maxBytes, int shortWrite) {
    h->sink.avail = avail;
    h->sink.shortWrite = shortWrite;
    return (int)h->q.drain(h->sink, maxBytes < 0 ? (size_t)-1 : (size_t)maxBytes);
}
API int tx_take_output(TxHandle* h, char* out, int cap) {
    int n = copyOut(h->sink.out, out, cap);
    h->sink.out.clear();
    return n;
}
API int tx_output_len(TxHandle* h) { return (int)h->sink.out.size(); }
API uint32_t tx_sink_violations(TxHandle* h) { return h->sink.violations; }
API uint32_t tx_sink_writes(TxHandle* h) { return h->sink.writes; }
static void txStats(const TxQueue& q, uint32_t out[10]) {
    const TxQueue::Stats& s = q.stats();
    out[0] = s.bytesQueued; out[1] = s.bytesSent; out[2] = s.linesQueued; out[3] = s.repliesQueued;
    out[4] = s.eventsQueued; out[5] = s.eventsDropped; out[6] = s.repliesRejected;
    out[7] = s.linesInvalid; out[8] = s.bytesCleared; out[9] = s.highWater;
}
API void tx_stats(TxHandle* h, uint32_t out[10]) { txStats(h->q, out); }

// =============================================================================================
// Dispatcher session: LineReader + Dispatcher + CommandScheduler + TxQueue + Timing, with a
// command table shaped like the firmware's (fixed arg counts, aliases, a deferred command)
// =============================================================================================
struct Session;

namespace {

enum DeferMode { DEFER_WAIT = 0, DEFER_OK = 1, DEFER_ERROR = 2, DEFER_SILENT = 3 };

struct SessionCtx {
    int      deferMode = DEFER_WAIT;
    uint32_t handlerCalls = 0;
    Timing*  timing = nullptr;
    TxQueue* tx = nullptr;
};

HandlerResult hPing(const Args&, Reply& r, void* ctx) {
    static_cast<SessionCtx*>(ctx)->handlerCalls++;
    r.ok().key("type").str("pong");
    return HandlerResult::Done;
}

HandlerResult hEcho(const Args& a, Reply& r, void* ctx) {
    static_cast<SessionCtx*>(ctx)->handlerCalls++;
    JsonWriter& w = r.ok();
    w.key("argc").u32(a.count);
    w.key("args").beginArray();
    for (uint8_t i = 0; i < a.count; ++i) w.str(a[i]);
    w.endArray();
    return HandlerResult::Done;
}

HandlerResult hCmm(const Args& a, Reply& r, void* ctx) {
    static_cast<SessionCtx*>(ctx)->handlerCalls++;
    uint16_t cmm = 0;
    ParseResult pr = parseCmm(a[0], limits::ACTUATION_MIN_CMM, limits::ACTUATION_MAX_CMM, cmm);
    if (pr != ParseResult::Ok) {
        r.error(pr, "actuation must be 0.25..3.80 mm")
         .key("min").mm(limits::ACTUATION_MIN_CMM)
         .key("max").mm(limits::ACTUATION_MAX_CMM);
        return HandlerResult::Done;
    }
    r.ok().key("actuation").mm(cmm);
    return HandlerResult::Done;
}

HandlerResult hUint(const Args& a, Reply& r, void* ctx) {
    static_cast<SessionCtx*>(ctx)->handlerCalls++;
    uint32_t v = 0;
    ParseResult pr = parseUint(a[0], 0, limits::CODE_MAX, v);
    if (pr != ParseResult::Ok) {
        r.error(pr, "code must be 0..255");
        return HandlerResult::Done;
    }
    r.ok().key("code").u32(v);
    return HandlerResult::Done;
}

HandlerResult hBool(const Args& a, Reply& r, void* ctx) {
    static_cast<SessionCtx*>(ctx)->handlerCalls++;
    bool v = false;
    ParseResult pr = parseBool(a[0], v);
    if (pr != ParseResult::Ok) {
        r.error(pr, "expected 0|1|on|off|true|false");
        return HandlerResult::Done;
    }
    r.ok().key("value").boolean(v);
    return HandlerResult::Done;
}

HandlerResult hLabel(const Args& a, Reply& r, void* ctx) {
    static_cast<SessionCtx*>(ctx)->handlerCalls++;
    char label[limits::LABEL_MAX_LEN + 1];
    if (!parseToken(a[0], label, sizeof(label))) {
        r.error(err::INVALID_LABEL, "label must be 1..4 characters");
        return HandlerResult::Done;
    }
    r.ok().key("label").str(label);
    return HandlerResult::Done;
}

HandlerResult hFail(const Args&, Reply& r, void* ctx) {
    static_cast<SessionCtx*>(ctx)->handlerCalls++;
    r.error(err::NOT_ALLOWED, "refused \"on purpose\"").key("detail").str("tab\there");
    return HandlerResult::Done;
}

bool pollDefer(Reply& r, void* ctx) {
    SessionCtx* c = static_cast<SessionCtx*>(ctx);
    switch (c->deferMode) {
        case DEFER_OK:
            r.ok().key("devices").beginArray().u32(60).endArray();
            return true;
        case DEFER_ERROR:
            r.error(err::BUSY, "display busy");
            return true;
        case DEFER_SILENT:
            return true;   // claims done without writing: dispatcher must still answer once
        default:
            r.ok().key("partial").boolean(true);   // written but not done: must be discarded
            return false;
    }
}

HandlerResult hDefer(const Args& a, Reply& r, void* ctx) {
    static_cast<SessionCtx*>(ctx)->handlerCalls++;
    uint32_t timeoutMs = 500;
    if (a.count == 1 && parseUint(a[0], 1, 60000, timeoutMs) != ParseResult::Ok) {
        r.error(err::BAD_NUMBER, "timeout");
        return HandlerResult::Done;
    }
    return r.defer(pollDefer, ctx, timeoutMs, err::DISPLAY_TIMEOUT, "display did not answer");
}

// ok() then defer(): the deferral wins (last call)
HandlerResult hDeferAfterOk(const Args&, Reply& r, void* ctx) {
    static_cast<SessionCtx*>(ctx)->handlerCalls++;
    r.ok().key("ignored").boolean(true);
    return r.defer(pollDefer, ctx, 500, err::DISPLAY_TIMEOUT, "display did not answer");
}

// defer() then ok(): the ok reply wins and nothing stays pending, whatever the handler returns
HandlerResult hDeferThenOk(const Args&, Reply& r, void* ctx) {
    static_cast<SessionCtx*>(ctx)->handlerCalls++;
    r.defer(pollDefer, ctx, 500, err::DISPLAY_TIMEOUT, "display did not answer");
    r.ok().key("immediate").boolean(true);
    return HandlerResult::Deferred;   // deliberately inconsistent return value
}

HandlerResult hSilent(const Args&, Reply&, void* ctx) {
    static_cast<SessionCtx*>(ctx)->handlerCalls++;
    return HandlerResult::Done;
}

HandlerResult hBig(const Args& a, Reply& r, void* ctx) {
    static_cast<SessionCtx*>(ctx)->handlerCalls++;
    uint32_t n = 0;
    parseUint(a[0], 0, 100000, n);
    JsonWriter& w = r.ok();
    w.key("items").beginArray();
    for (uint32_t i = 0; i < n; ++i) w.str("0123456789");
    w.endArray();
    return HandlerResult::Done;
}

HandlerResult hOpen(const Args&, Reply& r, void* ctx) {
    static_cast<SessionCtx*>(ctx)->handlerCalls++;
    r.ok().key("list").beginArray().u32(1);   // forgot endArray()
    return HandlerResult::Done;
}

// Same shape the firmware's TIMING / SCAN_RATE handlers will have
HandlerResult hTiming(const Args& a, Reply& r, void* ctx) {
    SessionCtx* c = static_cast<SessionCtx*>(ctx);
    c->handlerCalls++;
    if (a.count == 1) {
        if (!keywordIs(a[0], "RESET")) {
            r.error(err::BAD_ARGUMENTS, "expected TIMING [RESET]");
            return HandlerResult::Done;
        }
    }
    JsonWriter& w = r.ok();
    w.key("type").str("timing");
    c->timing->writeTimingFields(w, 1234, c->tx);
    if (a.count == 1) {
        c->timing->reset();
        w.key("reset").boolean(true);
    }
    return HandlerResult::Done;
}

HandlerResult hScanRate(const Args&, Reply& r, void* ctx) {
    SessionCtx* c = static_cast<SessionCtx*>(ctx);
    c->handlerCalls++;
    JsonWriter& w = r.ok();
    w.key("type").str("scan_rate");
    c->timing->writeScanRateFields(w);
    return HandlerResult::Done;
}

const CommandDef TEST_TABLE[] = {
    { "PING",          nullptr,        0, 0, hPing },
    { "INFO",          "HELLO",        0, 0, hPing },
    { "ECHO",          nullptr,        0, 6, hEcho },
    { "SET_ACTUATION", nullptr,        1, 1, hCmm },
    { "CODE",          nullptr,        1, 1, hUint },
    { "SET_RT_ENABLE", nullptr,        1, 1, hBool },
    { "LABEL",         nullptr,        1, 1, hLabel },
    { "SET_HID",       "HID|OUTPUT",   1, 2, hEcho },
    { "SET_KEY",       nullptr,        3, 4, hEcho },
    { "FAIL",          nullptr,        0, 0, hFail },
    { "OLED_SCAN",     nullptr,        0, 1, hDefer },
    { "DEFER_AFTER_OK", nullptr,       0, 0, hDeferAfterOk },
    { "DEFER_THEN_OK", nullptr,        0, 0, hDeferThenOk },
    { "SILENT",        nullptr,        0, 0, hSilent },
    { "BIG",           nullptr,        1, 1, hBig },
    { "OPEN",          nullptr,        0, 0, hOpen },
    { "TIMING",        nullptr,        0, 1, hTiming },
    { "SCAN_RATE",     nullptr,        0, 0, hScanRate },
};

// Deliberately broken tables for tableValid()
const CommandDef BAD_DUP_ALIAS[] = {
    { "PING", nullptr, 0, 0, hPing },
    { "INFO", "PING",  0, 0, hPing },
};
const CommandDef BAD_LOWER[] = { { "ping", nullptr, 0, 0, hPing } };
const CommandDef BAD_ARGS[]  = { { "PING", nullptr, 2, 1, hPing } };
const CommandDef BAD_MAX[]   = { { "PING", nullptr, 0, MAX_ARGS + 1, hPing } };
const CommandDef BAD_NULL[]  = { { "PING", nullptr, 0, 0, nullptr } };
const CommandDef BAD_SELF[]  = { { "PING", "P|P", 0, 0, hPing } };

} // namespace

struct Session {
    SessionCtx       ctx;
    TxQueue          tx;
    LineReader       reader;
    Timing           timing;
    Dispatcher       disp;
    CommandScheduler sched;
    FakeSink         sink;
    FifoRx           rx;
    char             eventBuf[MAX_EVENT_LEN];
    EventWriter      events;

    Session()
        : timing(1000, fakeClock),
          disp(TEST_TABLE, (uint8_t)(sizeof(TEST_TABLE) / sizeof(TEST_TABLE[0])), tx, &ctx),
          sched(reader, disp, tx, &timing),
          events(eventBuf, sizeof(eventBuf)) {
        ctx.timing = &timing;
        ctx.tx = &tx;
    }
};

API Session* ss_create() { return new Session(); }
API void ss_destroy(Session* s) { delete s; }
API void ss_set_clock_us(uint32_t us) { s_fakeUs = us; }
API void ss_rx_push(Session* s, const char* data, int n) {
    for (int i = 0; i < n; ++i) s->rx.bytes.push_back((uint8_t)data[i]);
}
API int ss_rx_pending(Session* s) { return (int)s->rx.bytes.size(); }
API int ss_step(Session* s, uint32_t nowMs, int maxBytes) {
    return s->sched.step(s->rx, nowMs, (uint16_t)(maxBytes > 0 ? maxBytes : RX_BYTES_PER_STEP)) ? 1 : 0;
}
API void ss_service(Session* s, uint32_t nowMs) { s->disp.service(nowMs); }
// Direct dispatch of one line (bypasses the reader and the room check)
API void ss_handle(Session* s, const char* text, int event, uint32_t nowMs) {
    char line[limits::LINE_MAX_LEN + 1];
    size_t n = strlen(text);
    if (n > limits::LINE_MAX_LEN) n = limits::LINE_MAX_LEN;
    memcpy(line, text, n);
    line[n] = '\0';
    s->disp.handle((LineReader::Event)event, line, (uint16_t)n, nowMs);
}
API int ss_drain(Session* s, int avail, int maxBytes) {
    s->sink.avail = avail;
    s->sink.shortWrite = -1;
    return (int)s->tx.drain(s->sink, maxBytes < 0 ? (size_t)-1 : (size_t)maxBytes);
}
API int ss_take_output(Session* s, char* out, int cap) {
    int n = copyOut(s->sink.out, out, cap);
    s->sink.out.clear();
    return n;
}
API int ss_output_len(Session* s) { return (int)s->sink.out.size(); }
API uint32_t ss_sink_violations(Session* s) { return s->sink.violations; }
API void ss_set_defer_mode(Session* s, int mode) { s->ctx.deferMode = mode; }
API int ss_deferred_pending(Session* s) { return s->disp.deferredPending() ? 1 : 0; }
API uint32_t ss_handler_calls(Session* s) { return s->ctx.handlerCalls; }
API int ss_has_room(Session* s) { return s->tx.hasRoomForReply() ? 1 : 0; }
API int ss_tx_used(Session* s) { return (int)s->tx.used(); }
API void ss_tx_stats(Session* s, uint32_t out[10]) { txStats(s->tx, out); }
API void ss_stats(Session* s, uint32_t out[11]) {
    const Dispatcher::Stats& d = s->disp.stats();
    out[0] = d.requests; out[1] = d.repliesOk; out[2] = d.repliesError; out[3] = d.unknownCommands;
    out[4] = d.rejectedLines; out[5] = d.deferred; out[6] = d.deferredCompleted;
    out[7] = d.deferredTimeouts; out[8] = d.handlerNoReply; out[9] = d.replyOverflows;
    out[10] = d.repliesLost;
}
API int ss_find(Session* s, const char* verb, char* out, int cap) {
    const CommandDef* d = s->disp.find(verb);
    if (d == nullptr) return 0;
    copyOut(d->verb, out, cap);
    return 1;
}
API int ss_table_valid(Session* s) { return s->disp.tableValid() ? 1 : 0; }
API int ss_bad_table_valid(int which) {
    TxQueue* tx = new TxQueue();
    const CommandDef* t = nullptr;
    uint8_t n = 0;
    switch (which) {
        case 0: t = BAD_DUP_ALIAS; n = 2; break;
        case 1: t = BAD_LOWER; n = 1; break;
        case 2: t = BAD_ARGS; n = 1; break;
        case 3: t = BAD_MAX; n = 1; break;
        case 4: t = BAD_NULL; n = 1; break;
        case 5: t = BAD_SELF; n = 1; break;
        default: break;
    }
    Dispatcher* d = new Dispatcher(t, n, *tx, nullptr);
    int ok = d->tableValid() ? 1 : 0;
    delete d;
    delete tx;
    return ok;
}
API void ss_command_op(Session* s, uint32_t out[3]) {
    Timing::OpStats o = s->timing.op(Timing::Op::Command);
    out[0] = o.lastUs; out[1] = o.maxUs; out[2] = o.count;
}
API void ss_scan(Session* s, uint32_t us) { s->timing.scanBegin(us); s->timing.scanEnd(us + 10); }
// Queues one event of roughly `payload` bytes; returns 1 when queued
API int ss_event(Session* s, const char* type, int payload) {
    JsonWriter& w = s->events.begin(type);
    w.key("seq").u32(s->tx.stats().eventsQueued + s->tx.stats().eventsDropped);
    std::string pad((size_t)(payload > 0 ? payload : 0), 'x');
    w.key("pad").str(pad.c_str());
    return s->events.send(s->tx) ? 1 : 0;
}
API int ss_event_with_status(Session* s) {
    s->events.begin("log").key("status").str("ok");
    return s->events.send(s->tx) ? 1 : 0;
}
API int ss_event_unclosed(Session* s) {
    s->events.begin("log").key("list").beginArray();
    return s->events.send(s->tx) ? 1 : 0;
}
API uint32_t ss_event_malformed(Session* s) { return s->events.malformed(); }

// =============================================================================================
// Timing
// =============================================================================================
API Timing* tm_create(uint32_t periodUs) { return new Timing(periodUs, fakeClock); }
API Timing* tm_create_no_clock(uint32_t periodUs) { return new Timing(periodUs); }
API void tm_destroy(Timing* t) { delete t; }
API void tm_set_clock(uint32_t us) { s_fakeUs = us; }
API uint32_t tm_now(Timing* t) { return t->now(); }
API void tm_scan_begin(Timing* t, uint32_t us) { t->scanBegin(us); }
API void tm_scan_end(Timing* t, uint32_t us) { t->scanEnd(us); }
API void tm_scan_begin_clock(Timing* t) { t->scanBegin(); }
API void tm_scan_end_clock(Timing* t) { t->scanEnd(); }
API void tm_record_op(Timing* t, int op, uint32_t us) { t->recordOp((Timing::Op)op, us); }
// Runs a Timing::Scoped for `op` while the fake clock advances by `us`
API void tm_scoped(Timing* t, int op, uint32_t us) {
    Timing::Scoped scope(*t, (Timing::Op)op);
    s_fakeUs += us;
}
API void tm_reset(Timing* t) { t->reset(); }
API int tm_op_count() { return Timing::OP_COUNT; }
API const char* tm_op_name(int op) { return Timing::opName((Timing::Op)op); }
API int tm_gap_buckets() { return Timing::GAP_BUCKETS; }
API uint32_t tm_gap_limit(int i) { return (i >= 0 && i < Timing::GAP_BUCKETS - 1) ? Timing::GAP_BUCKET_LIMIT_US[i] : 0; }
// scans, rateHz, maxGap, missed, scanMax, durations, avgTenths, hist[7]
API void tm_get(Timing* t, uint32_t out[14]) {
    out[0] = t->scans(); out[1] = t->scanRateHz(); out[2] = t->maxGapUs(); out[3] = t->missedDeadlines();
    out[4] = t->scanMaxUs(); out[5] = t->scanDurations(); out[6] = t->scanAvgTenthsUs();
    for (uint8_t i = 0; i < Timing::GAP_BUCKETS; ++i) out[7 + i] = t->gapBucket(i);
}
API void tm_op(Timing* t, int op, uint32_t out[3]) {
    Timing::OpStats o = t->op((Timing::Op)op);
    out[0] = o.lastUs; out[1] = o.maxUs; out[2] = o.count;
}
// {"type":"timing",...fields} into `out`; with a TxQueue carrying the given traffic when withTx
API int tm_json(Timing* t, uint32_t uptimeMs, int withTx, char* out, int cap) {
    TxQueue* tx = nullptr;
    if (withTx) {
        tx = new TxQueue();
        tx->enqueue("{\"a\":1}", 7, TxPriority::Reply);
    }
    std::vector<char> buf((size_t)MAX_REPLY_LEN + 1);
    JsonWriter w(buf.data(), buf.size());
    w.beginObject().key("type").str("timing");
    t->writeTimingFields(w, uptimeMs, tx);
    w.endObject();
    delete tx;
    if (!w.complete()) return -1;
    return copyOut(std::string(w.data(), w.length()), out, cap);
}
API int tm_scan_rate_json(Timing* t, int consume, char* out, int cap) {
    char buf[256];
    JsonWriter w(buf, sizeof(buf));
    w.beginObject().key("type").str("scan_rate");
    t->writeScanRateFields(w, consume != 0);
    w.endObject();
    if (!w.complete()) return -1;
    return copyOut(std::string(w.data(), w.length()), out, cap);
}

// =============================================================================================
// build_info.h
// =============================================================================================
API const char* bi_fw_version() { return build_info::FW_VERSION; }
API const char* bi_build_id() { return build_info::BUILD_ID; }
API const char* bi_build_date() { return build_info::BUILD_DATE; }
API int bi_protocol() { return build_info::PROTOCOL; }
API int bi_protocol_macro() { return DRIFTPAD_PROTOCOL_VERSION; }
API const char* bi_fw_version_macro() { return DRIFTPAD_FW_VERSION; }
API const char* bi_device() { return build_info::DEVICE; }
API const char* bi_hardware() { return build_info::HARDWARE; }
