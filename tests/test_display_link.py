"""
test_display_link.py - The core 0 -> core 1 display channel (firmware/src/display_link.cpp).

Scope: production C++ executed on the host. The module is compiled unmodified with
tests/firmware_host/display_link_harness.cpp; two host threads play core 0 and core 1.

What this shows and what it does not: the sequence lock never hands the reader a torn snapshot
and never goes backwards, requests are never lost, and a result is visible before its ticket, on
the host's x86-64 memory model with real concurrency. The RP2040 (two Cortex-M0+ cores, no
caches, DMB barriers) is a simpler memory system, but it is not exercised here; the hardware
acceptance checklist covers the display under load.

A control runs the same stress over an unprotected buffer and must observe torn copies, so a
passing result is not an artifact of a stress that never races.
"""

import ctypes
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import host_build as hb

WAKE, SLEEP, SCREENSAVER, TEST_PATTERN, SCAN_BUS = range(5)
U32x4 = ctypes.c_uint32 * 4
U32x2 = ctypes.c_uint32 * 2


def load():
    path = hb.build("display_link", hb.firmware_sources("display_link.cpp") +
                    hb.host_sources("display_link_harness.cpp"), hb.default_include_dirs())
    lib = ctypes.CDLL(str(path))
    u32, i32, i64 = ctypes.c_uint32, ctypes.c_int32, ctypes.c_int64
    sigs = {
        "dl_reset": ([], None), "dl_snapshot_size": ([], ctypes.c_int), "dl_publish": ([u32], None),
        "dl_read": ([], i64), "dl_post": ([ctypes.c_int, i32], u32),
        "dl_pending": ([ctypes.c_int, ctypes.POINTER(i32)], u32), "dl_mark_served": ([ctypes.c_int, u32], None),
        "dl_stamp": ([ctypes.c_int], u32),
        "dl_is_served": ([ctypes.c_int, u32], ctypes.c_int),
        "dl_set_scan": ([ctypes.POINTER(ctypes.c_uint8), ctypes.c_uint8], None),
        "dl_scan_result": ([ctypes.POINTER(ctypes.c_uint8), ctypes.c_uint8], ctypes.c_int),
        "dl_note_stale": ([], None), "dl_stats": ([U32x4], None),
        "dl_stress": ([u32, U32x4], None), "dl_naive_stress": ([u32, U32x2], None),
        "dl_request_stress": ([ctypes.c_int, u32, U32x4], None),
    }
    for name, (args, res) in sigs.items():
        fn = getattr(lib, name)
        fn.argtypes, fn.restype = args, res
    return lib


