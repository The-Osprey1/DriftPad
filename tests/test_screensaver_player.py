"""Playlist and wrap-safe timing checks against the production screensaver Player."""

import ctypes
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import host_build as hb


COUNT = 6
DWELL = 20000
WIPE = 1500
U32 = 0xFFFFFFFF


class ScreensaverPlayer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = hb.build(
            "screensaver_player",
            hb.firmware_sources("screensaver_player.cpp")
            + hb.host_sources("screensaver_player_harness.cpp"),
            hb.default_include_dirs(),
        )
        cls.lib = ctypes.CDLL(str(path))
        cls.lib.ss_player_start.argtypes = [ctypes.c_uint32, ctypes.c_int8, ctypes.c_uint32]
        cls.lib.ss_player_start.restype = None
        cls.lib.ss_player_advance.argtypes = [ctypes.c_uint32]
        cls.lib.ss_player_advance.restype = None
        for name in ("shown", "incoming", "target", "shuffled"):
            getattr(cls.lib, "ss_player_" + name).restype = ctypes.c_int
        for name in ("transition_elapsed", "label_age"):
            fn = getattr(cls.lib, "ss_player_" + name)
            fn.argtypes = [ctypes.c_uint32]
            fn.restype = ctypes.c_uint32

    def sequence(self, seed, count=18, start=100):
        self.lib.ss_player_start(start, -1, seed)
        shown = [self.lib.ss_player_shown()]
        now = start
        for _ in range(count - 1):
            now = (now + DWELL) & U32
            self.lib.ss_player_advance(now)
            incoming = self.lib.ss_player_incoming()
            self.assertIn(incoming, range(COUNT))
            self.assertNotEqual(incoming, shown[-1])
            now = (now + WIPE) & U32
            self.lib.ss_player_advance(now)
            self.assertEqual(self.lib.ss_player_shown(), incoming)
            self.assertEqual(self.lib.ss_player_incoming(), -1)
            shown.append(self.lib.ss_player_shown())
        return shown

    def test_each_shuffle_bag_uses_every_animation_once(self):
        for seed in (0, 1, 2, 12345678, U32):
            with self.subTest(seed=seed):
                shown = self.sequence(seed, 300)
                for begin in range(0, len(shown), COUNT):
                    self.assertEqual(sorted(shown[begin:begin + COUNT]), list(range(COUNT)))

    def test_no_adjacent_repeat_including_bag_boundaries(self):
        for seed in range(64):
            with self.subTest(seed=seed):
                shown = self.sequence(seed, 60)
                self.assertTrue(all(a != b for a, b in zip(shown, shown[1:])))

    def test_seeds_produce_different_orders(self):
        orders = {tuple(self.sequence(seed, 12)) for seed in range(1, 33)}
        self.assertGreater(len(orders), 24)

    def test_same_seed_and_start_produce_the_same_sequence(self):
        first = self.sequence(184, 60)
        self.assertEqual(self.sequence(184, 60), first)

    def test_zero_seed_is_normalized_and_still_shuffles(self):
        self.assertEqual(self.sequence(0, 24), self.sequence(0x6D2B79F5, 24))

    def test_fixed_selections_never_enter_a_transition(self):
        for selected in range(COUNT):
            with self.subTest(selected=selected):
                self.lib.ss_player_start(100, selected, 0)
                self.assertEqual(self.lib.ss_player_shuffled(), 0)
                for now in (100, 20100, 21600, 100000, 0x80000000, 0xFFFFFFFF, 101):
                    self.lib.ss_player_advance(now)
                    self.assertEqual(self.lib.ss_player_shown(), selected)
                    self.assertEqual(self.lib.ss_player_target(), selected)
                    self.assertEqual(self.lib.ss_player_incoming(), -1)
                    self.assertEqual(self.lib.ss_player_transition_elapsed(now), 0)

    def test_start_is_immediate_and_does_not_wipe(self):
        self.lib.ss_player_start(0, -1, 72)
        shown = self.lib.ss_player_shown()
        self.assertIn(shown, range(COUNT))
        self.assertEqual(self.lib.ss_player_target(), shown)
        self.assertEqual(self.lib.ss_player_incoming(), -1)
        self.assertEqual(self.lib.ss_player_label_age(0), 0)
        self.lib.ss_player_advance(0)
        self.assertEqual(self.lib.ss_player_incoming(), -1)

    def test_no_early_advance_and_wipe_retains_outgoing(self):
        self.lib.ss_player_start(100, -1, 3)
        shown = self.lib.ss_player_shown()
        self.lib.ss_player_advance(100 + DWELL - 1)
        self.assertEqual(self.lib.ss_player_shown(), shown)
        self.assertEqual(self.lib.ss_player_incoming(), -1)
        self.lib.ss_player_advance(100 + DWELL)
        incoming = self.lib.ss_player_incoming()
        self.assertIn(incoming, range(COUNT))
        self.assertNotEqual(incoming, shown)
        self.assertEqual(self.lib.ss_player_target(), incoming)
        self.assertEqual(self.lib.ss_player_transition_elapsed(100 + DWELL), 0)
        self.lib.ss_player_advance(100 + DWELL + WIPE - 1)
        self.assertEqual(self.lib.ss_player_shown(), shown)
        self.assertEqual(self.lib.ss_player_incoming(), incoming)
        self.lib.ss_player_advance(100 + DWELL + WIPE)
        self.assertEqual(self.lib.ss_player_shown(), incoming)
        self.assertEqual(self.lib.ss_player_incoming(), -1)

    def test_label_changes_mid_wipe_and_age_continues_after_it(self):
        self.lib.ss_player_start(100, -1, 4)
        self.lib.ss_player_advance(100 + DWELL)
        midpoint = 100 + DWELL + WIPE // 2
        self.assertEqual(self.lib.ss_player_label_age(midpoint - 1), DWELL + WIPE // 2 - 1)
        self.assertEqual(self.lib.ss_player_label_age(midpoint), 0)
        self.assertEqual(self.lib.ss_player_label_age(midpoint + 1), 1)
        self.lib.ss_player_advance(100 + DWELL + WIPE)
        self.assertEqual(self.lib.ss_player_label_age(100 + DWELL + WIPE), WIPE // 2)
        self.assertEqual(self.lib.ss_player_label_age(100 + DWELL + WIPE + 400), WIPE // 2 + 400)

    def test_dwell_begins_at_wipe_completion(self):
        self.lib.ss_player_start(100, -1, 5)
        self.lib.ss_player_advance(100 + DWELL)
        completion = 100 + DWELL + WIPE
        self.lib.ss_player_advance(completion)
        shown = self.lib.ss_player_shown()
        self.lib.ss_player_advance(completion + DWELL - 1)
        self.assertEqual(self.lib.ss_player_shown(), shown)
        self.assertEqual(self.lib.ss_player_incoming(), -1)
        self.lib.ss_player_advance(completion + DWELL)
        self.assertNotEqual(self.lib.ss_player_incoming(), shown)

    def test_delayed_idle_call_starts_one_fresh_wipe(self):
        self.lib.ss_player_start(100, -1, 6)
        shown = self.lib.ss_player_shown()
        self.lib.ss_player_advance(1000000000)
        self.assertEqual(self.lib.ss_player_shown(), shown)
        incoming = self.lib.ss_player_incoming()
        self.assertIn(incoming, range(COUNT))
        self.assertNotEqual(incoming, shown)
        self.assertEqual(self.lib.ss_player_transition_elapsed(1000000000), 0)
        self.lib.ss_player_advance(1000000000 + WIPE)
        self.assertEqual(self.lib.ss_player_shown(), incoming)
        self.assertEqual(self.lib.ss_player_incoming(), -1)

    def test_delayed_active_call_can_finish_and_start_one_fresh_wipe(self):
        self.lib.ss_player_start(100, -1, 7)
        self.lib.ss_player_advance(100 + DWELL)
        first_incoming = self.lib.ss_player_incoming()
        self.lib.ss_player_advance(1000000000)
        self.assertEqual(self.lib.ss_player_shown(), first_incoming)
        second_incoming = self.lib.ss_player_incoming()
        self.assertIn(second_incoming, range(COUNT))
        self.assertNotEqual(second_incoming, first_incoming)
        self.assertEqual(self.lib.ss_player_transition_elapsed(1000000000), 0)
        self.lib.ss_player_advance(1000000000 + WIPE)
        self.assertEqual(self.lib.ss_player_shown(), second_incoming)
        self.assertEqual(self.lib.ss_player_incoming(), -1)

    def test_dwell_and_transition_are_safe_across_clock_wrap(self):
        for start in (0, U32, U32 - DWELL - 500, 0x80000010):
            with self.subTest(start=start):
                self.lib.ss_player_start(start, -1, 8)
                shown = self.lib.ss_player_shown()
                due = (start + DWELL) & U32
                self.lib.ss_player_advance((due - 1) & U32)
                self.assertEqual(self.lib.ss_player_incoming(), -1)
                self.lib.ss_player_advance(due)
                incoming = self.lib.ss_player_incoming()
                self.assertNotEqual(shown, incoming)
                halfway = (due + WIPE // 2) & U32
                self.assertEqual(self.lib.ss_player_label_age(halfway), 0)
                self.assertEqual(self.lib.ss_player_transition_elapsed(halfway), WIPE // 2)
                end = (due + WIPE) & U32
                self.lib.ss_player_advance(end)
                self.assertEqual(self.lib.ss_player_shown(), incoming)
                self.assertEqual(self.lib.ss_player_incoming(), -1)
                self.assertEqual(self.lib.ss_player_label_age(end), WIPE // 2)

    def test_same_millisecond_restart_resets_wipe_and_label(self):
        now = 100 + DWELL
        self.lib.ss_player_start(100, -1, 9)
        self.lib.ss_player_advance(now)
        self.assertGreaterEqual(self.lib.ss_player_incoming(), 0)
        self.lib.ss_player_start(now, 3, 0)
        self.assertEqual(self.lib.ss_player_shown(), 3)
        self.assertEqual(self.lib.ss_player_incoming(), -1)
        self.assertEqual(self.lib.ss_player_transition_elapsed(now), 0)
        self.assertEqual(self.lib.ss_player_label_age(now), 0)
        self.lib.ss_player_advance(now)
        self.assertEqual(self.lib.ss_player_incoming(), -1)
        self.lib.ss_player_start(now, -1, 9)
        self.assertEqual(self.lib.ss_player_label_age(now), 0)
        self.assertEqual(self.lib.ss_player_incoming(), -1)
        self.assertEqual(self.lib.ss_player_shuffled(), 1)

    def test_invalid_index_uses_safe_shuffle_mode(self):
        for selected in (-128, -2, COUNT, 127):
            with self.subTest(selected=selected):
                self.lib.ss_player_start(0, selected, 10)
                self.assertEqual(self.lib.ss_player_shuffled(), 1)
                self.assertIn(self.lib.ss_player_shown(), range(COUNT))
                self.assertEqual(self.lib.ss_player_incoming(), -1)


if __name__ == "__main__":
    unittest.main()
