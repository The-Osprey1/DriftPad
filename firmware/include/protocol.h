#ifndef PROTOCOL_H
#define PROTOCOL_H

#include <cstddef>
#include <cstdint>
#include "settings_limits.h"
#include "json_writer.h"
#include "line_reader.h"
#include "tx_queue.h"
#include "timing.h"

/**
 * @file protocol.h
 * @brief Serial protocol v2 core: request parsing, strict value parsers, command dispatch and
 *        the reply/event builders (contract section 2).
 *
 * Request line: [@<id> ]<VERB>[ <arg>...]
 * - <id>: 1..12 of [A-Za-z0-9_-], echoed as "id". Anything else after '@' -> bad_request.
 * - VERB is matched case-insensitively against the command table (canonical name or alias).
 * - Arguments are separated by one or more spaces; the table's minArgs..maxArgs is enforced
 *   before the handler runs (bad_arguments).
 *
 * Every line the LineReader reports (Line, Overflow, Invalid) gets exactly one reply line:
 *   {"status":"ok"|"error","id":"<id>"(if given),"cmd":"<CANONICAL>"|"", ...}
 * Handlers start the reply with ok() or error() and append data fields to the returned writer.
 * A handler that writes nothing, or whose reply does not fit MAX_REPLY_LEN, still produces one
 * reply: error "unsupported" with msg "handler produced no reply" / "reply too long" (these are
 * firmware bugs; tests assert they never happen for the real command table).
 *
 * Deferred replies: a handler returns reply.defer(poll, ctx, timeoutMs, code, msg) (the
 * deferral token HandlerResult::Deferred). The dispatcher then calls poll(reply, ctx) from
 * service() whenever the TX queue has room for a reply; poll writes ok()/error() and returns true
 * when the result is there. If it has not answered within timeoutMs, the dispatcher replies with
 * the handler-provided error. One deferral can be pending; a second one gets "busy" at once.
 *
 * Events (unsolicited lines) never carry "status"; EventWriter builds them with a "type" first.
 *
 * Number formats: see parseUint/parseCmm/parseBool. Leading zeros are accepted ("007" = 7,
 * "01.50" = 1.50 mm): the parser is decimal only, so they cannot be misread as octal.
 *
 * Core 0 only. No heap, no Arduino String. Reply text lives in the Dispatcher's own buffer.
 */
