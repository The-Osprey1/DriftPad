"""
test_timing.py - Scan-loop and background-operation instrumentation behind TIMING and SCAN_RATE
(firmware/include/timing.h).

Scope: production C++ executed on the host. tests/firmware_host/proto_lib.py compiles, unmodified,
firmware/src/timing.cpp (plus json_writer.cpp, tx_queue.cpp and protocol.cpp for the TIMING /
SCAN_RATE replies) with tests/firmware_host/proto_shim.cpp, whose fake microsecond clock drives
every scenario. Scan marks are given explicitly, so nothing depends on wall-clock time.

Every TIMING / SCAN_RATE text is parsed with json.loads.

Pure Python standard library + a host C++ compiler (see tests/host_build.py). Without a compiler
the suite is skipped through host_build's SkipTest.
"""

import ctypes
import json
import sys
import unittest
from pathlib import Path
from typing import Dict, List

TESTS_DIR = Path(__file__).resolve().parent
HOST_DIR = TESTS_DIR / "firmware_host"
for _p in (TESTS_DIR, HOST_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import proto_lib  # noqa: E402

M32 = 0xFFFFFFFF

# Timing::Op, in header order, with the names opName() documents
OP_NAMES = ("command", "telemetry", "save", "calibration", "publish", "display_request", "tx_drain")
OP_COMMAND, OP_TELEMETRY, OP_SAVE = 0, 1, 2

# timing.h: inclusive upper bounds of the gap buckets; the last bucket is "> 50 ms"
GAP_LIMITS_US = (1100, 1500, 2000, 5000, 10000, 50000)
GAP_KEYS = ("le_1100", "le_1500", "le_2000", "le_5000", "le_10000", "le_50000", "gt_50000")


def expected_bucket(gap_us: int) -> int:
    for i, limit in enumerate(GAP_LIMITS_US):
        if gap_us <= limit:
            return i
    return len(GAP_LIMITS_US)


def parse_json(raw: bytes) -> dict:
    def unique(pairs):
        keys = [k for k, _ in pairs]
        dups = sorted({k for k in keys if keys.count(k) > 1})
        if dups:
            raise ValueError(f"duplicate keys {dups}")
        return dict(pairs)
    try:
        return json.loads(raw.decode("ascii"), object_pairs_hook=unique)
    except ValueError as e:
        raise AssertionError(f"not valid JSON ({e}): {raw[:300]!r}")


class TimingHandle:
    """A Timing instance on the shim's fake clock. Scans are marked at explicit times."""

    def __init__(self, lib, period_us: int = 1000, clock: bool = True):
        self.lib = lib
        self.h = lib.tm_create(period_us) if clock else lib.tm_create_no_clock(period_us)
        self.last = None   # start time of the latest scan

    def close(self):
        if self.h:
            self.lib.tm_destroy(self.h)
            self.h = None

    def at(self, begin_us: int, duration_us: int = 10):
        """One scan starting at begin_us (absolute, wraps at 32 bits)."""
        self.lib.tm_scan_begin(self.h, begin_us & M32)
        self.lib.tm_scan_end(self.h, (begin_us + duration_us) & M32)
        self.last = begin_us

    def after(self, gap_us: int, count: int = 1, duration_us: int = 10):
        """`count` scans, each starting `gap_us` after the previous one."""
        for _ in range(count):
            self.at(self.last + gap_us, duration_us)

    def get(self) -> Dict[str, object]:
        out = proto_lib.u32_array(14)
        self.lib.tm_get(self.h, out)
        v = list(out)
        return {"scans": v[0], "rate_hz": v[1], "max_gap_us": v[2], "missed": v[3], "scan_max_us": v[4],
                "durations": v[5], "avg_tenths_us": v[6], "hist": v[7:14]}

    def op(self, op: int) -> Dict[str, int]:
        out = proto_lib.u32_array(3)
        self.lib.tm_op(self.h, op, out)
        return {"last": out[0], "max": out[1], "count": out[2]}

    def timing_json(self, uptime_ms: int = 0, with_tx: bool = False) -> dict:
        buf = ctypes.create_string_buffer(8192)
        n = self.lib.tm_json(self.h, uptime_ms, 1 if with_tx else 0, buf, len(buf))
        if n < 0:
            raise AssertionError("TIMING fields did not form a complete JSON object")
        return parse_json(buf.raw[:n])

    def scan_rate_json(self, consume: bool = True) -> dict:
        buf = ctypes.create_string_buffer(512)
        n = self.lib.tm_scan_rate_json(self.h, 1 if consume else 0, buf, len(buf))
        if n < 0:
            raise AssertionError("SCAN_RATE fields did not form a complete JSON object")
        return parse_json(buf.raw[:n])


class TimingTestCase(unittest.TestCase):
    lib = None

    @classmethod
    def setUpClass(cls):
        cls.lib = proto_lib.load()   # unittest.SkipTest when no host compiler exists

    def new_timing(self, period_us: int = 1000, clock: bool = True) -> TimingHandle:
        t = TimingHandle(self.lib, period_us, clock)
        self.addCleanup(t.close)
        return t


# =============================================================================================
# Scan statistics
# =============================================================================================
class ScanStatisticsTests(TimingTestCase):

    def test_constants_match_the_header(self):
        self.assertEqual(self.lib.tm_gap_buckets(), len(GAP_KEYS))
        self.assertEqual(tuple(self.lib.tm_gap_limit(i) for i in range(len(GAP_LIMITS_US))), GAP_LIMITS_US)
        self.assertEqual(self.lib.tm_op_count(), len(OP_NAMES))
        self.assertEqual(tuple(self.lib.tm_op_name(i).decode() for i in range(len(OP_NAMES))), OP_NAMES)
        self.assertEqual(self.lib.tm_op_name(99), b"unknown")

    def test_steady_1000us_scans_report_1000_hz(self):
        t = self.new_timing()
        t.at(123_456)
        t.after(1000, 499)
        g = t.get()
        self.assertEqual(g["rate_hz"], 0, "no full second has passed yet")
        t.after(1000, 1500)
        g = t.get()
        self.assertEqual(g["scans"], 2000)
        self.assertEqual(g["rate_hz"], 1000)
        self.assertEqual(g["hist"], [1999, 0, 0, 0, 0, 0, 0], "every 1.0 ms gap belongs in <= 1.1 ms")
        self.assertEqual(g["max_gap_us"], 1000)
        self.assertEqual(g["missed"], 0)

    def test_other_steady_rates(self):
        fast = self.new_timing()
        fast.at(0)
        fast.after(500, 3000)
        g = fast.get()
        self.assertEqual(g["rate_hz"], 2000)
        self.assertEqual((g["hist"][0], g["missed"]), (3000, 0))

        slow = self.new_timing()
        slow.at(0)
        slow.after(2000, 1000)
        g = slow.get()
        self.assertEqual(g["rate_hz"], 500)
        self.assertEqual(g["hist"], [0, 0, 1000, 0, 0, 0, 0])
        self.assertEqual(g["missed"], 1000, "every 2 ms gap is later than 1.5 x the 1 ms period")

    def test_single_7ms_stall(self):
        t = self.new_timing()
        t.at(0)
        t.after(1000, 499)
        t.after(7000)          # one scan 7 ms after the previous one
        t.after(1000, 499)
        g = t.get()
        self.assertEqual(g["scans"], 1000)
        self.assertEqual(g["missed"], 1, "exactly one missed deadline")
        self.assertEqual(g["max_gap_us"], 7000)
        self.assertEqual(g["hist"], [998, 0, 0, 0, 1, 0, 0], "the 7 ms gap belongs in <= 10 ms")
        # scan_hz counts the scans of the first full second: the stall cost 6 of them
        self.assertEqual(g["rate_hz"], 994)
        self.assertEqual(t.scan_rate_json()["max_gap_us"], 7000)

    def test_gap_histogram_bucket_boundaries_and_missed_deadlines(self):
        wrong = []
        for gap in (1, 1000, 1100, 1101, 1500, 1501, 2000, 2001, 5000, 5001, 10000, 10001,
                    50000, 50001, 1_000_000, 5_000_000):
            t = self.new_timing()
            t.at(10_000)
            t.after(gap)
            g = t.get()
            hist = [0] * len(GAP_KEYS)
            hist[expected_bucket(gap)] = 1
            want = (hist, gap, int(gap > 1500))
            got = (g["hist"], g["max_gap_us"], g["missed"])
            if got != want:
                wrong.append(f"gap {gap} us: hist/max/missed {got}, want {want}")
        self.assertEqual(wrong, [])

    def test_missed_deadline_threshold_follows_the_period(self):
        t = self.new_timing(period_us=333)   # 1.5 x 333 = 499.5 us
        t.at(0)
        t.after(499)
        t.after(500)
        self.assertEqual(t.get()["missed"], 1, "499 us is on time, 500 us is late for a 333 us period")

    def test_scan_duration_max_and_average(self):
        t = self.new_timing()
        for i, dur in enumerate((100, 101, 250, 99)):
            t.at(i * 1000, dur)
        g = t.get()
        self.assertEqual((g["durations"], g["scan_max_us"]), (4, 250))
        self.assertEqual(g["avg_tenths_us"], 1375, "(100 + 101 + 250 + 99) / 4 = 137.5 us")
        doc = t.timing_json()
        self.assertEqual(doc["scan_max_us"], 250)
        self.assertEqual(doc["scan_avg_us"], 137.5)

        t2 = self.new_timing()
        for i, dur in enumerate((1, 2, 2)):
            t2.at(i * 1000, dur)
        self.assertEqual(t2.get()["avg_tenths_us"], 17, "1.667 us rounds to 1.7")

    def test_scan_end_without_a_scan_begin_is_ignored(self):
        t = self.new_timing()
        self.lib.tm_scan_end(t.h, 500)
        self.assertEqual(t.get()["durations"], 0)
        self.lib.tm_scan_begin(t.h, 1000)
        self.lib.tm_scan_end(t.h, 1040)
        self.lib.tm_scan_end(t.h, 9000)   # second end for the same scan
        g = t.get()
        self.assertEqual((g["durations"], g["scan_max_us"]), (1, 40))

    def test_scan_rate_after_a_stall_longer_than_one_second(self):
        t = self.new_timing()
        t.at(0)
        t.after(1000, 2500)            # 0 .. 2.5 s at 1 kHz; windows close at 1 s and 2 s
        self.assertEqual(t.get()["rate_hz"], 1000)
        t.after(3_500_000)             # nothing for 3.5 s
        # The window that started at 2.0 s held 501 scans and closed after 4.0 s: 125 per second
        self.assertEqual(t.get()["rate_hz"], 125, "a long stall must lower the rate, not keep 1000")
        t.after(1000, 2100)
        self.assertEqual(t.get()["rate_hz"], 1000, "the rate recovers once scanning is steady again")

    def test_32bit_microsecond_wrap_is_harmless(self):
        t = self.new_timing()
        t.at(2 ** 32 - 700_000)
        t.after(1000, 2000)            # crosses the wrap after 700 scans
        g = t.get()
        self.assertEqual(g["rate_hz"], 1000)
        self.assertEqual(g["hist"], [2000, 0, 0, 0, 0, 0, 0])
        self.assertEqual((g["max_gap_us"], g["missed"]), (1000, 0))

        d = self.new_timing()
        self.lib.tm_scan_begin(d.h, 0xFFFFFFF0)
        self.lib.tm_scan_end(d.h, 0x10)
        self.assertEqual(d.get()["scan_max_us"], 0x20, "a scan spanning the wrap lasts 32 us")


# =============================================================================================
# Operation timers
# =============================================================================================
class OperationTimerTests(TimingTestCase):

    def test_record_op_keeps_last_max_and_count(self):
        t = self.new_timing()
        for us in (30, 80, 50):
            self.lib.tm_record_op(t.h, OP_COMMAND, us)
        self.assertEqual(t.op(OP_COMMAND), {"last": 50, "max": 80, "count": 3})
        for op in range(1, len(OP_NAMES)):
            self.assertEqual(t.op(op), {"last": 0, "max": 0, "count": 0}, OP_NAMES[op])
        self.lib.tm_record_op(t.h, len(OP_NAMES), 5)   # Op::Count is not an operation
        self.assertEqual(t.op(len(OP_NAMES)), {"last": 0, "max": 0, "count": 0})

    def test_scoped_timer_uses_the_timing_clock(self):
        t = self.new_timing()
        self.lib.tm_set_clock(5000)
        self.lib.tm_scoped(t.h, OP_SAVE, 1234)
        self.assertEqual(t.op(OP_SAVE), {"last": 1234, "max": 1234, "count": 1})
        self.lib.tm_set_clock(0xFFFFFF00)
        self.lib.tm_scoped(t.h, OP_SAVE, 0x200)   # across the clock wrap
        self.assertEqual(t.op(OP_SAVE), {"last": 0x200, "max": 1234, "count": 2})

    def test_clock_overloads(self):
        t = self.new_timing()
        self.lib.tm_set_clock(5000)
        self.assertEqual(self.lib.tm_now(t.h), 5000)
        self.lib.tm_scan_begin_clock(t.h)
        self.lib.tm_set_clock(5300)
        self.lib.tm_scan_end_clock(t.h)
        self.lib.tm_set_clock(6000)
        self.lib.tm_scan_begin_clock(t.h)
        g = t.get()
        self.assertEqual((g["scans"], g["scan_max_us"], g["max_gap_us"]), (2, 300, 1000))

        no_clock = self.new_timing(clock=False)
        self.assertEqual(self.lib.tm_now(no_clock.h), 0, "without a clock now() is 0")
        self.lib.tm_scoped(no_clock.h, OP_TELEMETRY, 999)
        self.assertEqual(no_clock.op(OP_TELEMETRY), {"last": 0, "max": 0, "count": 1})


# =============================================================================================
# reset()
# =============================================================================================
class ResetTests(TimingTestCase):

    def test_reset_clears_accumulators_but_keeps_the_rate_window(self):
        t = self.new_timing()
        t.at(0)
        t.after(1000, 1200)
        t.after(9000)
        t.after(1000, 100)
        for op in range(len(OP_NAMES)):
            self.lib.tm_record_op(t.h, op, 100 + op)
        self.assertEqual(t.get()["rate_hz"], 1000)

        self.lib.tm_reset(t.h)
        g = t.get()
        self.assertEqual({k: v for k, v in g.items() if k != "rate_hz"},
                         {"scans": 0, "max_gap_us": 0, "missed": 0, "scan_max_us": 0, "durations": 0,
                          "avg_tenths_us": 0, "hist": [0] * 7})
        self.assertEqual(g["rate_hz"], 1000, "scan_hz is a rate, not an accumulator")
        for op in range(len(OP_NAMES)):
            self.assertEqual(t.op(op), {"last": 0, "max": 0, "count": 0}, OP_NAMES[op])
        self.assertEqual(t.scan_rate_json()["max_gap_us"], 0, "reset() also clears the SCAN_RATE max gap")

        # The next scan starts a new gap chain: the 5 ms since the last scan is not a gap
        t.after(5000)
        g = t.get()
        self.assertEqual((g["scans"], g["hist"], g["max_gap_us"], g["missed"]), (1, [0] * 7, 0, 0))
        t.after(1000)
        g = t.get()
        self.assertEqual((g["hist"][0], g["max_gap_us"]), (1, 1000))
        # The one-second window that began at 1.0 s (before the reset) keeps counting and closes
        # at 2.0 s: 1000 scans minus 8 lost to the 9 ms stall and 4 lost to the 5 ms pause
        t.after(1000, 1500)
        self.assertEqual(t.get()["rate_hz"], 988, "reset() must not restart the scan_hz window")
        t.after(1000, 1000)
        self.assertEqual(t.get()["rate_hz"], 1000)


# =============================================================================================
# TIMING / SCAN_RATE output
# =============================================================================================
class TimingOutputTests(TimingTestCase):

    BASE_KEYS = ["type", "uptime_ms", "period_us", "scans", "scan_hz", "max_gap_us", "missed_deadlines",
                 "gap_hist_us", "scan_max_us", "scan_avg_us"]
    OP_KEYS = [f"{name}_{suffix}" for name in OP_NAMES for suffix in ("last_us", "max_us", "count")]
    TX_KEYS = ["tx_queue_bytes", "tx_used", "tx_high_water", "tx_bytes_queued", "tx_bytes_sent",
               "tx_events_dropped", "tx_replies_rejected"]

    def scenario(self) -> TimingHandle:
        t = self.new_timing()
        t.at(0, 40)
        t.after(1000, 1100, 40)
        t.after(3000, 1, 70)
        t.after(1000, 50, 40)
        self.lib.tm_record_op(t.h, OP_COMMAND, 25)
        self.lib.tm_record_op(t.h, OP_SAVE, 40000)
        return t

    def test_timing_json_contains_the_documented_fields(self):
        t = self.scenario()
        g = t.get()
        doc = t.timing_json(uptime_ms=987654)
        self.assertEqual(list(doc), self.BASE_KEYS + self.OP_KEYS, "TIMING field set/order")
        self.assertEqual(doc["type"], "timing")
        self.assertEqual(doc["uptime_ms"], 987654)
        self.assertEqual(doc["period_us"], 1000)
        self.assertEqual(doc["scans"], g["scans"])
        self.assertEqual(doc["scan_hz"], g["rate_hz"])
        self.assertEqual(doc["scan_hz"], 1000)
        self.assertEqual(doc["max_gap_us"], 3000)
        self.assertEqual(doc["missed_deadlines"], 1)
        self.assertEqual(list(doc["gap_hist_us"]), list(GAP_KEYS))
        self.assertEqual(list(doc["gap_hist_us"].values()), g["hist"])
        self.assertEqual(doc["gap_hist_us"]["le_5000"], 1)
        self.assertEqual(doc["scan_max_us"], 70)
        self.assertAlmostEqual(doc["scan_avg_us"], g["avg_tenths_us"] / 10)
        self.assertEqual((doc["command_last_us"], doc["command_max_us"], doc["command_count"]), (25, 25, 1))
        self.assertEqual((doc["save_last_us"], doc["save_max_us"], doc["save_count"]), (40000, 40000, 1))
        self.assertEqual(doc["tx_drain_count"], 0)
        self.assertFalse(any(k.startswith("tx_") and k not in self.OP_KEYS for k in doc),
                         "tx_* fields must be omitted without a TxQueue")

    def test_timing_json_with_a_tx_queue(self):
        t = self.scenario()
        doc = t.timing_json(with_tx=True)
        self.assertEqual(list(doc), self.BASE_KEYS + self.OP_KEYS + self.TX_KEYS)
        # the shim's queue holds one 7-byte line plus its '\n'
        self.assertEqual(doc["tx_queue_bytes"], self.lib.tx_capacity())
        self.assertEqual((doc["tx_used"], doc["tx_high_water"], doc["tx_bytes_queued"]), (8, 8, 8))
        self.assertEqual((doc["tx_bytes_sent"], doc["tx_events_dropped"], doc["tx_replies_rejected"]), (0, 0, 0))

    def test_scan_rate_legacy_fields(self):
        t = self.new_timing()
        t.at(0)
        t.after(1000, 1000)
        t.after(4000)
        doc = t.scan_rate_json(consume=False)
        self.assertEqual(doc, {"type": "scan_rate", "hz": 1000, "max_gap_us": 4000})
        self.assertEqual(list(doc), ["type", "hz", "max_gap_us"])
        self.assertEqual(t.scan_rate_json(consume=False)["max_gap_us"], 4000, "consume=false keeps it")
        self.assertEqual(t.scan_rate_json()["max_gap_us"], 4000)
        self.assertEqual(t.scan_rate_json()["max_gap_us"], 0, "restarts after being reported")
        t.after(1000, 10)
        self.assertEqual(t.scan_rate_json()["max_gap_us"], 1000, "largest gap since the previous SCAN_RATE")
        self.assertEqual(t.get()["max_gap_us"], 4000, "TIMING's max gap is not consumed by SCAN_RATE")
        self.assertEqual(t.timing_json()["max_gap_us"], 4000)


# =============================================================================================
# Through the dispatcher and scheduler
# =============================================================================================
class TimingCommandTests(TimingTestCase):

    def session(self):
        s = self.lib.ss_create()
        self.addCleanup(self.lib.ss_destroy, s)
        return s

    def reply(self, s, line: bytes) -> dict:
        self.lib.ss_handle(s, line, 1, 0)
        self.lib.ss_drain(s, 1 << 20, -1)
        raw = proto_lib.take_text(self.lib.ss_take_output, s, 1 << 16)
        lines = raw.split(b"\n")
        self.assertEqual(len(lines), 2, f"{line!r} must produce exactly one reply line: {raw[:200]!r}")
        return parse_json(lines[0])

    def test_timing_and_scan_rate_commands(self):
        s = self.session()
        for i in range(1001):
            self.lib.ss_scan(s, i * 1000)
        self.lib.ss_scan(s, 1_000_000 + 3000)

        rep = self.reply(s, b"@t1 TIMING")
        self.assertEqual(list(rep)[:4], ["status", "id", "cmd", "type"])
        self.assertEqual((rep["status"], rep["id"], rep["cmd"], rep["type"]), ("ok", "t1", "TIMING", "timing"))
        self.assertEqual((rep["scans"], rep["scan_hz"], rep["max_gap_us"], rep["missed_deadlines"]),
                         (1002, 1000, 3000, 1))
        self.assertEqual(rep["tx_queue_bytes"], self.lib.tx_capacity())

        rep = self.reply(s, b"scan_rate")
        self.assertEqual(rep, {"status": "ok", "cmd": "SCAN_RATE", "type": "scan_rate", "hz": 1000,
                               "max_gap_us": 3000})
        self.assertEqual(self.reply(s, b"SCAN_RATE")["max_gap_us"], 0, "consumed by the previous SCAN_RATE")

        rep = self.reply(s, b"TIMING reset")
        self.assertIs(rep["reset"], True)
        self.assertEqual(rep["scans"], 1002, "the RESET reply reports the values before the reset")
        rep = self.reply(s, b"TIMING")
        self.assertEqual((rep["scans"], rep["max_gap_us"], rep["missed_deadlines"]), (0, 0, 0))
        self.assertEqual(rep["scan_hz"], 1000)
        self.assertNotIn("reset", rep)

        rep = self.reply(s, b"TIMING NOW")
        self.assertEqual((rep["status"], rep["cmd"], rep["code"]), ("error", "TIMING", "bad_arguments"))
        rep = self.reply(s, b"TIMING RESET NOW")
        self.assertEqual((rep["code"], rep["min_args"], rep["max_args"]), ("bad_arguments", 0, 1))

    def test_scheduler_times_every_handled_line_as_a_command(self):
        s = self.session()
        self.lib.ss_set_clock_us(777)
        data = b"PING\n\n   \r\n@a ECHO x\r\n" + b"x" * 200 + b"\nPI\x01NG\nhello\n"
        self.lib.ss_rx_push(s, data, len(data))
        handled = 0
        for _ in range(len(data)):
            if not self.lib.ss_rx_pending(s):
                break
            handled += self.lib.ss_step(s, 0, 0)
            self.lib.ss_drain(s, 1 << 20, -1)
        self.assertEqual(handled, 5, "PING, ECHO, the over-long line, the control-byte line, hello")
        out = proto_lib.u32_array(3)
        self.lib.ss_command_op(s, out)
        self.assertEqual(list(out), [0, 0, 5], "one Command op per handled line (the fake clock stood still)")


if __name__ == "__main__":
    unittest.main()