class TestSnapshot(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.lib = load()

    def setUp(self):
        self.lib.dl_reset()

    def stats(self):
        out = U32x4()
        self.lib.dl_stats(out)
        return dict(zip(("published", "reads", "retries", "stale"), out))

    def test_nothing_is_read_before_the_first_publish(self):
        self.assertEqual(self.lib.dl_read(), -2)

    def test_the_newest_publish_is_read(self):
        for n in (1, 2, 77):
            self.lib.dl_publish(n)
        self.assertEqual(self.lib.dl_read(), 77)
        self.assertEqual(self.lib.dl_read(), 77, "reading does not consume")
        s = self.stats()
        self.assertEqual((s["published"], s["reads"], s["retries"]), (3, 2, 0))

    def test_the_snapshot_stays_small(self):
        # Copied twice per display frame and once per scan on core 0
        self.assertLessEqual(self.lib.dl_snapshot_size(), 256)

    def test_concurrent_publishing_never_yields_a_torn_or_older_snapshot(self):
        out = U32x4()
        self.lib.dl_stress(300000, out)
        reads, torn, backwards, failed = out
        self.assertGreater(reads, 1000, "the reader must actually run alongside the writer")
        self.assertEqual(torn, 0, f"{torn} torn snapshots out of {reads}")
        self.assertEqual(backwards, 0)
        s = self.stats()
        self.assertGreater(s["retries"], 0, "the stress never raced a publish, so it proves nothing")

    def test_control_an_unprotected_buffer_does_tear_under_the_same_stress(self):
        out = U32x2()
        for _ in range(5):
            self.lib.dl_naive_stress(300000, out)
            if out[1] > 0:
                break
        self.assertGreater(out[0], 1000)
        self.assertGreater(out[1], 0, "without the sequence lock copies must tear; otherwise the "
                                      "stress above is not able to detect tearing on this machine")


class TestRequests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.lib = load()

    def setUp(self):
        self.lib.dl_reset()

    def pending(self, r):
        arg = ctypes.c_int32(0)
        return self.lib.dl_pending(r, ctypes.byref(arg)), arg.value

    def test_tickets_are_served_once_and_coalesce(self):
        self.assertEqual(self.pending(WAKE), (0, 0))
        t1 = self.lib.dl_post(SCREENSAVER, 2)
        t2 = self.lib.dl_post(SCREENSAVER, 5)
        self.assertEqual((t1, t2), (1, 2))
        self.assertFalse(self.lib.dl_is_served(SCREENSAVER, t1))
        self.assertEqual(self.pending(SCREENSAVER), (2, 5), "the newest ticket and argument")
        self.lib.dl_mark_served(SCREENSAVER, 2)
        self.assertTrue(self.lib.dl_is_served(SCREENSAVER, t1) and self.lib.dl_is_served(SCREENSAVER, t2))
        self.assertEqual(self.pending(SCREENSAVER), (0, 0))
        self.assertEqual(self.pending(WAKE), (0, 0), "kinds are independent")

    def test_a_request_posted_while_serving_stays_pending(self):
        t1 = self.lib.dl_post(WAKE, 0)
        seen, _ = self.pending(WAKE)
        t2 = self.lib.dl_post(WAKE, 0)             # arrives while core 1 serves t1
        self.lib.dl_mark_served(WAKE, seen)
        self.assertTrue(self.lib.dl_is_served(WAKE, t1))
        self.assertFalse(self.lib.dl_is_served(WAKE, t2))
        self.assertEqual(self.pending(WAKE)[0], t2)

    def test_scan_result_is_complete_before_its_ticket(self):
        t = self.lib.dl_post(SCAN_BUS, 0)
        found = (ctypes.c_uint8 * 3)(0x3C, 0x48, 0x50)
        self.lib.dl_set_scan(found, 3)
        self.lib.dl_mark_served(SCAN_BUS, t)
        self.assertTrue(self.lib.dl_is_served(SCAN_BUS, t))
        out = (ctypes.c_uint8 * 8)()
        self.assertEqual(self.lib.dl_scan_result(out, 8), 3)
        self.assertEqual(list(out[:3]), [0x3C, 0x48, 0x50])
        many = (ctypes.c_uint8 * 12)(*range(1, 13))
        self.lib.dl_set_scan(many, 12)
        self.assertEqual(self.lib.dl_scan_result(out, 8), 12, "the real count, even beyond the buffer")
        self.assertEqual(list(out), list(range(1, 9)))

    def test_no_request_is_lost_under_concurrency(self):
        out = U32x4()
        self.lib.dl_request_stress(WAKE, 200000, out)
        posted, served, backwards, serves = out
        self.assertEqual(posted, 200000)
        self.assertEqual(served, posted, "every posted ticket ends up served")
        self.assertEqual(backwards, 0, "arguments never go backwards")
        self.assertGreater(serves, 1)

    def test_stamps_give_the_posting_order_across_kinds(self):
        """Core 1 applies a sleep and the wake that followed it in that order."""
        self.lib.dl_post(SLEEP, 0)
        self.lib.dl_post(WAKE, 0)
        self.assertLess(self.lib.dl_stamp(SLEEP), self.lib.dl_stamp(WAKE))
        self.lib.dl_post(SLEEP, 0)                 # a newer sleep now comes last
        self.assertGreater(self.lib.dl_stamp(SLEEP), self.lib.dl_stamp(WAKE))

    def test_unknown_kinds_and_ticket_zero_are_ignored(self):
        self.assertEqual(self.lib.dl_post(99, 0), 0)
        self.assertFalse(self.lib.dl_is_served(WAKE, 0))
        self.assertEqual(self.pending(99), (0, 0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