namespace proto {

// ---------------------------------------------------------------------------------------------
// Error codes (contract section 2)
// ---------------------------------------------------------------------------------------------
namespace err {
inline constexpr const char* UNKNOWN_COMMAND        = "unknown_command";
inline constexpr const char* BAD_REQUEST            = "bad_request";
inline constexpr const char* BAD_ARGUMENTS          = "bad_arguments";
inline constexpr const char* BAD_NUMBER             = "bad_number";
inline constexpr const char* OUT_OF_RANGE           = "out_of_range";
inline constexpr const char* INVALID_LABEL          = "invalid_label";
inline constexpr const char* INVALID_CODE           = "invalid_code";
inline constexpr const char* BUSY                   = "busy";
inline constexpr const char* NOT_ALLOWED            = "not_allowed";
inline constexpr const char* CALIBRATION_REQUIRED   = "calibration_required";
inline constexpr const char* CALIBRATION_INCOMPLETE = "calibration_incomplete";
inline constexpr const char* KEYS_NOT_AT_REST       = "keys_not_at_rest";
inline constexpr const char* LINE_TOO_LONG          = "line_too_long";
inline constexpr const char* FLASH_ERROR            = "flash_error";
inline constexpr const char* FLASH_VERIFY_FAILED    = "flash_verify_failed";
inline constexpr const char* DISPLAY_TIMEOUT        = "display_timeout";
inline constexpr const char* UNSUPPORTED            = "unsupported";

constexpr uint8_t COUNT = 17;
extern const char* const ALL[COUNT];   // every code above, in contract order
} // namespace err

constexpr uint8_t MAX_ARGS = 6;              // stored arguments per request (SET_KEY needs 4)
constexpr uint16_t RX_BYTES_PER_STEP = 64;   // RX bytes consumed per scheduler step at most
constexpr size_t MAX_EVENT_LEN = 1024;       // suggested event buffer size (telemetry, raw chunk)

// ---------------------------------------------------------------------------------------------
// Strict value parsers
// ---------------------------------------------------------------------------------------------
enum class ParseResult : uint8_t {
    Ok = 0,
    BadNumber,    // not in the accepted syntax -> "bad_number"
    OutOfRange,   // valid syntax, value outside [min, max] (incl. overflow) -> "out_of_range"
};
const char* parseResultCode(ParseResult r);   // nullptr for Ok

// Decimal digits only: no sign, space, hex, exponent or separator. Values that overflow 32 bits
// are OutOfRange (the syntax is valid), never wrapped.
ParseResult parseUint(const char* text, uint32_t min, uint32_t max, uint32_t& out);

// Millimetres to centi-millimetres: digits[.d[d]] -> "1" = 100, "1.2" = 120, "1.25" = 125.
// Rejected (BadNumber): "", ".5", "1.", "1.234" (more than 2 decimals), "-1", "+1", "1e2",
// "0x1", "1,5", "nan", "inf", any leading/trailing junk.
ParseResult parseCmm(const char* text, uint16_t minCmm, uint16_t maxCmm, uint16_t& out);

// "0"/"1", or case-insensitive "on"/"off"/"true"/"false". Other digit strings -> OutOfRange,
// anything else -> BadNumber.
ParseResult parseBool(const char* text, bool& out);

// Copies a raw token (e.g. a label; normalisation belongs to config). False when empty or when
// it does not fit `outSize` including the terminator.
bool parseToken(const char* text, char* out, size_t outSize);

// ASCII case-insensitive keyword comparison ("off", "ALL", "force", "reset", ...)
bool keywordIs(const char* text, const char* keyword);

// 1..REQUEST_ID_MAX_LEN of [A-Za-z0-9_-]
bool isValidRequestId(const char* text, size_t len);

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------
struct Args {
    uint8_t     count;          // arguments after the verb (all of them, even beyond MAX_ARGS)
    const char* v[MAX_ARGS];
    const char* operator[](uint8_t i) const { return (i < count && i < MAX_ARGS) ? v[i] : ""; }
};

enum class HandlerResult : uint8_t {
    Done = 0,    // the reply was written (ok() or error())
    Deferred,    // returned by Reply::defer(): the reply follows from service()
};

class Reply;
class Dispatcher;

using Handler = HandlerResult (*)(const Args& args, Reply& reply, void* ctx);
// Called from Dispatcher::service() while a deferred request is pending. Writes ok()/error()
// and returns true once the result is available; returns false to keep waiting.
using DeferredPoll = bool (*)(Reply& reply, void* ctx);

struct CommandDef {
    const char* verb;      // canonical, upper case, echoed as "cmd"
    const char* aliases;   // '|'-separated upper-case aliases ("HID|OUTPUT") or nullptr
    uint8_t     minArgs;
    uint8_t     maxArgs;   // <= MAX_ARGS
    Handler     handler;
};

class Reply {
public:
    // Starts (or restarts) an ok reply: {"status":"ok","id":..,"cmd":..
    JsonWriter& ok();
    // Starts (or restarts) an error reply: {"status":"error","id":..,"cmd":..,"code":..,"msg":..
    // Extra fields may follow. Anything written before is discarded.
    JsonWriter& error(const char* code, const char* msg);
    JsonWriter& error(ParseResult r, const char* msg) { return error(parseResultCode(r), msg); }

    // The writer after ok()/error(), to append data fields
    JsonWriter& w() { return _w; }

    // Defers the reply (see file comment). `timeoutCode`/`timeoutMsg` must be string literals.
    // Returns Deferred, or Done after writing "busy" when another deferral is pending.
    // A later ok()/error() in the same handler cancels the deferral.
    HandlerResult defer(DeferredPoll poll, void* pollCtx, uint32_t timeoutMs,
                        const char* timeoutCode, const char* timeoutMsg);

    const char* cmd() const { return _cmd; }    // canonical verb, "" when unknown
    const char* id() const { return _id; }      // "" when the request had none
    bool hasId() const { return _id[0] != '\0'; }
    bool started() const { return _state != State::Empty; }
    bool isError() const { return _state == State::Error; }

private:
    friend class Dispatcher;
    enum class State : uint8_t { Empty = 0, Ok, Error };

    Reply(Dispatcher& owner, char* buffer, size_t capacity);
    void begin(const char* cmd, const char* id, size_t idLen);
    void header(const char* status);

    Dispatcher&  _owner;
    JsonWriter   _w;
    const char*  _cmd;
    char         _id[limits::REQUEST_ID_MAX_LEN + 1];
    State        _state;

