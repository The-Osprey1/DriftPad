"""
test_protocol_core.py - Serial protocol v2 core: line assembly, request ids, dispatch, strict value
parsers, JSON writer, TX queue, deferred replies and the command-table check.

Scope: production C++ executed on the host. tests/firmware_host/proto_lib.py compiles, unmodified,
  firmware/src/line_reader.cpp   request line assembly (line_reader.h)
  firmware/src/protocol.cpp      ids, parsers, Dispatcher, Reply, EventWriter, CommandScheduler
  firmware/src/json_writer.cpp   reply/event JSON (json_writer.h)
  firmware/src/tx_queue.cpp      bounded output ring (tx_queue.h)
  firmware/src/timing.cpp        linked for the TIMING handler (covered by test_timing.py)
with tests/firmware_host/proto_shim.cpp, a C ABI whose only behaviour is fakes: a TX sink with
controllable space, an RX FIFO, a fake clock and a small command table shaped like the firmware's
(fixed argument counts, aliases, a deferred command, handlers that misbehave on purpose).

Assertions are on the bytes that leave the TX queue: every reply and event line is parsed with
json.loads. The header comments are the specification, so a failing test here means the production
code disagrees with its own contract.

Pure Python standard library + a host C++ compiler (see tests/host_build.py). Without a compiler
the suite is skipped through host_build's SkipTest.
"""

import collections
import ctypes
import json
import random
import re
import sys
import unittest
from pathlib import Path
from typing import Dict, List, Optional, Tuple

