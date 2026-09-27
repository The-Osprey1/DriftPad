#include "protocol.h"

#include <cstring>

namespace proto {

namespace err {
const char* const ALL[COUNT] = {
    UNKNOWN_COMMAND, BAD_REQUEST, BAD_ARGUMENTS, BAD_NUMBER, OUT_OF_RANGE, INVALID_LABEL,
    INVALID_CODE, BUSY, NOT_ALLOWED, CALIBRATION_REQUIRED, CALIBRATION_INCOMPLETE,
    KEYS_NOT_AT_REST, LINE_TOO_LONG, FLASH_ERROR, FLASH_VERIFY_FAILED, DISPLAY_TIMEOUT,
    UNSUPPORTED,
};
} // namespace err

namespace {

inline bool isDigit(char c) { return c >= '0' && c <= '9'; }

inline char upper(char c) { return (c >= 'a' && c <= 'z') ? (char)(c - 'a' + 'A') : c; }

inline bool isIdChar(char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || isDigit(c) || c == '_' || c == '-';
}

inline bool isNameChar(char c) {
    return (c >= 'A' && c <= 'Z') || isDigit(c) || c == '_';
}

// Case-insensitive compare of `text` against `name[0..nameLen)`
bool matchesIgnoreCase(const char* text, const char* name, size_t nameLen) {
    for (size_t i = 0; i < nameLen; ++i) {
        if (text[i] == '\0' || upper(text[i]) != upper(name[i])) return false;
    }
    return text[nameLen] == '\0';
}

// True if `text` equals the verb or one of the '|'-separated aliases
bool matchesCommand(const CommandDef& def, const char* text) {
    if (def.verb != nullptr && matchesIgnoreCase(text, def.verb, strlen(def.verb))) return true;
    const char* a = def.aliases;
    while (a != nullptr && *a != '\0') {
        const char* bar = strchr(a, '|');
        size_t n = bar != nullptr ? (size_t)(bar - a) : strlen(a);
        if (n > 0 && matchesIgnoreCase(text, a, n)) return true;
        a = bar != nullptr ? bar + 1 : nullptr;
    }
    return false;
}

bool validName(const char* s, size_t n) {
    if (s == nullptr || n == 0) return false;
    for (size_t i = 0; i < n; ++i) {
        if (!isNameChar(s[i])) return false;
    }
    return true;
}

// Splits off the next space-separated token in place. Returns nullptr at the end of the line.
char* nextToken(char*& p) {
    while (*p == ' ') ++p;
    if (*p == '\0') return nullptr;
    char* start = p;
    while (*p != '\0' && *p != ' ') ++p;
    if (*p == ' ') *p++ = '\0';
    return start;
}

// Finds a well-formed "@id" at the start of a rejected line so its error can still be correlated.
// The id must end with a space inside the kept bytes: a token that runs into the end of an
// over-long line's buffer was cut short and is not the request's id.
size_t extractId(const char* line, uint16_t len, const char*& idStart) {
    uint16_t i = 0;
    while (i < len && line[i] == ' ') ++i;
    if (i >= len || line[i] != '@') return 0;
    uint16_t start = ++i;
    while (i < len && line[i] != ' ') ++i;
    if (i >= len) return 0;
    size_t n = (size_t)(i - start);
    if (!isValidRequestId(line + start, n)) return 0;
    idStart = line + start;
    return n;
}

} // namespace

// ---------------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------------
const char* parseResultCode(ParseResult r) {
    switch (r) {
        case ParseResult::BadNumber:  return err::BAD_NUMBER;
        case ParseResult::OutOfRange: return err::OUT_OF_RANGE;
        default:                      return nullptr;
    }
}

ParseResult parseUint(const char* text, uint32_t min, uint32_t max, uint32_t& out) {
    if (text == nullptr || *text == '\0') return ParseResult::BadNumber;
    uint32_t value = 0;
    bool overflow = false;
    for (const char* p = text; *p != '\0'; ++p) {
        if (!isDigit(*p)) return ParseResult::BadNumber;
        uint32_t d = (uint32_t)(*p - '0');
        if (value > (0xFFFFFFFFu - d) / 10u) overflow = true;   // keep scanning: junk still wins
        else value = value * 10u + d;
    }
    if (overflow || value < min || value > max) return ParseResult::OutOfRange;
    out = value;
    return ParseResult::Ok;
}

ParseResult parseCmm(const char* text, uint16_t minCmm, uint16_t maxCmm, uint16_t& out) {
    if (text == nullptr || !isDigit(*text)) return ParseResult::BadNumber;

    const char* p = text;
    uint32_t whole = 0;
    bool overflow = false;
    while (isDigit(*p)) {
        // whole * 100 + 99 must fit 32 bits, so whole may never exceed 42949671: test the value
        // it would take, not the value it has (checking first let 429496719 through and wrap)
        const uint32_t d = (uint32_t)(*p - '0');
        if (overflow || whole > (42949671u - d) / 10u) overflow = true;
        else whole = whole * 10u + d;
        ++p;
    }

    uint32_t frac = 0;
    if (*p == '.') {
        ++p;
        if (!isDigit(p[0])) return ParseResult::BadNumber;               // "1."
        frac = (uint32_t)(p[0] - '0') * 10u;
        ++p;
        if (isDigit(*p)) {
            frac += (uint32_t)(*p - '0');
            ++p;
        }
        if (isDigit(*p)) return ParseResult::BadNumber;                  // more than 2 decimals
    }
    if (*p != '\0') return ParseResult::BadNumber;

    if (overflow) return ParseResult::OutOfRange;
    uint32_t cmm = whole * 100u + frac;
    if (cmm < minCmm || cmm > maxCmm) return ParseResult::OutOfRange;
    out = (uint16_t)cmm;
    return ParseResult::Ok;
}

ParseResult parseBool(const char* text, bool& out) {
    if (text == nullptr || *text == '\0') return ParseResult::BadNumber;
    if (strcmp(text, "1") == 0 || keywordIs(text, "on") || keywordIs(text, "true")) {
        out = true;
        return ParseResult::Ok;
    }
    if (strcmp(text, "0") == 0 || keywordIs(text, "off") || keywordIs(text, "false")) {
        out = false;
        return ParseResult::Ok;
    }
    for (const char* p = text; *p != '\0'; ++p) {
        if (!isDigit(*p)) return ParseResult::BadNumber;
    }
    return ParseResult::OutOfRange;   // "2", "00", "10"
}

bool parseToken(const char* text, char* out, size_t outSize) {
    if (text == nullptr || out == nullptr || outSize == 0) return false;
    size_t n = strlen(text);
    if (n == 0 || n + 1 > outSize) {
        out[0] = '\0';
        return false;
    }
    memcpy(out, text, n + 1);
    return true;
}

bool keywordIs(const char* text, const char* keyword) {
    if (text == nullptr || keyword == nullptr) return false;
    return matchesIgnoreCase(text, keyword, strlen(keyword));
}

bool isValidRequestId(const char* text, size_t len) {
    if (text == nullptr || len == 0 || len > limits::REQUEST_ID_MAX_LEN) return false;
    for (size_t i = 0; i < len; ++i) {
        if (!isIdChar(text[i])) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------------------------
// Reply
// ---------------------------------------------------------------------------------------------
Reply::Reply(Dispatcher& owner, char* buffer, size_t capacity)
    : _owner(owner), _w(buffer, capacity), _cmd(""), _state(State::Empty),
      _deferRequested(false), _deferPoll(nullptr), _deferCtx(nullptr), _deferTimeoutMs(0),
      _deferCode(nullptr), _deferMsg(nullptr) {
    _id[0] = '\0';
}

void Reply::begin(const char* cmd, const char* id, size_t idLen) {
    _w.reset();
    _cmd = cmd != nullptr ? cmd : "";
    if (idLen > limits::REQUEST_ID_MAX_LEN) idLen = 0;
    if (id != nullptr && idLen > 0) memcpy(_id, id, idLen);
    _id[idLen] = '\0';
    _state = State::Empty;
    _deferRequested = false;
}

void Reply::header(const char* status) {
    _w.reset();
    _deferRequested = false;
    _w.beginObject();
    _w.key("status").str(status);
    if (hasId()) _w.key("id").str(_id);
    _w.key("cmd").str(_cmd);
}

JsonWriter& Reply::ok() {
    header("ok");
    _state = State::Ok;
    return _w;
}

JsonWriter& Reply::error(const char* code, const char* msg) {
    header("error");
    _w.key("code").str(code != nullptr ? code : err::UNSUPPORTED);
    _w.key("msg").str(msg != nullptr ? msg : "");
    _state = State::Error;
    return _w;
}

HandlerResult Reply::defer(DeferredPoll poll, void* pollCtx, uint32_t timeoutMs,
                           const char* timeoutCode, const char* timeoutMsg) {
    if (_owner._pending.active) {
        error(err::BUSY, "another deferred request is pending").key("pending").str(_owner._pending.cmd);
        return HandlerResult::Done;
    }
    if (poll == nullptr) {
        error(err::UNSUPPORTED, "deferred without a poll function");
        return HandlerResult::Done;
    }
    _w.reset();
    _state = State::Empty;
    _deferRequested = true;
    _deferPoll = poll;
    _deferCtx = pollCtx;
    _deferTimeoutMs = timeoutMs;
    _deferCode = timeoutCode != nullptr ? timeoutCode : err::UNSUPPORTED;
    _deferMsg = timeoutMsg != nullptr ? timeoutMsg : "timed out";
    return HandlerResult::Deferred;
}

// ---------------------------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------------------------
Dispatcher::Dispatcher(const CommandDef* table, uint8_t count, TxQueue& tx, void* ctx)
    : _table(table), _count(table != nullptr ? count : 0), _tx(tx), _ctx(ctx), _nowMs(0),
      _pending{}, _stats{}, _reply(*this, _replyBuf, sizeof(_replyBuf)) {
    _replyBuf[0] = '\0';
}

const CommandDef* Dispatcher::find(const char* verb) const {
    if (verb == nullptr) return nullptr;
    for (uint8_t i = 0; i < _count; ++i) {
        if (matchesCommand(_table[i], verb)) return &_table[i];
    }
    return nullptr;
}

bool Dispatcher::tableValid() const {
    for (uint8_t i = 0; i < _count; ++i) {
        const CommandDef& d = _table[i];
        if (d.handler == nullptr || d.minArgs > d.maxArgs || d.maxArgs > MAX_ARGS) return false;
        if (d.verb == nullptr || !validName(d.verb, strlen(d.verb))) return false;

        // Every name of this entry (verb + aliases) must be well formed and unique in the table
        constexpr uint8_t MAX_NAMES = 8;
        const char* names[MAX_NAMES];
        size_t lens[MAX_NAMES];
        uint8_t n = 0;
        names[n] = d.verb;
        lens[n++] = strlen(d.verb);
        for (const char* a = d.aliases; a != nullptr && *a != '\0';) {
            const char* bar = strchr(a, '|');
            size_t len = bar != nullptr ? (size_t)(bar - a) : strlen(a);
            if (!validName(a, len) || n >= MAX_NAMES) return false;
            names[n] = a;
            lens[n++] = len;
            a = bar != nullptr ? bar + 1 : nullptr;
        }
        for (uint8_t k = 0; k < n; ++k) {
            char name[32];
            if (lens[k] >= sizeof(name)) return false;
            memcpy(name, names[k], lens[k]);
            name[lens[k]] = '\0';
            if (find(name) != &d) return false;   // an earlier entry owns this name
            for (uint8_t j = (uint8_t)(i + 1); j < _count; ++j) {
                if (matchesCommand(_table[j], name)) return false;
            }
            for (uint8_t m = 0; m < k; ++m) {
                if (lens[m] == lens[k] && memcmp(names[m], names[k], lens[k]) == 0) return false;
            }
        }
    }
    return true;
}

void Dispatcher::handle(LineReader::Event ev, char* line, uint16_t len, uint32_t nowMs) {
    _nowMs = nowMs;
    switch (ev) {
        case LineReader::Event::Line:     handleLine(line, len); break;
        case LineReader::Event::Overflow:
        case LineReader::Event::Invalid:  rejectLine(ev, line, len); break;
        default: break;
    }
}

void Dispatcher::rejectLine(LineReader::Event ev, const char* line, uint16_t len) {
    const char* id = nullptr;
    size_t idLen = line != nullptr ? extractId(line, len, id) : 0;
    _stats.requests++;
    _stats.rejectedLines++;
    _reply.begin("", id, idLen);
    if (ev == LineReader::Event::Overflow) {
        _reply.error(err::LINE_TOO_LONG, "line longer than the maximum; discarded")
              .key("max").u32(limits::LINE_MAX_LEN);
    } else {
        _reply.error(err::BAD_REQUEST, "control character in line; discarded");
    }
    send();
}

void Dispatcher::handleLine(char* line, uint16_t len) {
    if (line == nullptr) return;
    line[len] = '\0';
    char* p = line;
    char* tok = nextToken(p);
    if (tok == nullptr) return;   // blank line: no reply (the LineReader never reports these)

    _stats.requests++;
    _reply.begin("", nullptr, 0);

    if (tok[0] == '@') {
        size_t idLen = strlen(tok + 1);
        if (!isValidRequestId(tok + 1, idLen)) {
            _reply.error(err::BAD_REQUEST, "request id must be 1-12 of A-Z a-z 0-9 _ -");
            send();
            return;
        }
        _reply.begin("", tok + 1, idLen);
        tok = nextToken(p);
        if (tok == nullptr) {
            _reply.error(err::BAD_REQUEST, "missing command");
            send();
            return;
        }
    }

    const CommandDef* def = find(tok);
    if (def == nullptr) {
        _stats.unknownCommands++;
        _reply.error(err::UNKNOWN_COMMAND, "unknown command");
        send();
        return;
    }
    _reply._cmd = def->verb;

    Args args;
    args.count = 0;
    for (char* a = nextToken(p); a != nullptr; a = nextToken(p)) {
        if (args.count < MAX_ARGS) args.v[args.count] = a;
        if (args.count < 0xFF) args.count++;
    }
    for (uint8_t i = args.count; i < MAX_ARGS; ++i) args.v[i] = "";

    if (args.count < def->minArgs || args.count > def->maxArgs) {
        _reply.error(err::BAD_ARGUMENTS, "wrong number of arguments")
              .key("min_args").u32(def->minArgs)
              .key("max_args").u32(def->maxArgs);
        send();
        return;
    }

    finishHandler(def->handler(args, _reply, _ctx));
}

void Dispatcher::finishHandler(HandlerResult result) {
    (void)result;   // the Reply's own state is authoritative (defer() may have answered "busy")
    if (_reply._deferRequested) {
        _pending.active = true;
        _pending.cmd = _reply._cmd;
        memcpy(_pending.id, _reply._id, sizeof(_pending.id));
        _pending.poll = _reply._deferPoll;
        _pending.ctx = _reply._deferCtx;
        _pending.startMs = _nowMs;
        _pending.timeoutMs = _reply._deferTimeoutMs;
        _pending.code = _reply._deferCode;
        _pending.msg = _reply._deferMsg;
        _reply._deferRequested = false;
        _stats.deferred++;
        return;
    }
    if (!_reply.started()) {
        _stats.handlerNoReply++;
        _reply.error(err::UNSUPPORTED, "handler produced no reply");
    }
    send();
}

void Dispatcher::service(uint32_t nowMs) {
    _nowMs = nowMs;
    if (!_pending.active || !_tx.hasRoomForReply()) return;

    _reply.begin(_pending.cmd, _pending.id, strlen(_pending.id));
    bool done = _pending.poll(_reply, _pending.ctx);
    _reply._deferRequested = false;   // a poll cannot defer again
    if (done) {
        if (!_reply.started()) {
            _stats.handlerNoReply++;
            _reply.error(err::UNSUPPORTED, "handler produced no reply");
        }
        _pending.active = false;
        _stats.deferredCompleted++;
        send();
        return;
    }
    if ((uint32_t)(nowMs - _pending.startMs) >= _pending.timeoutMs) {
        _reply.begin(_pending.cmd, _pending.id, strlen(_pending.id));
        _reply.error(_pending.code, _pending.msg).key("timeout_ms").u32(_pending.timeoutMs);
        _pending.active = false;
        _stats.deferredTimeouts++;
        send();
    }
}

void Dispatcher::send() {
    JsonWriter& w = _reply._w;
    w.endObject();
    if (!w.complete()) {
        // Too long for MAX_REPLY_LEN or left a container open: still answer, as an error
        _stats.replyOverflows++;
        bool tooLong = w.overflow();
        _reply.error(err::UNSUPPORTED, tooLong ? "reply too long" : "reply malformed");
        w.endObject();
    }
    if (_reply.isError()) _stats.repliesError++;
    else _stats.repliesOk++;
    if (!_tx.enqueue(w.data(), w.length(), TxPriority::Reply)) _stats.repliesLost++;
    _reply._state = Reply::State::Empty;
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------
JsonWriter& EventWriter::begin(const char* type) {
    _w.reset();
    _w.beginObject();
    _w.key("type").str(type != nullptr ? type : "log");
    return _w;
}

bool EventWriter::send(TxQueue& tx) {
    _w.endObject();
    if (!_w.complete() || strstr(_w.data(), "\"status\":") != nullptr) {
        _malformed++;
        return false;
    }
    return tx.enqueue(_w.data(), _w.length(), TxPriority::Event);
}

// ---------------------------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------------------------
bool CommandScheduler::step(RxSource& rx, uint32_t nowMs, uint16_t maxBytes) {
    _dispatcher.service(nowMs);
    if (!_tx.hasRoomForReply()) return false;   // leave requests in the USB FIFO until it drains

    for (uint16_t i = 0; i < maxBytes; ++i) {
        int b = rx.read();
        if (b < 0) break;
        LineReader::Event ev = _reader.feed((uint8_t)b);
        if (ev == LineReader::Event::None) continue;

        if (_timing != nullptr) {
            Timing::Scoped t(*_timing, Timing::Op::Command);
            _dispatcher.handle(ev, _reader.line(), _reader.length(), nowMs);
        } else {
            _dispatcher.handle(ev, _reader.line(), _reader.length(), nowMs);
        }
        return true;
    }
    return false;
}

} // namespace proto
