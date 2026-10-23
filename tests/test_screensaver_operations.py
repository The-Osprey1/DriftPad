"""Production OLED playback, lifecycle and animation timing on a stubbed panel."""
import ctypes
import unittest

import oled_host as oh

SCOPE = "compiled firmware on host"


class ScreensaverOperations(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lib = oh.load()
        cls.lib.oled_saver_start.argtypes = [ctypes.c_int, ctypes.c_uint32]
        cls.lib.oled_saver_step.argtypes = [ctypes.c_uint32, ctypes.c_char_p]
        cls.lib.oled_activity_step.argtypes = [ctypes.c_uint32, ctypes.c_float, ctypes.c_int,
                                              ctypes.c_int, ctypes.c_int]
        cls.lib.oled_animation_step.argtypes = [ctypes.c_int, ctypes.c_uint32, ctypes.c_char_p]
        cls.lib.oled_animation_reset.argtypes = [ctypes.c_uint32]
        cls.lib.oled_clock_set_ms.argtypes = [ctypes.c_uint32]
        cls.lib.oled_frame_count.restype = ctypes.c_uint32
        cls.lib.oled_manual_step.argtypes = [ctypes.c_int, ctypes.c_uint32]

    def setUp(self):
        self.lib.oled_panel_present(1)
        self.lib.oled_clock_set_ms(100000)
        self.lib.oled_idle_reset()

    def frame(self, function, *args):
        buf = ctypes.create_string_buffer(1024)
        function(*args, buf)
        return bytes(buf.raw)

    def test_restart_restores_all_panel_levels_and_restarts_dim_timer(self):
        self.lib.oled_saver_start(0, 5)
        self.lib.oled_idle_step(180001, 0)
        self.assertEqual(self.lib.oled_display_state(4), 1)
        self.lib.oled_saver_start(0, 6)
        self.assertEqual([self.lib.oled_panel_level(i) for i in range(3)],
                         [self.lib.oled_panel_level_full(i) for i in range(3)])
        self.assertEqual(self.lib.oled_display_state(4), 0)
        self.lib.oled_idle_step(179999, 0)
        self.assertEqual(self.lib.oled_display_state(4), 0)
        self.lib.oled_idle_step(1, 0)
        self.assertEqual(self.lib.oled_display_state(4), 1)

    def test_sleep_then_restart_a_dimmed_session_restores_brightness(self):
        self.lib.oled_saver_start(3, 5)
        self.lib.oled_idle_step(180001, 0)
        self.lib.oled_idle_sleep()
        self.assertEqual(self.lib.oled_display_state(0), 2)
        self.lib.oled_saver_start(2, 6)
        self.assertEqual([self.lib.oled_display_state(i) for i in range(5)], [1, 2, 1, 0, 0])
        self.assertEqual(self.lib.oled_panel_level(0), self.lib.oled_contrast_full())

    def test_complete_tap_between_frames_wakes_and_does_not_replay(self):
        self.lib.oled_activity_step(33, 0, 0, 0, 1)
        for sleep in (False, True):
            if sleep:
                self.lib.oled_idle_sleep()
            else:
                self.lib.oled_saver_start(1, 5)
            self.assertEqual(self.lib.oled_activity_step(33, 0, 0, 1, 1), 0)
            self.lib.oled_saver_start(1, 5)
            self.assertEqual(self.lib.oled_activity_step(33, 0, 0, 1, 1), 1,
                             "same completed tap woke a second session")
            self.lib.oled_idle_reset()
            self.lib.oled_activity_step(33, 0, 0, 0, 1)

    def test_untrusted_input_and_retrusted_static_offsets_do_not_wake(self):
        self.lib.oled_activity_step(33, 0, 0, 0, 1)
        self.lib.oled_saver_start(4, 9)
        self.assertEqual(self.lib.oled_activity_step(33, 3.9, 1, 99, 0), 1)
        self.assertEqual(self.lib.oled_activity_step(33, 0.35, 0, 99, 1), 1)
        self.assertEqual(self.lib.oled_activity_step(33, 0.35, 0, 100, 1), 0,
                         "fresh trusted tap did not wake")

    def test_held_key_does_not_bypass_the_frame_interval(self):
        self.lib.oled_activity_step(33, 2, 1, 1, 1)
        count = self.lib.oled_frame_count()
        for _ in range(8):
            self.lib.oled_activity_step(0, 2, 1, 1, 1)  # idle loop itself advances 2 ms
        self.assertEqual(self.lib.oled_frame_count(), count)
        self.lib.oled_activity_step(17, 2, 1, 1, 1)
        self.assertEqual(self.lib.oled_frame_count(), count + 1)

    def test_encoder_wake_keeps_the_selected_menu_and_swallows_wake_spin(self):
        self.lib.oled_manual_reset()
        self.lib.oled_manual_step(1, 500)
        self.assertEqual(self.lib.oled_manual_step(1, 500), 1)
        self.lib.oled_saver_start(4, 9)
        self.assertEqual(self.lib.oled_manual_step(2, 0), 1)
        self.lib.oled_activity_step(0, 0, 0, 0, 1)  # serve the wake request
        self.assertEqual(self.lib.oled_display_state(0), 0)
        self.assertEqual(self.lib.oled_manual_step(2, 50), 1)
        self.assertEqual(self.lib.oled_manual_step(0, 10000), 1)

    def test_drawing_again_without_time_does_not_move_any_animation(self):
        for anim in range(oh.ANIM_COUNT):
            with self.subTest(anim=anim):
                self.lib.oled_animation_reset(123)
                first = self.frame(self.lib.oled_animation_step, anim, 3300)
                self.assertEqual(self.frame(self.lib.oled_animation_step, anim, 0), first)
                self.assertEqual(self.frame(self.lib.oled_animation_step, anim, 0), first)

    def test_same_elapsed_time_with_different_draw_rates_gives_same_motion(self):
        for anim in range(oh.ANIM_COUNT):
            self.lib.oled_animation_reset(123)
            for _ in range(10):
                first = self.frame(self.lib.oled_animation_step, anim, 33)
            self.lib.oled_animation_reset(123)
            for _ in range(5):
                second = self.frame(self.lib.oled_animation_step, anim, 66)
            self.assertEqual(first, second, f"animation {anim} depends on draw count")

    def test_explicit_reset_repeats_every_animation_including_random_particles(self):
        for anim in range(oh.ANIM_COUNT):
            def render():
                self.lib.oled_animation_reset(42)
                for _ in range(45):
                    fb = self.frame(self.lib.oled_animation_step, anim, 33)
                return fb
            self.assertEqual(render(), render(), f"animation {anim} retains old state")

    def test_long_stalls_use_bounded_animation_catch_up(self):
        for anim in range(oh.ANIM_COUNT):
            self.lib.oled_animation_reset(42)
            stalled = self.frame(self.lib.oled_animation_step, anim, 33000)
            self.lib.oled_animation_reset(42)
            bounded = self.frame(self.lib.oled_animation_step, anim, 8 * 33)
            self.assertEqual(stalled, bounded, f"animation {anim} replayed a stale backlog")

    def test_renderer_playlist_reports_every_animation_and_no_boundary_repeat(self):
        self.lib.oled_saver_start(-1, 42)
        order = [self.lib.oled_saver_state(0)]
        n = oh.ANIM_COUNT
        for _ in range(3 * n - 1):
            self.frame(self.lib.oled_saver_step, 20000)
            self.assertGreaterEqual(self.lib.oled_saver_state(1), 0)
            self.frame(self.lib.oled_saver_step, 1500)
            order.append(self.lib.oled_saver_state(0))
        for i in range(0, 3 * n, n):
            self.assertEqual(set(order[i:i + n]), set(range(n)))
        self.assertTrue(all(a != b for a, b in zip(order, order[1:])))
        self.assertEqual(self.lib.oled_display_state(3), 1)

    def test_mode_status_tracks_actual_start_sleep_and_wake(self):
        self.assertEqual([self.lib.oled_display_state(i) for i in range(5)], [0, -1, 1, 0, 0])
        self.lib.oled_saver_start(5, 10)
        self.assertEqual([self.lib.oled_display_state(i) for i in range(5)], [1, 5, 1, 0, 0])
        self.lib.oled_idle_sleep()
        self.assertEqual(self.lib.oled_display_state(0), 2)
        self.assertEqual(self.lib.oled_display_state(1), -1)
        self.lib.oled_manual_step(2, 0)
        self.lib.oled_activity_step(0, 0, 0, 0, 1)
        self.assertEqual(self.lib.oled_display_state(0), 0)

    def test_no_test_pattern_means_rendering_continues_after_half_clock_wrap(self):
        self.lib.oled_clock_set_ms(0x80000010)
        self.lib.oled_idle_reset()
        before = self.lib.oled_frame_count()
        self.lib.oled_idle_step(33, 0)
        self.assertGreater(self.lib.oled_frame_count(), before)
        self.lib.oled_saver_start(2, 4)
        self.assertEqual(self.lib.oled_activity_step(33, 2, 1, 1, 1), 0)

    def test_real_test_pattern_expires_across_clock_wrap(self):
        self.lib.oled_clock_set_ms(0xfffffff0)
        self.lib.oled_idle_reset()
        self.lib.oled_test_pattern_start()
        self.lib.oled_idle_step(0, 0)
        before = self.lib.oled_frame_count()
        self.lib.oled_idle_step(1995, 0)  # include the loop's two 2 ms idle delays
        self.assertEqual(self.lib.oled_frame_count(), before)
        self.lib.oled_idle_step(1, 0)
        self.assertGreater(self.lib.oled_frame_count(), before)

    def test_missing_panel_is_not_reported_ready_and_retries_after_ack(self):
        self.lib.oled_panel_present(0)
        self.lib.oled_hardware_retry_reset()
        self.lib.oled_idle_step(0, 0)
        self.assertEqual(self.lib.oled_display_state(2), 0)
        self.lib.oled_panel_present(1)
        self.lib.oled_idle_step(2000, 0)
        self.assertEqual(self.lib.oled_display_state(2), 1)

    def test_new_mode_cancels_both_active_and_pending_older_test_patterns(self):
        for already_shown in (False, True):
            for action in (0, 1, 2):  # Wake, Sleep, Screensaver
                with self.subTest(already_shown=already_shown, action=action):
                    self.lib.oled_idle_reset()
                    self.lib.oled_test_pattern_start()
                    if already_shown:
                        self.lib.oled_idle_step(0, 0)
                    before = self.lib.oled_frame_count()
                    self.lib.oled_display_action_post(action)
                    self.lib.oled_idle_step(33, 0)
                    self.assertGreater(self.lib.oled_frame_count(), before)
                    self.assertEqual(self.lib.oled_display_state(0), (0, 2, 1)[action])
                    if action == 1:
                        self.assertEqual(self.lib.oled_panel_powered_on(), 0)
                    else:
                        count = self.lib.oled_frame_count()
                        self.lib.oled_idle_step(33, 0)
                        self.assertGreater(self.lib.oled_frame_count(), count,
                                           "old test pattern still held the screen")

    def test_late_panel_initialization_preserves_an_applied_sleep_request(self):
        self.lib.oled_panel_present(0)
        self.lib.oled_hardware_retry_reset()
        self.lib.oled_idle_sleep()
        self.lib.oled_idle_step(0, 0)
        self.lib.oled_panel_present(1)
        self.lib.oled_idle_step(2000, 0)
        self.assertEqual(self.lib.oled_display_state(2), 1)
        self.assertEqual(self.lib.oled_display_state(0), 2)
        self.assertEqual(self.lib.oled_panel_powered_on(), 0)
        self.lib.oled_display_action_post(0)
        self.lib.oled_idle_step(33, 0)
        self.assertEqual(self.lib.oled_panel_powered_on(), 1)


class IdleScreensaverStart(unittest.TestCase):
    """The stored choices (settings saver_idle / saver_anim) start the screensaver by itself."""
    MODE_SCREEN, MODE_SAVER = 0, 1

    @classmethod
    def setUpClass(cls):
        cls.lib = oh.load()
        cls.lib.oled_clock_set_ms.argtypes = [ctypes.c_uint32]

    def setUp(self):
        self.lib.oled_panel_present(1)
        self.lib.oled_clock_set_ms(100000)
        self.lib.oled_idle_reset()
        self.lib.oled_auto_saver_step(0, 0, -1, 1, 0, 0)

    def tearDown(self):
        self.lib.oled_auto_saver_step(0, 0, -1, 1, 0, 0)    # leaves the menu flag cleared

    def idle(self, ms, idle_min=1, anim=3, trusted=1, menu=0, chunk=1000):
        while ms > 0:
            step = min(chunk, ms)
            self.lib.oled_auto_saver_step(step, idle_min, anim, trusted, 0, menu)
            ms -= step

    def mode(self):
        return self.lib.oled_display_state(0)

    def test_starts_after_the_idle_minutes_with_the_stored_animation(self):
        self.idle(59_900)
        self.assertEqual(self.mode(), self.MODE_SCREEN, "one minute has not passed")
        self.idle(300, chunk=50)
        self.assertEqual(self.mode(), self.MODE_SAVER)
        self.assertEqual((self.lib.oled_display_state(1), self.lib.oled_display_state(3)), (3, 0),
                         "fixed animation 3, not shuffled")

    def test_shuffle_when_no_animation_is_chosen(self):
        self.idle(61_000, anim=-1)
        self.assertEqual(self.mode(), self.MODE_SAVER)
        self.assertEqual(self.lib.oled_display_state(3), 1)

    def test_a_key_press_restarts_the_idle_time_and_ends_the_screensaver(self):
        self.idle(50_000)
        self.lib.oled_auto_saver_step(33, 1, 3, 1, 1, 0)       # a trusted press
        self.lib.oled_auto_saver_step(33, 1, 3, 1, 0, 0)
        self.idle(55_000)
        self.assertEqual(self.mode(), self.MODE_SCREEN, "counted from the press, not from the start")
        self.idle(6_000)
        self.assertEqual(self.mode(), self.MODE_SAVER)
        self.lib.oled_auto_saver_step(33, 1, 3, 1, 1, 0)
        self.assertEqual(self.mode(), self.MODE_SCREEN, "a press wakes it")

    def test_never_with_zero_minutes_untrusted_keys_or_the_menu_open(self):
        for kwargs in ({"idle_min": 0}, {"trusted": 0}, {"menu": 1}):
            with self.subTest(**kwargs):
                self.lib.oled_idle_reset()
                self.idle(3_700_000, chunk=10_000, **kwargs)      # over an hour
                self.assertEqual(self.mode(), self.MODE_SCREEN)

    def test_a_display_turned_off_stays_off(self):
        self.lib.oled_idle_sleep()
        self.idle(120_000)
        self.assertEqual(self.mode(), 2, "sleep is not replaced by the screensaver")


if __name__ == "__main__":
    unittest.main()