    bool         _deferRequested;
    DeferredPoll _deferPoll;
    void*        _deferCtx;
    uint32_t     _deferTimeoutMs;
    const char*  _deferCode;
    const char*  _deferMsg;
};

class Dispatcher {
public:
    struct Stats {
        uint32_t requests;           // lines that needed a reply (incl. rejected lines)
        uint32_t repliesOk;
        uint32_t repliesError;
        uint32_t unknownCommands;
        uint32_t rejectedLines;      // line_too_long + control-byte lines
        uint32_t deferred;
        uint32_t deferredCompleted;
        uint32_t deferredTimeouts;
        uint32_t handlerNoReply;     // firmware bug guard
        uint32_t replyOverflows;     // firmware bug guard
        uint32_t repliesLost;        // TX refused a reply (caller skipped hasRoomForReply())
    };

    Dispatcher(const CommandDef* table, uint8_t count, TxQueue& tx, void* ctx = nullptr);

    // Answers one LineReader event (Line, Overflow or Invalid; None is ignored). `line` is
    // tokenised in place. Exactly one reply is queued, or one deferral registered.
    void handle(LineReader::Event ev, char* line, uint16_t len, uint32_t nowMs);

    // Completes or times out a pending deferred reply. Does nothing unless the TX queue has room
    // for a reply. Call every loop (CommandScheduler::step does).
    void service(uint32_t nowMs);

    // Drop a reply owned by a disconnected serial session; no response is sent to the next host.
    void cancelDeferred() { _pending.active = false; }

    bool deferredPending() const { return _pending.active; }
    const char* deferredCmd() const { return _pending.active ? _pending.cmd : ""; }

    // Canonical entry for a verb or alias (case-insensitive), nullptr if unknown
    const CommandDef* find(const char* verb) const;
    // Table sanity: upper-case names from [A-Z0-9_], no duplicate verb/alias, minArgs <= maxArgs
    // <= MAX_ARGS, handler set. For a unit test / startup assert.
    bool tableValid() const;

    const Stats& stats() const { return _stats; }

private:
    friend class Reply;

    struct Pending {
        bool         active;
        const char*  cmd;
        char         id[limits::REQUEST_ID_MAX_LEN + 1];
        DeferredPoll poll;
        void*        ctx;
        uint32_t     startMs;
        uint32_t     timeoutMs;
        const char*  code;
        const char*  msg;
    };

    void handleLine(char* line, uint16_t len);
    void rejectLine(LineReader::Event ev, const char* line, uint16_t len);
    void finishHandler(HandlerResult result);
    void send();

    const CommandDef* _table;
    uint8_t           _count;
    TxQueue&          _tx;
    void*             _ctx;
    uint32_t          _nowMs;
    Pending           _pending;
    Stats             _stats;
    char              _replyBuf[MAX_REPLY_LEN + 1];
    Reply             _reply;
};

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------
class EventWriter {
public:
    EventWriter(char* buffer, size_t capacity) : _w(buffer, capacity), _malformed(0) {}

    // Resets and opens {"type":"<type>" ; append fields to the returned writer
    JsonWriter& begin(const char* type);
    JsonWriter& w() { return _w; }

    // Closes the object and queues it at Event priority. False when it was dropped for space
    // (counted by the TxQueue) or malformed (overflowed, left open, or carrying a "status" key;
    // counted here).
    bool send(TxQueue& tx);
    uint32_t malformed() const { return _malformed; }

private:
    JsonWriter _w;
    uint32_t   _malformed;
};

// ---------------------------------------------------------------------------------------------
// Scheduling helper
// ---------------------------------------------------------------------------------------------
class RxSource {
public:
    virtual int read() = 0;   // next received byte, or -1 when none is waiting
protected:
    ~RxSource() = default;
};

// One background slice of serial work, called once per loop iteration when no scan is due:
//   1. service(): a deferred reply that is ready (or timed out) is queued, if TX has room;
//   2. if TX has room for a maximum reply, read up to maxBytes RX bytes into the LineReader and
//      stop at the first line event; that one line is dispatched (timed as Timing::Op::Command).
// So at most one command runs per call, and a command is only parsed when its reply fits.
// Unread bytes stay in the USB FIFO (host flow control). Returns true if a line was handled.
class CommandScheduler {
public:
    CommandScheduler(LineReader& reader, Dispatcher& dispatcher, TxQueue& tx, Timing* timing = nullptr)
        : _reader(reader), _dispatcher(dispatcher), _tx(tx), _timing(timing) {}

    bool step(RxSource& rx, uint32_t nowMs, uint16_t maxBytes = RX_BYTES_PER_STEP);

private:
    LineReader& _reader;
    Dispatcher& _dispatcher;
    TxQueue&    _tx;
    Timing*     _timing;
};

} // namespace proto

#endif // PROTOCOL_H