TESTS_DIR = Path(__file__).resolve().parent
HOST_DIR = TESTS_DIR / "firmware_host"
for _p in (TESTS_DIR, HOST_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import proto_lib  # noqa: E402

# LineReader::Event
EV_NONE, EV_LINE, EV_OVERFLOW, EV_INVALID = 0, 1, 2, 3
EV_NAMES = {EV_NONE: "None", EV_LINE: "Line", EV_OVERFLOW: "Overflow", EV_INVALID: "Invalid"}

# ParseResult
PR_OK, PR_BAD_NUMBER, PR_OUT_OF_RANGE = 0, 1, 2
PR_NAMES = {PR_OK: "Ok", PR_BAD_NUMBER: "BadNumber", PR_OUT_OF_RANGE: "OutOfRange"}

# Poll behaviour of the shim's deferred command (proto_shim.cpp DeferMode)
DEFER_WAIT, DEFER_OK, DEFER_ERROR, DEFER_SILENT = 0, 1, 2, 3

# settings_limits.h
LINE_MAX_LEN = 160
REQUEST_ID_MAX_LEN = 12
ACTUATION_MIN_CMM, ACTUATION_MAX_CMM = 25, 380
MAX_EVENT_LEN = 1024   # protocol.h; the shim's event buffer has this size

# protocol.h err::, in contract order
ERROR_CODES = (
    "unknown_command", "bad_request", "bad_arguments", "bad_number", "out_of_range",
    "invalid_label", "invalid_code", "busy", "not_allowed", "calibration_required",
    "calibration_incomplete", "keys_not_at_rest", "line_too_long", "flash_error",
    "flash_verify_failed", "display_timeout", "unsupported",
)

M32 = 0xFFFFFFFF


# =============================================================================================
# Output parsing
# =============================================================================================
def _unique_keys(pairs):
    keys = [k for k, _ in pairs]
    dups = sorted({k for k in keys if keys.count(k) > 1})
    if dups:
        raise ValueError(f"duplicate JSON keys {dups}")
    return dict(pairs)


def parse_json(raw: bytes):
    """json.loads on one device line: ASCII only, no duplicate keys, no raw control bytes."""
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError:
        raise AssertionError(f"non-ASCII byte in device output: {raw[:200]!r}")
    try:
        return json.loads(text, object_pairs_hook=_unique_keys)
    except ValueError as e:
        raise AssertionError(f"device output is not valid JSON ({e}): {raw[:300]!r}")


def parse_lines(data: bytes) -> List[dict]:
    """Splits TX output into '\\n'-terminated lines and parses each one as a JSON object."""
    if not data:
        return []
    if not data.endswith(b"\n"):
        raise AssertionError(f"TX output ends in the middle of a line: ...{data[-80:]!r}")
    objs = []
    for raw in data[:-1].split(b"\n"):
        obj = parse_json(raw)
        if not isinstance(obj, dict):
            raise AssertionError(f"device line is not a JSON object: {raw[:200]!r}")
        objs.append(obj)
    return objs


def envelope_problems(obj: dict) -> List[str]:
    """Checks a reply against the envelope in protocol.h:
    {"status":"ok"|"error","id":"<id>"(if given),"cmd":"<CANONICAL>"|"", ...}; errors carry code+msg."""
    problems = []
    keys = list(obj)
    if not keys or keys[0] != "status":
        problems.append("status is not the first key")
    if obj.get("status") not in ("ok", "error"):
        problems.append(f"status is {obj.get('status')!r}")
    expected_order = ["status", "id", "cmd"] if "id" in obj else ["status", "cmd"]
    if keys[:len(expected_order)] != expected_order:
        problems.append(f"key order {keys[:3]} != {expected_order}")
    if not isinstance(obj.get("cmd"), str):
        problems.append("cmd missing or not a string")
    if obj.get("status") == "error":
        if obj.get("code") not in ERROR_CODES:
            problems.append(f"unknown error code {obj.get('code')!r}")
        if not isinstance(obj.get("msg"), str):
            problems.append("error without msg")
    return problems


# =============================================================================================
# Thin wrappers over the shim handles
# =============================================================================================
class Session:
    """LineReader + Dispatcher + CommandScheduler + TxQueue + Timing from the shim, with a fake sink."""

    STATS = ("requests", "replies_ok", "replies_error", "unknown_commands", "rejected_lines",
             "deferred", "deferred_completed", "deferred_timeouts", "handler_no_reply",
             "reply_overflows", "replies_lost")

    def __init__(self, lib):
        self.lib = lib
        self.h = lib.ss_create()

    def close(self):
        if self.h:
            self.lib.ss_destroy(self.h)
            self.h = None

    # Direct dispatch (bypasses the reader and the scheduler's room check)
    def handle(self, text: bytes, event: int = EV_LINE, now_ms: int = 0):
        self.lib.ss_handle(self.h, text, event, now_ms & M32)

    def service(self, now_ms: int):
        self.lib.ss_service(self.h, now_ms & M32)

    # Through the RX FIFO and CommandScheduler::step
    def push(self, data: bytes):
        self.lib.ss_rx_push(self.h, data, len(data))

    def rx_pending(self) -> int:
        return self.lib.ss_rx_pending(self.h)

    def step(self, now_ms: int = 0, max_bytes: int = 0) -> bool:
        return bool(self.lib.ss_step(self.h, now_ms & M32, max_bytes))

    def run(self, data: bytes, now_ms: int = 0, max_bytes: int = 0) -> List[dict]:
        """Feeds `data` through the scheduler, draining after every step; returns the parsed output."""
        self.push(data)
        steps = 0
        while self.rx_pending():
            self.step(now_ms, max_bytes)
            self.drain()
            steps += 1
            if steps > len(data) + 16:
                raise AssertionError("CommandScheduler stopped consuming the RX FIFO")
        return self.lines()

    # TX side
    def drain(self, avail: int = 1 << 20, max_bytes: int = -1) -> int:
        return self.lib.ss_drain(self.h, avail, max_bytes)

    def take(self) -> bytes:
        n = self.lib.ss_output_len(self.h)
        buf = ctypes.create_string_buffer(n + 1)
        got = self.lib.ss_take_output(self.h, buf, n + 1)
        return buf.raw[:got]

    def lines(self) -> List[dict]:
        """Drains the TX queue completely and parses every line."""
        self.drain()
        return parse_lines(self.take())

    def has_room(self) -> bool:
        return bool(self.lib.ss_has_room(self.h))

    def tx_used(self) -> int:
        return self.lib.ss_tx_used(self.h)

    def sink_violations(self) -> int:
        return self.lib.ss_sink_violations(self.h)

    # Handlers / deferral
    def set_defer_mode(self, mode: int):
        self.lib.ss_set_defer_mode(self.h, mode)

    def deferred_pending(self) -> bool:
        return bool(self.lib.ss_deferred_pending(self.h))

    def handler_calls(self) -> int:
        return self.lib.ss_handler_calls(self.h)

    def event(self, type_: bytes, payload: int) -> bool:
        return bool(self.lib.ss_event(self.h, type_, payload))

    def stats(self) -> Dict[str, int]:
        out = proto_lib.u32_array(len(self.STATS))
        self.lib.ss_stats(self.h, out)
        return dict(zip(self.STATS, out))

    def tx_stats(self) -> Dict[str, int]:
        out = proto_lib.u32_array(len(TxQueueHandle.STATS))
        self.lib.ss_tx_stats(self.h, out)
        return dict(zip(TxQueueHandle.STATS, out))

    def find(self, verb: bytes) -> Optional[str]:
        buf = ctypes.create_string_buffer(64)
        if not self.lib.ss_find(self.h, verb, buf, len(buf)):
            return None
        return buf.value.decode("ascii")


class ReaderHandle:
    """A bare LineReader."""

    def __init__(self, lib):
        self.lib = lib
        self.h = lib.lr_create()
        self._buf = ctypes.create_string_buffer(LINE_MAX_LEN + 64)
        self.longest_reported = 0

    def close(self):
        if self.h:
            self.lib.lr_destroy(self.h)
            self.h = None

    def feed(self, data: bytes) -> List[Tuple[int, bytes]]:
        """Feeds every byte; returns (event, line bytes) for each non-None event."""
        events = []
        for b in data:
            ev = self.lib.lr_feed(self.h, b)
            if ev != EV_NONE:
                n = self.lib.lr_line(self.h, self._buf, len(self._buf))
                self.longest_reported = max(self.longest_reported, n)
                events.append((ev, self._buf.raw[:n]))
        return events

    def reset(self):
        self.lib.lr_reset(self.h)

    def stats(self) -> Dict[str, int]:
        out = proto_lib.u32_array(4)
        self.lib.lr_stats(self.h, out)
        return dict(zip(("bytes", "lines", "overflows", "invalid"), out))


class TxQueueHandle:
    """A bare TxQueue with the shim's fake sink."""

    STATS = ("bytes_queued", "bytes_sent", "lines_queued", "replies_queued", "events_queued",
             "events_dropped", "replies_rejected", "lines_invalid", "bytes_cleared", "high_water")

    def __init__(self, lib):
        self.lib = lib
        self.h = lib.tx_create()

    def close(self):
        if self.h:
            self.lib.tx_destroy(self.h)
            self.h = None

    def enqueue(self, line: bytes, reply: bool = True) -> bool:
        return bool(self.lib.tx_enqueue(self.h, line, len(line), 0 if reply else 1))

    def has_room(self) -> bool:
        return bool(self.lib.tx_has_room(self.h))

    def used(self) -> int:
        return self.lib.tx_used(self.h)

    def free(self) -> int:
        return self.lib.tx_free(self.h)

    def mid_line(self) -> bool:
        return bool(self.lib.tx_mid_line(self.h))

    def clear(self):
        self.lib.tx_clear(self.h)

    def reset_stats(self):
        self.lib.tx_reset_stats(self.h)

    def drain(self, avail: int, max_bytes: int = -1, short_write: int = -1) -> int:
        return self.lib.tx_drain(self.h, avail, max_bytes, short_write)

    def take(self) -> bytes:
        n = self.lib.tx_output_len(self.h)
        buf = ctypes.create_string_buffer(n + 1)
        got = self.lib.tx_take_output(self.h, buf, n + 1)
        return buf.raw[:got]

    def violations(self) -> int:
        return self.lib.tx_sink_violations(self.h)

    def writes(self) -> int:
        return self.lib.tx_sink_writes(self.h)

    def stats(self) -> Dict[str, int]:
        out = proto_lib.u32_array(len(self.STATS))
        self.lib.tx_stats(self.h, out)
        return dict(zip(self.STATS, out))


def tx_line(tag: int, n: int) -> bytes:
    """A recognisable line of exactly n bytes (no terminator)."""
    body = b"%d:" % tag + b"abcdefghijklmnopqrstuvwxyz" * (n // 26 + 2)
    return body[:n]


def reference_line_events(data: bytes, max_len: int = LINE_MAX_LEN) -> List[Tuple[int, bytes]]:
    """line_reader.h as a Python model: (event, first max_len bytes of the line) per reported line."""
    events = []
    buf = bytearray()
    overflow = invalid = non_space = False
    for b in data:
        if b in (0x0A, 0x0D):
            if overflow:
                events.append((EV_OVERFLOW, bytes(buf)))
            elif invalid:
                events.append((EV_INVALID, bytes(buf)))
            elif non_space:
                events.append((EV_LINE, bytes(buf)))
            buf.clear()
            overflow = invalid = non_space = False
            continue
        if b < 0x20 or b == 0x7F:
            invalid = True
        if b != 0x20:
            non_space = True
        if len(buf) < max_len:
            buf.append(b)
        else:
            overflow = True
    return events


# =============================================================================================
# Base class
# =============================================================================================
class ProtoTestCase(unittest.TestCase):
    lib = None

    @classmethod
    def setUpClass(cls):
        cls.lib = proto_lib.load()   # unittest.SkipTest when no host compiler exists

    def new_session(self) -> Session:
        s = Session(self.lib)
        self.addCleanup(s.close)
        return s

    def new_reader(self) -> ReaderHandle:
        r = ReaderHandle(self.lib)
        self.addCleanup(r.close)
        return r

    def new_tx(self) -> TxQueueHandle:
        q = TxQueueHandle(self.lib)
        self.addCleanup(q.close)
        return q

    def assertReply(self, obj: dict, status: str, cmd: str, code: Optional[str] = None,
                    rid: Optional[str] = None):
        """Envelope + expected status/cmd/code/id of one reply."""
        problems = envelope_problems(obj)
        self.assertEqual(problems, [], f"malformed reply {obj}")
        self.assertEqual(obj["status"], status, f"status of {obj}")
        self.assertEqual(obj["cmd"], cmd, f"cmd of {obj}")
        if rid is None:
            self.assertNotIn("id", obj, f"reply must not carry an id: {obj}")
        else:
            self.assertEqual(obj.get("id"), rid, f"id of {obj}")
        if status == "error":
            self.assertEqual(obj.get("code"), code, f"error code of {obj}")

    def one_reply(self, s: Session, text: bytes, now_ms: int = 0) -> dict:
        """Dispatches one line directly and returns its single reply."""
        s.handle(text, EV_LINE, now_ms)
        replies = s.lines()
        self.assertEqual(len(replies), 1, f"{text!r} must produce exactly one reply, got {replies}")
        return replies[0]


# =============================================================================================
# 1. LineReader
# =============================================================================================
class LineReaderTests(ProtoTestCase):

    def test_limit_matches_settings_limits(self):
        self.assertEqual(self.lib.lr_max_len(), LINE_MAX_LEN)

    def test_lf_cr_and_crlf_each_end_exactly_one_line(self):
        r = self.new_reader()
        for term in (b"\n", b"\r", b"\r\n"):
            self.assertEqual(r.feed(b"PING" + term), [(EV_LINE, b"PING")], f"terminator {term!r}")
        self.assertEqual(r.feed(b"A\r\nB\rC\nD\r\n"),
                         [(EV_LINE, b"A"), (EV_LINE, b"B"), (EV_LINE, b"C"), (EV_LINE, b"D")])
        self.assertEqual(r.stats()["lines"], 7)

        s = self.new_session()
        replies = s.run(b"@a PING\r\n@b PING\r@c PING\n")
        self.assertEqual([x.get("id") for x in replies], ["a", "b", "c"],
                         "CRLF must count as one terminator, not produce an extra reply")

    def test_empty_and_space_only_lines_are_ignored(self):
        r = self.new_reader()
        for blank in (b"\n", b"\r", b"\r\n", b"   \n", b" \r\n", b"\n\n\r\r"):
            self.assertEqual(r.feed(blank), [], f"{blank!r} must not report a line")
        self.assertEqual(r.stats()["lines"], 0)

        s = self.new_session()
        self.assertEqual(s.run(b"\n\r\n   \r\n \n\r"), [], "blank lines must get no reply")
        self.assertEqual(s.stats()["requests"], 0)
        self.assertEqual(s.handler_calls(), 0)
        replies = s.run(b"PING\n")
        self.assertEqual(len(replies), 1, "the reader must stay in sync after blank lines")
        self.assertReply(replies[0], "ok", "PING")

    def test_line_of_exactly_line_max_len_is_accepted(self):
        line = b"ECHO " + b"a" * (LINE_MAX_LEN - 5)
        self.assertEqual(len(line), LINE_MAX_LEN)
        r = self.new_reader()
        self.assertEqual(r.feed(line + b"\n"), [(EV_LINE, line)])

        s = self.new_session()
        replies = s.run(line + b"\n")
        self.assertEqual(len(replies), 1)
        self.assertReply(replies[0], "ok", "ECHO")
        self.assertEqual(replies[0]["args"], ["a" * (LINE_MAX_LEN - 5)])

    def test_line_of_line_max_len_plus_one_overflows_and_the_next_line_works(self):
        line = b"ECHO " + b"a" * (LINE_MAX_LEN - 4)
        self.assertEqual(len(line), LINE_MAX_LEN + 1)
        r = self.new_reader()
        self.assertEqual(r.feed(line + b"\n"), [(EV_OVERFLOW, line[:LINE_MAX_LEN])],
                         "the buffer keeps the first LINE_MAX_LEN bytes of an over-long line")
        self.assertEqual(r.feed(b"PING\n"), [(EV_LINE, b"PING")])
        self.assertEqual(r.stats()["overflows"], 1)

        s = self.new_session()
        replies = s.run(line + b"\nPING\n")
        self.assertEqual(len(replies), 2, replies)
        self.assertReply(replies[0], "error", "", "line_too_long")
        self.assertEqual(replies[0]["max"], LINE_MAX_LEN)
        self.assertReply(replies[1], "ok", "PING")

    def test_overlong_line_is_never_truncated_and_executed(self):
        # Each line's first 160 bytes are a valid request: truncation would execute it.
        cases = [
            b"PING" + b" " * 196,
            b"SET_ACTUATION 1.20" + b" " * 182,
            b"@ov ECHO " + b"b" * 191,
            b"OLED_SCAN" + b" " * 300,
        ]
        s = self.new_session()
        for line in cases:
            with self.subTest(line=line[:24]):
                self.assertGreater(len(line), LINE_MAX_LEN)
                calls = s.handler_calls()
                replies = s.run(line + b"\n")
                self.assertEqual(len(replies), 1, replies)
                self.assertEqual(replies[0]["code"], "line_too_long", replies[0])
                self.assertEqual(replies[0]["cmd"], "")
                self.assertEqual(s.handler_calls(), calls, "an over-long line reached a handler")
                self.assertFalse(s.deferred_pending())

    def test_control_bytes_make_the_line_invalid(self):
        s = self.new_session()
        r = self.new_reader()
        for ctl in (0x00, 0x01, 0x08, 0x09, 0x1B, 0x1F, 0x7F):
            line = b"PI" + bytes([ctl]) + b"NG"
            with self.subTest(byte=hex(ctl)):
                self.assertEqual(r.feed(line + b"\n"), [(EV_INVALID, line)])
                calls = s.handler_calls()
                replies = s.run(line + b"\n")
                self.assertEqual(len(replies), 1, replies)
                self.assertReply(replies[0], "error", "", "bad_request")
                self.assertEqual(s.handler_calls(), calls, "a line with a control byte was executed")
        # A control byte among spaces is not an empty line
        self.assertEqual(r.feed(b"  \x00  \n"), [(EV_INVALID, b"  \x00  ")])
        self.assertEqual(r.feed(b"\x01\r"), [(EV_INVALID, b"\x01")])

    def test_bytes_from_0x80_are_stored_and_escaped_on_output(self):
        r = self.new_reader()
        self.assertEqual(r.feed(b"ECHO \xc3\xa9\xff\n"), [(EV_LINE, b"ECHO \xc3\xa9\xff")])
        s = self.new_session()
        replies = s.run(b"ECHO \xc3\xa9\xff\n")
        self.assertReply(replies[0], "ok", "ECHO")
        self.assertEqual(replies[0]["args"], ["Ã©ÿ"])

    def test_line_split_across_single_byte_feeds(self):
        stream = b"@s1 SET_ACTUATION 1.25\r\n@s2 hid on\n  @s3   ECHO  x  y \r"
        whole = self.new_session().run(stream)

        s = self.new_session()
        out = []
        for b in stream:
            s.push(bytes([b]))
            s.step(0, 1)
            out += s.lines()
        self.assertEqual(out, whole)
        self.assertEqual([x["id"] for x in out], ["s1", "s2", "s3"])
        self.assertEqual(out[0]["actuation"], 1.25)
        self.assertEqual(out[1]["cmd"], "SET_HID")
        self.assertEqual(out[2]["args"], ["x", "y"])

    def test_reset_drops_a_partial_line(self):
        r = self.new_reader()
        self.assertEqual(r.feed(b"GARBAGE WITHOUT END"), [])
        r.reset()
        self.assertEqual(r.feed(b"PING\n"), [(EV_LINE, b"PING")])

    @staticmethod
    def _fuzz_stream(rng: random.Random, total: int) -> bytes:
        printable = bytes(range(0x21, 0x7F))

        def pick() -> int:
            x = rng.random()
            if x < 0.002:
                return rng.choice(b"\x00\x01\x07\x09\x1b\x1f\x7f")
            if x < 0.05:
                return rng.randrange(0x80, 0x100)
            if x < 0.22:
                return 0x20
            return rng.choice(printable)

        out = bytearray()
        while len(out) < total:
            if rng.random() < 0.35:
                # Uniform noise: terminators every ~128 bytes, control bytes everywhere
                out += bytes(rng.randrange(256) for _ in range(rng.randrange(1, 400)))
            else:
                n = rng.choice((0, 1, 2, rng.randrange(3, 150), rng.randrange(150, 172),
                                LINE_MAX_LEN, LINE_MAX_LEN + 1, rng.randrange(172, 600)))
                out += bytes(pick() for _ in range(n))
                out += rng.choice((b"\n", b"\r", b"\r\n", b"\n\r"))
        return bytes(out)

    def test_seeded_random_byte_fuzz_matches_the_line_contract(self):
        rng = random.Random(0x11E5)
        data = self._fuzz_stream(rng, 40000)
        self.assertGreaterEqual(len(data), 20000)

        r = self.new_reader()
        got = r.feed(data)
        want = reference_line_events(data)
        self.assertLessEqual(r.longest_reported, LINE_MAX_LEN, "a line longer than LINE_MAX_LEN was reported")
        for i, (g, w) in enumerate(zip(got, want)):
            if g != w:
                self.fail(f"event {i}: reader reported ({EV_NAMES[g[0]]}, {g[1][:40]!r}...), "
                          f"contract says ({EV_NAMES[w[0]]}, {w[1][:40]!r}...)")
        self.assertEqual(len(got), len(want), "number of reported lines")

        kinds = collections.Counter(ev for ev, _ in want)
        for ev, minimum in ((EV_LINE, 50), (EV_OVERFLOW, 20), (EV_INVALID, 20)):
            self.assertGreaterEqual(kinds[ev], minimum, f"fuzz seed no longer exercises {EV_NAMES[ev]}")
        st = r.stats()
        self.assertEqual(st["bytes"], len(data))
        self.assertEqual((st["lines"], st["overflows"], st["invalid"]),
                         (kinds[EV_LINE], kinds[EV_OVERFLOW], kinds[EV_INVALID]))

        # The same bytes through the scheduler: no crash, one well-formed reply per reported line
        s = self.new_session()
        s.push(data)
        out = bytearray()
        steps = 0
        while s.rx_pending():
            s.step(steps, rng.choice((1, 7, 64)))
            s.drain(rng.choice((50, 700, 1 << 20)))
            out += s.take()
            steps += 1
            self.assertLess(steps, 10 * len(data), "scheduler stopped consuming the FIFO")
        s.service(10 ** 7)
        s.drain()
        out += s.take()
        replies = parse_lines(bytes(out))
        self.assertEqual(len(replies), len(want), "one reply per reported line")
        for i, (rep, (ev, _)) in enumerate(zip(replies, want)):
            self.assertEqual(envelope_problems(rep), [], f"reply {i}: {rep}")
            if ev == EV_OVERFLOW:
                self.assertEqual(rep["code"], "line_too_long", f"reply {i}: {rep}")
            elif ev == EV_INVALID:
                self.assertEqual(rep["code"], "bad_request", f"reply {i}: {rep}")
        self.assertEqual(s.sink_violations(), 0)


# =============================================================================================
# 2. Request ids
# =============================================================================================
class RequestIdTests(ProtoTestCase):

    def test_id_is_echoed(self):
        s = self.new_session()
        rep = self.one_reply(s, b"@abc PING")
        self.assertEqual(rep, {"status": "ok", "id": "abc", "cmd": "PING", "type": "pong"})
        self.assertEqual(list(rep), ["status", "id", "cmd", "type"])
        rep = self.one_reply(s, b"  @A-z_09   ping  ")
        self.assertReply(rep, "ok", "PING", rid="A-z_09")

    def test_id_of_12_chars_is_accepted_and_13_rejected(self):
        s = self.new_session()
        twelve = "abcdefghijkl"
        self.assertEqual(len(twelve), REQUEST_ID_MAX_LEN)
        self.assertReply(self.one_reply(s, b"@%s PING" % twelve.encode()), "ok", "PING", rid=twelve)

        calls = s.handler_calls()
        rep = self.one_reply(s, b"@%sm PING" % twelve.encode())
        self.assertReply(rep, "error", "", "bad_request")
        self.assertEqual(s.handler_calls(), calls, "a request with an invalid id was executed")

        for n in range(0, 15):
            self.assertEqual(bool(self.lib.p_valid_id(b"x" * n, n)), 1 <= n <= REQUEST_ID_MAX_LEN, f"length {n}")

    def test_illegal_id_characters_are_bad_request(self):
        s = self.new_session()
        for rid in (b"a.b", b"a!b", b"a/b", b"a+b", b"a:b", b"a@b", b"@a", b'a"b', b"a\\b", b"\xe9t\xe9"):
            with self.subTest(rid=rid):
                self.assertFalse(self.lib.p_valid_id(rid, len(rid)))
                calls = s.handler_calls()
                rep = self.one_reply(s, b"@" + rid + b" PING")
                self.assertReply(rep, "error", "", "bad_request")
                self.assertEqual(s.handler_calls(), calls)

    def test_bare_at_and_id_without_command_are_bad_request(self):
        s = self.new_session()
        for line in (b"@", b"@ PING", b"  @  "):
            with self.subTest(line=line):
                self.assertReply(self.one_reply(s, line), "error", "", "bad_request")
        for line in (b"@id", b"@id   ", b"  @id"):
            with self.subTest(line=line):
                self.assertReply(self.one_reply(s, line), "error", "", "bad_request", rid="id")
        self.assertEqual(s.handler_calls(), 0)

    def test_rejected_lines_echo_a_well_formed_leading_id(self):
        s = self.new_session()
        replies = s.run(b"@long1 PING " + b"x" * 200 + b"\n"
                        + b"   @long2 ECHO" + b" y" * 100 + b"\n"
                        + b"@ctl1 PI\x01NG\n"
                        + b"@bad.id PING " + b"x" * 200 + b"\n"
                        + b"@" + b"a" * 13 + b" PING " + b"x" * 200 + b"\n"
                        + b"@ctl2\x01 PING\n")
        self.assertEqual(len(replies), 6, replies)
        self.assertReply(replies[0], "error", "", "line_too_long", rid="long1")
        self.assertReply(replies[1], "error", "", "line_too_long", rid="long2")
        self.assertReply(replies[2], "error", "", "bad_request", rid="ctl1")
        self.assertReply(replies[3], "error", "", "line_too_long")
        self.assertReply(replies[4], "error", "", "line_too_long")
        self.assertReply(replies[5], "error", "", "bad_request")

    def test_overlong_line_never_echoes_an_id_cut_short_by_the_buffer(self):
        # The reader keeps only the first LINE_MAX_LEN bytes of an over-long line. When the "@id"
        # token reaches that boundary, what is left is not the request's id and must not be echoed
        # (the caller would correlate the error with a different request).
        cases = [
            # (line, the request's real id or None when the real id is invalid)
            (b" " * 148 + b"@abcdefghijklmnop PING", None),         # 16-char id: invalid
            (b" " * 150 + b"@abcdefghij PING " + b"x" * 40, "abcdefghij"),
            (b" " * 158 + b"@q7 PING", "q7"),
        ]
        s = self.new_session()
        wrong = []
        for line, real_id in cases:
            self.assertGreater(len(line), LINE_MAX_LEN)
            replies = s.run(line + b"\n")
            self.assertEqual(len(replies), 1, replies)
            self.assertEqual(replies[0]["code"], "line_too_long")
            echoed = replies[0].get("id")
            if echoed is not None and echoed != real_id:
                wrong.append(f"id token starting at byte {line.index(b'@')}: real id {real_id!r}, "
                             f"echoed {echoed!r}")
        self.assertEqual(wrong, [], "line_too_long echoed a truncated id")


# =============================================================================================
# 3. Dispatch
# =============================================================================================
class DispatchTests(ProtoTestCase):

    def test_verbs_are_case_insensitive(self):
        s = self.new_session()
        for verb in (b"PING", b"ping", b"Ping", b"pInG"):
            self.assertReply(self.one_reply(s, verb), "ok", "PING")
        self.assertReply(self.one_reply(s, b"set_actuation 1.2"), "ok", "SET_ACTUATION")
        self.assertReply(self.one_reply(s, b"Scan_Rate"), "ok", "SCAN_RATE")

    def test_aliases_resolve_to_the_canonical_cmd(self):
        s = self.new_session()
        for line, cmd in ((b"HELLO", "INFO"), (b"hello", "INFO"), (b"INFO", "INFO"),
                          (b"HID 1", "SET_HID"), (b"output 1", "SET_HID"), (b"Set_Hid 1", "SET_HID")):
            with self.subTest(line=line):
                self.assertReply(self.one_reply(s, line), "ok", cmd)
        for verb, canonical in ((b"hid", "SET_HID"), (b"OUTPUT", "SET_HID"), (b"Hello", "INFO"),
                                (b"SET_HI", None), (b"HIDX", None), (b"HID|OUTPUT", None),
                                (b"OUTPUT|", None), (b"", None)):
            self.assertEqual(s.find(verb), canonical, f"find({verb!r})")

    def test_unknown_verb_is_unknown_command_with_empty_cmd(self):
        s = self.new_session()
        for line, rid in ((b"NOPE", None), (b"@u1 PIN", "u1"), (b"PINGX", None), (b"HID|OUTPUT 1", None),
                          (b"@u2 ECHO_", "u2")):
            with self.subTest(line=line):
                self.assertReply(self.one_reply(s, line), "error", "", "unknown_command", rid=rid)
        self.assertEqual(s.handler_calls(), 0)
        self.assertEqual(s.stats()["unknown_commands"], 5)

    def test_argument_counts_are_enforced_before_the_handler(self):
        s = self.new_session()
        cases = [  # (line, cmd, min_args, max_args)
            (b"PING extra", "PING", 0, 0),
            (b"SET_ACTUATION", "SET_ACTUATION", 1, 1),
            (b"SET_ACTUATION 1 2", "SET_ACTUATION", 1, 1),
            (b"SET_KEY 1 2", "SET_KEY", 3, 4),
            (b"SET_KEY 1 2 3 4 5", "SET_KEY", 3, 4),
            (b"SET_HID", "SET_HID", 1, 2),
            (b"output a b c", "SET_HID", 1, 2),
            (b"ECHO 1 2 3 4 5 6 7", "ECHO", 0, 6),
            (b"ECHO" + b" z" * 40, "ECHO", 0, 6),
        ]
        for line, cmd, lo, hi in cases:
            with self.subTest(line=line[:30]):
                calls = s.handler_calls()
                rep = self.one_reply(s, line)
                self.assertReply(rep, "error", cmd, "bad_arguments")
                self.assertEqual((rep.get("min_args"), rep.get("max_args")), (lo, hi), rep)
                self.assertEqual(s.handler_calls(), calls, "handler ran despite a wrong argument count")
        # The boundaries themselves are accepted
        self.assertEqual(self.one_reply(s, b"SET_KEY 1 2 3")["argc"], 3)
        self.assertEqual(self.one_reply(s, b"SET_KEY 1 2 3 4")["argc"], 4)
        self.assertEqual(self.one_reply(s, b"ECHO 1 2 3 4 5 6")["args"], ["1", "2", "3", "4", "5", "6"])
        self.assertEqual(self.one_reply(s, b"ECHO")["args"], [])

    def test_arguments_are_split_on_runs_of_spaces(self):
        s = self.new_session()
        rep = self.one_reply(s, b"   ECHO   a  bb    ccc   ")
        self.assertEqual(rep["args"], ["a", "bb", "ccc"])

    def test_value_errors_use_the_parser_result_codes(self):
        s = self.new_session()
        cases = [  # (line, cmd, code or None for ok, field, value)
            (b"SET_ACTUATION 1.234", "SET_ACTUATION", "bad_number", None, None),
            (b"SET_ACTUATION 3.81", "SET_ACTUATION", "out_of_range", None, None),
            (b"SET_ACTUATION 01.50", "SET_ACTUATION", None, "actuation", 1.5),
            (b"CODE 256", "CODE", "out_of_range", None, None),
            (b"CODE -1", "CODE", "bad_number", None, None),
            (b"CODE 007", "CODE", None, "code", 7),   # the shim's CODE reply names its value "code"
            (b"SET_RT_ENABLE ON", "SET_RT_ENABLE", None, "value", True),
            (b"SET_RT_ENABLE 2", "SET_RT_ENABLE", "out_of_range", None, None),
            (b"SET_RT_ENABLE yes", "SET_RT_ENABLE", "bad_number", None, None),
            (b"LABEL ABCDE", "LABEL", "invalid_label", None, None),
            (b"LABEL AB", "LABEL", None, "label", "AB"),
        ]
        for line, cmd, code, field, value in cases:
            with self.subTest(line=line):
                rep = self.one_reply(s, line)
                self.assertReply(rep, "error" if code else "ok", cmd, code)
                if field:
                    self.assertEqual(rep[field], value, rep)
        # The range in the actuation error is formatted in mm with two decimals
        s.handle(b"SET_ACTUATION 0.24")
        s.drain()
        raw = s.take()
        self.assertIn(b'"min":0.25,"max":3.80', raw)

    def test_handler_bug_guards_still_answer_exactly_once(self):
        s = self.new_session()
        rep = self.one_reply(s, b"@g1 SILENT")
        self.assertReply(rep, "error", "SILENT", "unsupported", rid="g1")
        self.assertEqual(rep["msg"], "handler produced no reply")
        rep = self.one_reply(s, b"@g2 OPEN")
        self.assertReply(rep, "error", "OPEN", "unsupported", rid="g2")
        self.assertEqual(rep["msg"], "reply malformed")
        rep = self.one_reply(s, b"@g3 BIG 1000")
        self.assertReply(rep, "error", "BIG", "unsupported", rid="g3")
        self.assertEqual(rep["msg"], "reply too long")
        st = s.stats()
        self.assertEqual((st["handler_no_reply"], st["reply_overflows"]), (1, 2))

    def test_longest_reply_fits_max_reply_len(self):
        max_reply = self.lib.tx_max_reply_len()
        s = self.new_session()
        longest_ok = None
        for n in range(150, 300):
            s.handle(b"BIG %d" % n)
            s.drain()
            raw = s.take()
            rep = parse_lines(raw)[0]
            if rep["status"] == "ok":
                self.assertEqual(len(rep["items"]), n)
                self.assertLessEqual(len(raw) - 1, max_reply)
                longest_ok = (n, len(raw) - 1)
            else:
                self.assertEqual(rep["msg"], "reply too long")
                self.assertIsNotNone(longest_ok, "even a short BIG reply was rejected")
                # The first rejected n is exactly the first one whose reply would exceed the limit
                self.assertEqual(n, longest_ok[0] + 1)
                self.assertGreater(longest_ok[1] + len(',"0123456789"'), max_reply)
                break
        else:
            self.fail("no BIG reply ever exceeded MAX_REPLY_LEN")

    def test_error_reply_escapes_the_message_and_keeps_extra_fields(self):
        s = self.new_session()
        s.handle(b"@f FAIL")
        s.drain()
        raw = s.take()
        self.assertNotIn(b"\t", raw)
        rep = parse_lines(raw)[0]
        self.assertEqual(rep, {"status": "error", "id": "f", "cmd": "FAIL", "code": "not_allowed",
                               "msg": 'refused "on purpose"', "detail": "tab\there"})
        self.assertEqual(list(rep), ["status", "id", "cmd", "code", "msg", "detail"])

    # Bodies for the dispatch fuzz; OLED_SCAN and DEFER_AFTER_OK defer their reply
    FUZZ_BODIES = (
        b"PING", b"ping", b"hello", b"ECHO a bb ccc", b"ECHO 1 2 3 4 5 6 7", b"NOPE",
        b"SET_ACTUATION 1.2", b"SET_ACTUATION 9", b"SET_ACTUATION 1.234", b"CODE 300", b"CODE 42",
        b"SET_RT_ENABLE on", b"SET_RT_ENABLE 2", b"LABEL ABCDE", b"LABEL AB", b"output 1",
        b"SET_KEY 1 2", b"SET_KEY 1 2 3", b"FAIL", b"SILENT", b"OPEN", b"BIG 3", b"BIG 1000",
        b"TIMING", b"TIMING RESET", b"SCAN_RATE", b"PING extra",
        b"OLED_SCAN", b"OLED_SCAN", b"OLED_SCAN 20", b"oled_scan 1", b"OLED_SCAN 0",
        b"DEFER_AFTER_OK", b"DEFER_THEN_OK",
    )
    DEFERRING = {"OLED_SCAN", "DEFER_AFTER_OK"}

    def test_exactly_one_reply_per_request_line_seeded_fuzz(self):
        rng = random.Random(0x5EED)
        stream = bytearray()
        want_ids: List[str] = []      # ids that must each be echoed exactly once, in request order
        replies_without_id = 0
        requests = 0                  # non-empty lines: each needs exactly one reply
        for i in range(600):
            rid = b"r%d" % i
            body = rng.choice(self.FUZZ_BODIES)
            k = rng.random()
            if k < 0.70:
                line, echo = b"@" + rid + b" " + body, rid
            elif k < 0.78:
                line, echo = body, None
            elif k < 0.82:
                line, echo = rng.choice(((b"@" + rid + b" PI\x01NG", rid), (b"PI\x00NG", None),
                                         (b"@" + rid + b" \x7f", rid)))
            elif k < 0.86:
                line, echo = b"@" + rid + b" " + body + b" " + b"x" * rng.randrange(160, 320), rid
            elif k < 0.90:
                line, echo = rng.choice((b"@", b"@bad.id PING", b"@abcdefghijklm PING", b"@ PING")), None
            elif k < 0.93:
                line, echo = b"@" + rid, rid
            else:
                line, echo = rng.choice((b"", b" ", b"    ")), b"<blank>"
            if echo != b"<blank>":
                if rng.random() < 0.2:
                    line = b" " * rng.randrange(1, 3) + line
                requests += 1
                if echo is None:
                    replies_without_id += 1
                else:
                    want_ids.append(echo.decode())
            stream += line + rng.choice((b"\n", b"\r", b"\r\n"))

        s = self.new_session()
        s.push(bytes(stream))
        out = bytearray()
        now = 0
        events_sent = 0
        for _ in range(200000):
            if not s.rx_pending() and not s.deferred_pending() and s.tx_used() == 0:
                break
            if rng.random() < 0.15:
                s.set_defer_mode(rng.choice((DEFER_WAIT, DEFER_WAIT, DEFER_OK, DEFER_ERROR, DEFER_SILENT)))
            if rng.random() < 0.05:
                events_sent += s.event(b"telemetry", rng.randrange(0, 700))
            s.step(now, rng.choice((0, 1, 5, 64)))
            s.drain(rng.choice((0, 7, 64, 512, 4096)))
            out += s.take()
            now += rng.choice((0, 1, 3, 20))
        else:
            self.fail("the session never went idle")

        lines = parse_lines(bytes(out))
        replies = [x for x in lines if "status" in x]
        events = [x for x in lines if "status" not in x]
        self.assertEqual(len(replies), requests, "number of replies != number of non-empty request lines")
        self.assertEqual(len(events), events_sent)
        for ev in events:
            self.assertEqual(list(ev)[0], "type", ev)
            self.assertEqual(ev["type"], "telemetry", ev)

        bad = [(r, p) for r in replies for p in [envelope_problems(r)] if p]
        self.assertEqual(bad, [], "malformed replies")

        echoed = collections.Counter(r["id"] for r in replies if "id" in r)
        self.assertEqual({k: v for k, v in echoed.items() if v != 1}, {}, "ids echoed more than once")
        self.assertEqual(set(echoed), set(want_ids), "ids missing from / unexpected in the replies")
        self.assertEqual(sum(1 for r in replies if "id" not in r), replies_without_id)

        order = {rid: n for n, rid in enumerate(want_ids)}
        immediate = [order[r["id"]] for r in replies if "id" in r and r["cmd"] not in self.DEFERRING]
        self.assertEqual(immediate, sorted(immediate), "immediate replies left out of request order")

        st = s.stats()
        self.assertEqual(st["requests"], requests)
        self.assertEqual(st["replies_ok"] + st["replies_error"], requests)
        self.assertEqual(st["replies_lost"], 0)
        self.assertEqual(s.tx_stats()["replies_rejected"], 0)
        self.assertEqual(s.sink_violations(), 0)
        # The seed must keep exercising the interesting paths
        codes = collections.Counter(r.get("code") for r in replies)
        self.assertGreater(st["deferred_completed"], 0, "fuzz seed no longer completes a deferral")
        self.assertGreater(st["deferred_timeouts"], 0, "fuzz seed no longer times out a deferral")
        for code in ("busy", "line_too_long", "bad_request", "bad_arguments", "unknown_command"):
            self.assertGreater(codes[code], 0, f"fuzz seed no longer produces {code}")

    def test_events_never_carry_status(self):
        s = self.new_session()
        self.assertTrue(s.event(b"telemetry", 10))
        ev = s.lines()
        self.assertEqual(len(ev), 1)
        self.assertEqual(list(ev[0]), ["type", "seq", "pad"])
        self.assertNotIn("status", ev[0])

        self.assertFalse(self.lib.ss_event_with_status(s.h), "an event carrying status was queued")
        self.assertEqual(self.lib.ss_event_malformed(s.h), 1)
        self.assertFalse(self.lib.ss_event_unclosed(s.h), "an unclosed event was queued")
        self.assertEqual(self.lib.ss_event_malformed(s.h), 2)
        self.assertFalse(s.event(b"telemetry", MAX_EVENT_LEN + 100), "an overflowed event was queued")
        self.assertEqual(self.lib.ss_event_malformed(s.h), 3)
        self.assertEqual(s.lines(), [], "malformed events must not reach the host")

    def test_scheduler_handles_at_most_one_line_per_step(self):
        s = self.new_session()
        s.push(b"@1 PING\n@2 PING\n")
        self.assertTrue(s.step(0))
        self.assertEqual(s.rx_pending(), 8, "the second line must stay in the FIFO")
        self.assertEqual([r["id"] for r in s.lines()], ["1"])
        self.assertTrue(s.step(0))
        self.assertEqual([r["id"] for r in s.lines()], ["2"])
        self.assertFalse(s.step(0))

    def test_scheduler_reads_at_most_max_bytes_per_step(self):
        s = self.new_session()
        line = b"ECHO " + b"a" * 95 + b"\n"
        s.push(line)
        self.assertFalse(s.step(0, 64))
        self.assertEqual(s.rx_pending(), len(line) - 64)
        self.assertTrue(s.step(0, 64))
        self.assertEqual(s.rx_pending(), 0)
        self.assertEqual(len(s.lines()), 1)

    def test_scheduler_leaves_requests_in_the_fifo_until_a_reply_fits(self):
        s = self.new_session()
        s.handle(b"BIG 200")   # direct dispatch: fills the TX queue without the room check
        s.handle(b"BIG 200")
        self.assertFalse(s.has_room())
        s.push(b"@w PING\n")
        calls = s.handler_calls()
        self.assertFalse(s.step(0))
        self.assertEqual(s.rx_pending(), 8, "request bytes must stay in the USB FIFO")
        self.assertEqual(s.handler_calls(), calls)
        self.assertEqual(len(s.lines()), 2)
        self.assertTrue(s.step(0))
        self.assertReply(s.lines()[0], "ok", "PING", rid="w")

    def test_error_code_table(self):
        codes = tuple(self.lib.err_code(i).decode() for i in range(self.lib.err_count()))
        self.assertEqual(codes, ERROR_CODES)
        self.assertEqual(self.lib.p_result_code(PR_OK), b"")
        self.assertEqual(self.lib.p_result_code(PR_BAD_NUMBER), b"bad_number")
        self.assertEqual(self.lib.p_result_code(PR_OUT_OF_RANGE), b"out_of_range")


# =============================================================================================
# 4. Strict parsers
# =============================================================================================
class ParserTests(ProtoTestCase):

    def cmm(self, text: bytes, lo: int = 0, hi: int = 0xFFFF) -> Tuple[int, Optional[int]]:
        out = ctypes.c_uint32(0xDEAD)
        r = self.lib.p_cmm(text, lo, hi, ctypes.byref(out))
        return r, (out.value if r == PR_OK else None)

    def uint(self, text: bytes, lo: int = 0, hi: int = M32) -> Tuple[int, Optional[int]]:
        out = ctypes.c_uint32(0xDEAD)
        r = self.lib.p_uint(text, lo, hi, ctypes.byref(out))
        return r, (out.value if r == PR_OK else None)

    def boolean(self, text: bytes) -> Tuple[int, Optional[bool]]:
        out = ctypes.c_int(-1)
        r = self.lib.p_bool(text, ctypes.byref(out))
        return r, (bool(out.value) if r == PR_OK else None)

    def check_table(self, fn, cases, *range_args):
        """cases: [(text, expected (result, value))]; one failure listing every mismatch."""
        wrong = []
        for text, want in cases:
            got = fn(text, *range_args)
            if got != want:
                wrong.append(f"{text!r}: got {PR_NAMES[got[0]]} {got[1]!r}, want {PR_NAMES[want[0]]} {want[1]!r}")
        self.assertEqual(wrong, [], f"{fn.__name__}{range_args or ''} mismatches")

    def test_parse_cmm_accepts_digits_with_up_to_two_decimals(self):
        self.check_table(self.cmm, [
            (b"0", (PR_OK, 0)), (b"1", (PR_OK, 100)), (b"1.2", (PR_OK, 120)), (b"1.25", (PR_OK, 125)),
            (b"0.05", (PR_OK, 5)), (b"3.8", (PR_OK, 380)), (b"3.80", (PR_OK, 380)),
            (b"655.35", (PR_OK, 65535)),
        ])

    def test_parse_cmm_accepts_leading_zeros_as_decimal(self):
        # protocol.h: "Leading zeros are accepted ("007" = 7, "01.50" = 1.50 mm): the parser is
        # decimal only, so they cannot be misread as octal."
        self.check_table(self.cmm, [
            (b"01.50", (PR_OK, 150)), (b"00.25", (PR_OK, 25)), (b"007", (PR_OK, 700)),
            (b"010", (PR_OK, 1000)), (b"0000000000000001.5", (PR_OK, 150)),
        ])

    def test_parse_cmm_rejects_anything_outside_the_syntax(self):
        rejected = [b"", b".5", b"1.", b"1.234", b"-1", b"+1", b"1e2", b"0x1", b"1,5", b"nan", b"inf",
                    b" 1", b"1 ", b"1.2.3", b"abc", b"0.1x", b".", b"1..2", b"\t1", b"-0", b"1.-5",
                    b"\xef\xbc\x91", b"99999999999x", b"99999999999.123"]
        self.check_table(self.cmm, [(t, (PR_BAD_NUMBER, None)) for t in rejected])
        self.check_table(self.cmm, [(t, (PR_BAD_NUMBER, None)) for t in rejected],
                         ACTUATION_MIN_CMM, ACTUATION_MAX_CMM)

    def test_parse_cmm_range_is_inclusive(self):
        self.check_table(self.cmm, [
            (b"0", (PR_OUT_OF_RANGE, None)), (b"0.24", (PR_OUT_OF_RANGE, None)),
            (b"0.25", (PR_OK, 25)), (b"3.80", (PR_OK, 380)), (b"3.81", (PR_OUT_OF_RANGE, None)),
            (b"4", (PR_OUT_OF_RANGE, None)), (b"380", (PR_OUT_OF_RANGE, None)),
        ], ACTUATION_MIN_CMM, ACTUATION_MAX_CMM)

    def test_parse_cmm_overflow_is_out_of_range_never_wrapped(self):
        huge = [b"99999999999", b"4294967296", b"429496719", b"42949671", b"42949672", b"42949673",
                b"42949676", b"42949673.21", b"99999999", b"18446744073709551616", b"99999999999.99"]
        oor = [(t, (PR_OUT_OF_RANGE, None)) for t in huge]
        wrong = []
        for lo, hi in ((0, 0xFFFF), (ACTUATION_MIN_CMM, ACTUATION_MAX_CMM)):
            for text, want in oor:
                got = self.cmm(text, lo, hi)
                if got != want:
                    wrong.append(f"parseCmm({text.decode()}, {lo}..{hi}): got {PR_NAMES[got[0]]} "
                                 f"{got[1]} cmm, want OutOfRange")
        # End to end: the actuation command must refuse it too
        s = self.new_session()
        s.handle(b"SET_ACTUATION 42949676")
        rep = s.lines()[0]
        if rep.get("code") != "out_of_range":
            wrong.append(f"SET_ACTUATION 42949676 -> {rep}")
        self.assertEqual(wrong, [], "parseCmm wrapped an overflowing value into range")

    def test_parse_uint_accepts_decimal_digits_only(self):
        self.check_table(self.uint, [
            (b"0", (PR_OK, 0)), (b"7", (PR_OK, 7)), (b"007", (PR_OK, 7)), (b"255", (PR_OK, 255)),
            (b"4294967295", (PR_OK, 4294967295)), (b"0000000000004294967295", (PR_OK, 4294967295)),
        ])
        rejected = [b"", b"-1", b"+1", b" 1", b"1 ", b"1.0", b"1e2", b"0x1", b"1,5", b"abc", b"1a",
                    b"nan", b"inf", b"\t1", b"99999999999x", b"\xef\xbc\x91"]
        self.check_table(self.uint, [(t, (PR_BAD_NUMBER, None)) for t in rejected])

    def test_parse_uint_range_and_overflow(self):
        self.check_table(self.uint, [
            (b"9", (PR_OUT_OF_RANGE, None)), (b"10", (PR_OK, 10)), (b"255", (PR_OK, 255)),
            (b"256", (PR_OUT_OF_RANGE, None)), (b"0", (PR_OUT_OF_RANGE, None)),
        ], 10, 255)
        self.check_table(self.uint, [
            (b"4294967296", (PR_OUT_OF_RANGE, None)), (b"4294967300", (PR_OUT_OF_RANGE, None)),
            (b"42949672950", (PR_OUT_OF_RANGE, None)), (b"99999999999", (PR_OUT_OF_RANGE, None)),
            (b"18446744073709551616", (PR_OUT_OF_RANGE, None)),
        ])

    def test_parse_bool(self):
        cases = [(t, (PR_OK, True)) for t in (b"1", b"on", b"ON", b"On", b"true", b"TRUE", b"tRuE")]
        cases += [(t, (PR_OK, False)) for t in (b"0", b"off", b"OFF", b"oFf", b"false", b"FALSE", b"False")]
        cases += [(t, (PR_OUT_OF_RANGE, None)) for t in (b"2", b"00", b"10", b"01", b"99999999999")]
        cases += [(t, (PR_BAD_NUMBER, None)) for t in (b"", b"yes", b"no", b"o", b"onn", b"tru", b" 1",
                                                        b"1 ", b"-1", b"+1", b"0x1", b"t", b"f", b"1.0")]
        self.check_table(self.boolean, cases)

    def test_parse_token_and_keyword(self):
        buf = ctypes.create_string_buffer(8)
        self.assertTrue(self.lib.p_token(b"ABCD", buf, 5))
        self.assertEqual(buf.value, b"ABCD")
        self.assertFalse(self.lib.p_token(b"ABCDE", buf, 5), "does not fit 5 bytes with its terminator")
        self.assertFalse(self.lib.p_token(b"", buf, 5))
        for text, kw, want in ((b"reset", b"RESET", True), (b"ReSeT", b"reset", True),
                               (b"rese", b"RESET", False), (b"resets", b"RESET", False), (b"", b"RESET", False)):
            self.assertEqual(bool(self.lib.p_keyword(text, kw)), want, f"keywordIs({text!r}, {kw!r})")


# =============================================================================================
# 5. JsonWriter
# =============================================================================================
class JsonWriterTests(ProtoTestCase):

    def writer(self, capacity: int):
        h = self.lib.jw_create(capacity)
        self.addCleanup(self.lib.jw_destroy, h)
        return h

    def apply(self, h, op):
        name, *args = op
        getattr(self.lib, "jw_" + name)(h, *args)

    def text(self, h) -> bytes:
        return self.lib.jw_data(h) or b""

    def single(self, op) -> bytes:
        h = self.writer(256)
        self.apply(h, op)
        self.assertTrue(self.lib.jw_complete(h), f"{op} as a top-level value")
        return self.text(h)

    def test_string_escaping_round_trips_every_byte(self):
        data = bytes(range(256))
        h = self.writer(4096)
        for op in (("begin_array",), ("str_n", data, len(data)), ("str_n", b'"', 1), ("str_n", b"\\", 1),
                   ("str", b"plain"), ("end_array",)):
            self.apply(h, op)
        self.assertTrue(self.lib.jw_complete(h))
        text = self.text(h)
        self.assertEqual(len(text), self.lib.jw_len(h))
        self.assertTrue(all(0x20 <= b < 0x7F for b in text), "raw control or non-ASCII byte in output")
        self.assertEqual(parse_json(text), [data.decode("latin-1"), '"', "\\", "plain"])

        # The exact forms from json_writer.h: \" \\ and \u00XX for < 0x20 and >= 0x7F
        expected = b""
        for b in data:
            if b in (0x22, 0x5C):
                expected += b"\\" + bytes([b])
            elif b < 0x20 or b >= 0x7F:
                expected += b"\\u00%02x" % b
            else:
                expected += bytes([b])
        normalised = re.sub(rb"\\u00([0-9A-Fa-f]{2})", lambda m: b"\\u00" + m.group(1).lower(), text)
        self.assertTrue(normalised.startswith(b'["' + expected + b'"'), normalised[:120])

    def test_keys_are_escaped_too(self):
        h = self.writer(256)
        for op in (("begin_object",), ("key", b'k"\\\x01\x7f'), ("u32", 1), ("end_object",)):
            self.apply(h, op)
        self.assertEqual(parse_json(self.text(h)), {'k"\\\x01\x7f': 1})

    def test_overflow_never_writes_past_capacity(self):
        ops = [("begin_object",), ("key", b"msg"), ("str", b'a "quoted" \\ back\x01slash\x7f\xff'),
               ("key", b"n"), ("i32", -2147483648), ("key", b"mm"), ("mm", 380), ("key", b"arr"),
               ("begin_array",), ("u32", 4294967295), ("bool", 0), ("null",), ("str_n", b"a\x00b", 3),
               ("scaled", -5, 3), ("end_array",), ("key", b"raw"), ("raw", b'{"x":[1,2]}'),
               ("key", b"t"), ("bool", 1), ("end_object",)]
        ref = self.writer(4096)
        for op in ops:
            self.apply(ref, op)
        self.assertTrue(self.lib.jw_complete(ref))
        full = self.text(ref)
        parse_json(full)

        for cap in range(0, len(full) + 3):
            with self.subTest(capacity=cap):
                h = self.writer(cap)
                len_at_overflow = None
                for op in ops:
                    self.apply(h, op)
                    if len_at_overflow is None and self.lib.jw_overflow(h):
                        len_at_overflow = self.lib.jw_len(h)
                canary = [self.lib.jw_buffer_byte(h, i) for i in range(cap, cap + 16)]
                self.assertEqual(canary, [0xA5] * 16, "bytes written past the capacity")
                n = self.lib.jw_len(h)
                if cap > len(full):
                    self.assertTrue(self.lib.jw_complete(h))
                    self.assertEqual(self.text(h), full)
                    continue
                # capacity includes the NUL, so cap == len(full) must overflow as well
                self.assertTrue(self.lib.jw_overflow(h))
                self.assertFalse(self.lib.jw_ok(h))
                self.assertFalse(self.lib.jw_complete(h))
                self.assertLess(n, max(cap, 1))
                self.assertEqual(n, len_at_overflow, "calls after the overflow changed the text")
                if cap > 0:   # capacity 0 has no room even for the terminator: nothing to read
                    self.assertEqual(self.lib.jw_buffer_byte(h, n), 0, "prefix is not NUL terminated")
                    self.assertTrue(full.startswith(self.text(h)), "buffer is not a prefix of the text")

    def test_mm_formatting_from_centi_millimetres(self):
        for cmm, want in ((0, b"0.00"), (5, b"0.05"), (25, b"0.25"), (120, b"1.20"), (380, b"3.80"),
                          (100, b"1.00"), (-25, b"-0.25"), (-5, b"-0.05"), (-380, b"-3.80"),
                          (2147483647, b"21474836.47"), (-2147483648, b"-21474836.48")):
            self.assertEqual(self.single(("mm", cmm)), want, f"mm({cmm})")

    def test_integers_and_scaled_values(self):
        cases = [(("i32", 0), b"0"), (("i32", -2147483648), b"-2147483648"), (("i32", 2147483647), b"2147483647"),
                 (("u32", 4294967295), b"4294967295"), (("scaled", 123, 1), b"12.3"),
                 (("scaled", -5, 3), b"-0.005"), (("scaled", 7, 0), b"7"), (("scaled", 5, 9), b"0.000005"),
                 (("bool", 1), b"true"), (("bool", 0), b"false"), (("null",), b"null"), (("str", None), b"null")]
        for op, want in cases:
            self.assertEqual(self.single(op), want, str(op))

    def test_fixed_is_json_safe(self):
        for value, decimals, want in ((float("nan"), 2, b"null"), (float("inf"), 2, b"null"),
                                      (float("-inf"), 2, b"null"), (1.5, 2, b"1.50"), (1.0, 9, b"1.000000")):
            self.assertEqual(self.single(("fixed", value, decimals)), want, f"fixed({value}, {decimals})")
        parse_json(self.single(("fixed", -0.001, 2)))

    def test_misuse_is_detected(self):
        scenarios = {
            "key() inside an array": [("begin_array",), ("key", b"x")],
            "value without key() in an object": [("begin_object",), ("u32", 1)],
            "key() at top level": [("key", b"x")],
            "endArray() closing an object": [("begin_object",), ("end_array",)],
            "endObject() at depth 0": [("end_object",)],
            "endObject() after a dangling key": [("begin_object",), ("key", b"x"), ("end_object",)],
            "two keys in a row": [("begin_object",), ("key", b"x"), ("key", b"y")],
            "second top-level value": [("u32", 1), ("u32", 2)],
            "nesting deeper than MAX_DEPTH": [("begin_array",)] * 9,
        }
        for name, ops in scenarios.items():
            with self.subTest(name):
                h = self.writer(256)
                for op in ops:
                    self.apply(h, op)
                self.assertTrue(self.lib.jw_misuse(h))
                self.assertFalse(self.lib.jw_ok(h))
                self.assertFalse(self.lib.jw_complete(h))
        h = self.writer(256)
        for op in [("begin_array",)] * 8 + [("end_array",)] * 8:
            self.apply(h, op)
        self.assertTrue(self.lib.jw_complete(h), "MAX_DEPTH (8) levels are allowed")

    def test_complete_requires_a_closed_top_level_value(self):
        h = self.writer(64)
        self.assertFalse(self.lib.jw_complete(h), "empty writer")
        self.apply(h, ("begin_object",))
        self.assertFalse(self.lib.jw_complete(h), "open object")
        self.apply(h, ("end_object",))
        self.assertTrue(self.lib.jw_complete(h))
        self.assertEqual(self.text(h), b"{}")
        self.lib.jw_reset(h)
        self.assertEqual((self.lib.jw_len(h), self.lib.jw_depth(h), self.lib.jw_ok(h)), (0, 0, 1))


# =============================================================================================
# 6. TxQueue
# =============================================================================================
class TxQueueTests(ProtoTestCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.CAP = cls.lib.tx_capacity()
        cls.MAX_REPLY = cls.lib.tx_max_reply_len()

    def test_sizes_honour_the_contract(self):
        self.assertGreaterEqual(self.CAP, 4096)
        self.assertGreaterEqual(self.CAP, 2 * (self.MAX_REPLY + 1))

    def test_reply_is_always_accepted_after_has_room_for_reply(self):
        rng = random.Random(42)
        q = self.new_tx()
        for i in range(4000):
            k = rng.random()
            if k < 0.45:
                q.enqueue(tx_line(i, rng.randrange(1, 1500)), reply=False)
            elif k < 0.75:
                if q.has_room():
                    n = rng.choice((self.MAX_REPLY, self.MAX_REPLY, rng.randrange(1, self.MAX_REPLY + 1)))
                    self.assertTrue(q.enqueue(tx_line(i, n), reply=True),
                                    f"reply of {n} bytes refused with {q.free()} bytes free after hasRoomForReply()")
            else:
                q.drain(rng.choice((0, 100, 1000, 5000)))
                q.take()
        self.assertEqual(q.stats()["replies_rejected"], 0)

    def test_events_leave_room_for_a_maximum_reply_and_are_counted_when_dropped(self):
        q = self.new_tx()
        reserve = self.MAX_REPLY + 1
        accepted = 0
        while q.enqueue(tx_line(accepted, 999), reply=False):
            accepted += 1
            self.assertGreaterEqual(q.free(), reserve, "an event ate into the reply reserve")
            self.assertTrue(q.has_room())
        self.assertEqual(q.stats()["events_dropped"], 1)
        self.assertEqual(q.stats()["events_queued"], accepted)

        # Exactly at the boundary: an event that leaves precisely one reply of space is accepted
        fill = q.free() - reserve - 1
        if fill > 0:
            self.assertTrue(q.enqueue(tx_line(9000, fill), reply=False), f"event of {fill} bytes")
        self.assertEqual(q.free(), reserve)
        self.assertFalse(q.enqueue(b"x", reply=False), "a 1-byte event would eat into the reserve")
        self.assertEqual(q.stats()["events_dropped"], 2)
        self.assertTrue(q.has_room())
        self.assertTrue(q.enqueue(tx_line(9001, self.MAX_REPLY), reply=True), "the reserved reply")
        self.assertEqual(q.free(), 0)

    def test_reply_refused_and_counted_when_the_caller_skips_the_room_check(self):
        q = self.new_tx()
        self.assertTrue(q.enqueue(b"x" * (self.CAP - 1), reply=True), "a line exactly filling the ring")
        self.assertEqual(q.used(), self.CAP)
        self.assertFalse(q.has_room())
        self.assertFalse(q.enqueue(b"late", reply=True))
        self.assertEqual(q.stats()["replies_rejected"], 1)
        self.assertEqual(q.drain(self.CAP + 10), self.CAP)
        self.assertEqual(q.take(), b"x" * (self.CAP - 1) + b"\n")

    def test_invalid_lines_are_rejected_whole(self):
        q = self.new_tx()
        for line in (b"", b"a\nb", b"a\rb", b"\n", b"x" * self.CAP):
            with self.subTest(line=line[:10]):
                self.assertFalse(q.enqueue(line, reply=True))
                self.assertFalse(q.enqueue(line, reply=False))
        self.assertEqual(q.stats()["lines_invalid"], 10)
        self.assertEqual(q.used(), 0)

    def test_drain_never_offers_the_sink_more_than_available_for_write(self):
        rng = random.Random(3)
        q = self.new_tx()
        for i in range(3000):
            if rng.random() < 0.5:
                q.enqueue(tx_line(i, rng.randrange(1, 900)), reply=q.has_room())
            avail = rng.choice((-5, 0, 1, 2, 7, 100, 5000))
            max_bytes = rng.choice((-1, -1, 0, 1, 3, 50))
            short = rng.choice((-1, -1, -1, 0, 1, 17))
            used = q.used()
            writes = q.writes()
            n = q.drain(avail, max_bytes, short)
            limit = min(max(avail, 0), used, max_bytes if max_bytes >= 0 else used)
            self.assertLessEqual(n, limit, f"drain(avail={avail}, max={max_bytes}) returned {n}")
            self.assertEqual(len(q.take()), n)
            if avail <= 0 or max_bytes == 0 or used == 0:
                self.assertEqual(q.writes(), writes, "sink.write() called with no space offered")
        self.assertEqual(q.violations(), 0, "sink.write() was handed more than availableForWrite()")

    def test_output_is_fifo_and_line_aligned_across_wraps_and_clears(self):
        rng = random.Random(0xF1F0)
        q = self.new_tx()
        model = collections.deque()   # queued lines incl. '\n', oldest first
        head_sent = 0                 # bytes of model[0] already handed to the sink
        expected = bytearray()
        got = bytearray()
        for i in range(8000):
            k = rng.random()
            if k < 0.45:
                line = tx_line(i, rng.choice((1, 2, rng.randrange(1, 200), rng.randrange(200, 1500),
                                              self.MAX_REPLY)))
                reply = rng.random() < 0.5 and q.has_room()
                if q.enqueue(line, reply=reply):
                    model.append(line + b"\n")
                else:
                    self.assertFalse(reply, "a reply was refused after hasRoomForReply()")
            elif k < 0.95:
                n = q.drain(rng.choice((0, 1, 5, 64, 300, 5000)), rng.choice((-1, -1, 3, 100)),
                            rng.choice((-1, -1, -1, 0, 1, 17)))
                chunk = q.take()
                self.assertEqual(len(chunk), n)
                got += chunk
                while n:
                    part = min(n, len(model[0]) - head_sent)
                    expected += model[0][head_sent:head_sent + part]
                    head_sent += part
                    n -= part
                    if head_sent == len(model[0]):
                        model.popleft()
                        head_sent = 0
            else:
                q.clear()
                if head_sent:
                    model = collections.deque([model[0]])
                else:
                    model.clear()
            self.assertEqual(q.used(), sum(map(len, model)) - head_sent)
            self.assertEqual(q.mid_line(), head_sent > 0)
        while q.used():
            q.drain(4096)
            got += q.take()
        for line in model:
            expected += line[head_sent:]
            head_sent = 0
        self.assertEqual(bytes(got), bytes(expected), "sink byte stream differs from the queued lines")
        self.assertTrue(got.endswith(b"\n"))
        self.assertEqual(q.violations(), 0)

    def test_clear_keeps_a_half_sent_line_to_its_end(self):
        q = self.new_tx()
        for c in b"ABC":
            self.assertTrue(q.enqueue(bytes([c]) * 10))
        self.assertEqual(q.drain(4), 4)
        self.assertEqual(q.take(), b"AAAA")
        self.assertTrue(q.mid_line())
        q.clear()
        self.assertEqual(q.used(), 7, "the rest of the half-sent line must stay queued")
        self.assertEqual(q.stats()["bytes_cleared"], 22)
        q.drain(100)
        self.assertEqual(q.take(), b"AAAAAA\n")
        self.assertFalse(q.mid_line())

        # On a line boundary clear() drops everything
        q.enqueue(b"D" * 10)
        q.enqueue(b"E" * 10)
        self.assertEqual(q.drain(11), 11)
        self.assertEqual(q.take(), b"D" * 10 + b"\n")
        self.assertFalse(q.mid_line())
        q.clear()
        self.assertEqual(q.used(), 0)
        self.assertEqual(q.stats()["bytes_cleared"], 33)

    def test_stats_and_high_water(self):
        q = self.new_tx()
        q.enqueue(b"a" * 99, reply=True)
        q.enqueue(b"b" * 199, reply=False)
        st = q.stats()
        self.assertEqual((st["bytes_queued"], st["lines_queued"], st["replies_queued"], st["events_queued"]),
                         (300, 2, 1, 1))
        self.assertEqual(st["high_water"], 300)
        q.drain(250)
        q.take()
        self.assertEqual(q.stats()["bytes_sent"], 250)
        self.assertEqual(q.stats()["high_water"], 300)
        q.reset_stats()
        st = q.stats()
        self.assertEqual(st["high_water"], 50, "highWater restarts from the current fill")
        self.assertEqual(sum(v for k, v in st.items() if k != "high_water"), 0)
        self.assertEqual(q.used(), 50, "resetStats() keeps the queue contents")


# =============================================================================================
# 7. Deferred replies
# =============================================================================================
class DeferredReplyTests(ProtoTestCase):

    def test_deferred_reply_completes_via_poll(self):
        s = self.new_session()
        s.handle(b"@d1 OLED_SCAN", now_ms=1000)
        self.assertEqual(s.lines(), [], "a deferred request must not answer at once")
        self.assertTrue(s.deferred_pending())
        s.service(1001)   # DEFER_WAIT: the poll writes a partial ok and returns false
        self.assertEqual(s.lines(), [], "an unfinished poll must not produce a reply")
        s.set_defer_mode(DEFER_OK)
        s.service(1002)
        replies = s.lines()
        self.assertEqual(len(replies), 1)
        self.assertReply(replies[0], "ok", "OLED_SCAN", rid="d1")
        self.assertEqual(replies[0]["devices"], [60])
        self.assertNotIn("partial", replies[0])
        self.assertFalse(s.deferred_pending())
        for t in (1003, 5000, 10 ** 6):
            s.service(t)
        self.assertEqual(s.lines(), [], "a completed deferral must answer exactly once")
        st = s.stats()
        self.assertEqual((st["deferred"], st["deferred_completed"], st["deferred_timeouts"]), (1, 1, 0))

    def test_deferred_reply_times_out_with_the_handler_error(self):
        s = self.new_session()
        s.handle(b"@d2 OLED_SCAN", now_ms=2000)
        s.service(2499)
        self.assertEqual(s.lines(), [], "timed out one millisecond early")
        s.service(2500)
        replies = s.lines()
        self.assertEqual(len(replies), 1)
        self.assertReply(replies[0], "error", "OLED_SCAN", "display_timeout", rid="d2")
        self.assertEqual(replies[0]["msg"], "display did not answer")
        self.assertEqual(replies[0]["timeout_ms"], 500)
        self.assertNotIn("partial", replies[0])
        s.set_defer_mode(DEFER_OK)
        s.service(2600)
        self.assertEqual(s.lines(), [], "a timed-out deferral must answer exactly once")
        self.assertEqual(s.stats()["deferred_timeouts"], 1)

        s.handle(b"OLED_SCAN 5", now_ms=100)   # handler-chosen timeout
        s.set_defer_mode(DEFER_WAIT)
        s.service(104)
        self.assertEqual(s.lines(), [])
        s.service(105)
        rep = s.lines()
        self.assertEqual(len(rep), 1)
        self.assertReply(rep[0], "error", "OLED_SCAN", "display_timeout")
        self.assertEqual(rep[0]["timeout_ms"], 5)

    def test_timeout_across_the_millisecond_wrap(self):
        s = self.new_session()
        start = 0xFFFFFF00
        s.handle(b"@w OLED_SCAN", now_ms=start)
        s.service((start + 499) & M32)
        self.assertEqual(s.lines(), [])
        s.service((start + 500) & M32)
        rep = s.lines()
        self.assertEqual(len(rep), 1)
        self.assertReply(rep[0], "error", "OLED_SCAN", "display_timeout", rid="w")

    def test_second_deferral_while_one_is_pending_is_busy(self):
        s = self.new_session()
        s.handle(b"@a OLED_SCAN", now_ms=0)
        s.handle(b"@b OLED_SCAN", now_ms=1)
        s.handle(b"@c DEFER_AFTER_OK", now_ms=2)
        s.handle(b"@p PING", now_ms=3)
        replies = s.lines()
        self.assertEqual([r["id"] for r in replies], ["b", "c", "p"], "busy/immediate replies come at once")
        self.assertReply(replies[0], "error", "OLED_SCAN", "busy", rid="b")
        self.assertEqual(replies[0]["pending"], "OLED_SCAN")
        self.assertReply(replies[1], "error", "DEFER_AFTER_OK", "busy", rid="c")
        self.assertEqual(replies[1]["pending"], "OLED_SCAN")
        self.assertNotIn("ignored", replies[1])
        self.assertReply(replies[2], "ok", "PING", rid="p")
        self.assertTrue(s.deferred_pending())

        s.set_defer_mode(DEFER_OK)
        s.service(10)
        replies = s.lines()
        self.assertEqual(len(replies), 1)
        self.assertReply(replies[0], "ok", "OLED_SCAN", rid="a")
        for t in range(11, 2000, 97):
            s.service(t)
        self.assertEqual(s.lines(), [])
        st = s.stats()
        self.assertEqual(st["requests"], 4)
        self.assertEqual(st["replies_ok"] + st["replies_error"], 4)
        self.assertEqual(st["deferred"], 1)

    def test_poll_errors_and_silent_polls_answer_once(self):
        s = self.new_session()
        s.set_defer_mode(DEFER_ERROR)
        s.handle(b"@e OLED_SCAN")
        s.service(1)
        rep = s.lines()
        self.assertEqual(len(rep), 1)
        self.assertReply(rep[0], "error", "OLED_SCAN", "busy", rid="e")
        self.assertEqual(rep[0]["msg"], "display busy")

        s.set_defer_mode(DEFER_SILENT)
        s.handle(b"@q OLED_SCAN")
        s.service(1)
        rep = s.lines()
        self.assertEqual(len(rep), 1)
        self.assertReply(rep[0], "error", "OLED_SCAN", "unsupported", rid="q")
        self.assertEqual(rep[0]["msg"], "handler produced no reply")
        self.assertEqual(s.stats()["handler_no_reply"], 1)
        self.assertFalse(s.deferred_pending())

    def test_the_last_of_defer_and_ok_wins(self):
        s = self.new_session()
        s.handle(b"@x DEFER_AFTER_OK")   # ok() then defer(): deferred
        self.assertEqual(s.lines(), [])
        self.assertTrue(s.deferred_pending())
        s.set_defer_mode(DEFER_OK)
        s.service(1)
        rep = s.lines()
        self.assertEqual(len(rep), 1)
        self.assertReply(rep[0], "ok", "DEFER_AFTER_OK", rid="x")
        self.assertNotIn("ignored", rep[0])

        s.handle(b"@y DEFER_THEN_OK")    # defer() then ok(): answered at once, nothing pending
        rep = s.lines()
        self.assertEqual(len(rep), 1)
        self.assertReply(rep[0], "ok", "DEFER_THEN_OK", rid="y")
        self.assertIs(rep[0]["immediate"], True)
        self.assertFalse(s.deferred_pending())
        s.service(10 ** 6)
        self.assertEqual(s.lines(), [])

    def test_service_waits_until_the_tx_queue_has_room_for_a_reply(self):
        s = self.new_session()
        s.handle(b"BIG 200")
        s.handle(b"BIG 200")
        self.assertFalse(s.has_room())
        s.set_defer_mode(DEFER_OK)
        s.handle(b"@r OLED_SCAN", now_ms=0)
        used = s.tx_used()
        s.service(1)
        self.assertEqual(s.tx_used(), used, "service() queued a reply without room for it")
        self.assertTrue(s.deferred_pending())
        self.assertEqual(len(s.lines()), 2)
        s.service(2)
        rep = s.lines()
        self.assertEqual(len(rep), 1)
        self.assertReply(rep[0], "ok", "OLED_SCAN", rid="r")
        self.assertEqual(s.stats()["replies_lost"], 0)


# =============================================================================================
# 8. Command table
# =============================================================================================
class CommandTableTests(ProtoTestCase):

    BROKEN = (
        (0, "an alias duplicating another entry's verb (INFO alias PING)"),
        (1, "a lower-case verb"),
        (2, "minArgs > maxArgs"),
        (3, "maxArgs > MAX_ARGS"),
        (4, "no handler"),
        (5, "the same alias twice in one entry (P|P)"),
    )

    def test_the_good_table_is_valid(self):
        s = self.new_session()
        self.assertTrue(self.lib.ss_table_valid(s.h))

    def test_broken_tables_are_rejected(self):
        for which, what in self.BROKEN:
            with self.subTest(what):
                self.assertFalse(self.lib.ss_bad_table_valid(which), f"tableValid() accepted {what}")


class BuildInfoTests(ProtoTestCase):

    def test_identity(self):
        self.assertEqual(self.lib.bi_protocol(), 2)
        self.assertEqual(self.lib.bi_protocol_macro(), 2)
        self.assertEqual(self.lib.bi_fw_version(), self.lib.bi_fw_version_macro())
        self.assertRegex(self.lib.bi_fw_version().decode(), r"^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$")
        self.assertEqual(self.lib.bi_build_id(), b"unknown", "host builds get no git identity")
        self.assertEqual(self.lib.bi_build_date(), b"unknown")
        self.assertEqual(self.lib.bi_device(), b"DriftPad")


if __name__ == "__main__":
    unittest.main()
