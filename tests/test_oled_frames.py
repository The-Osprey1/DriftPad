"""
test_oled_frames.py - Pixel-level checks on the real oled.cpp screens (host render).

The real firmware drawing code and the real Adafruit GFX draw into a framebuffer on the host.
This shows layout and behaviour defects that compile and run fine but look wrong on the panel;
it does not show how the physical glass looks (hardware acceptance covers that).
"""

import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import oled_host as oh


class OledFrames(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lib = oh.load()

    def test_text_wrap_is_off(self):
        oh.frame(self.lib, "standby")
        self.assertEqual(self.lib.oled_text_wrap_enabled(), 0,
                         "text wrap is on: a right-aligned label ending at x=127 wraps its last "
                         "glyph onto the next row")

    def test_header_does_not_wrap_below_the_header(self):
        # "RT 0.20mm" ends on x=127; with wrapping its last 'm' used to land at x=0 on the next
        # row. Column 0 is empty everywhere below the header (the key box starts at x=1)
        for scene in ("standby", "travelling"):
            fb = oh.frame(self.lib, scene)
            spill = [y for y in range(8, 56) if oh.pixel(fb, 0, y)]
            self.assertEqual(spill, [], f"{scene}: pixels in column 0 below the header")

    def test_header_reaches_the_right_edge(self):
        fb = oh.frame(self.lib, "standby")
        self.assertTrue(any(oh.pixel(fb, 127, y) for y in range(0, 8)),
                        "the last header glyph is missing (clipped or wrapped)")

    def test_every_screen_draws_something(self):
        for name in oh.SCENES:
            self.assertTrue(any(oh.frame(self.lib, name)), f"{name} is blank")

    def test_actuated_key_shows_solid_box_and_map_cell(self):
        fb = oh.frame(self.lib, "actuated_ent")
        # the focus card is filled ("ACTUATED"), and ENT (key 14: row 3, column 2) is solid in the map
        self.assertTrue(all(oh.pixel(fb, x, 21) for x in range(4, 74)), "key box is not filled")
        x0, y0 = 83 + 2 * 12, 9 + 3 * 12
        self.assertTrue(all(oh.pixel(fb, x, y0 + 4) for x in range(x0, x0 + 9)), "map cell is not solid")

    def test_released_key_fades_out_of_the_map(self):
        rest = self.lib.oled_glow_step(0)
        solid = self.lib.oled_glow_step(1)
        self.assertGreater(solid, 70, "held key is not solid in the map")
        trail = [self.lib.oled_glow_step(0) for _ in range(12)]
        self.assertGreater(trail[0], rest + 25, "no afterglow right after release")
        self.assertLess(trail[0], solid, "afterglow is as bright as a held key")
        self.assertEqual(trail[-1], rest, "map cell does not return to its resting look")
        self.assertTrue(all(a >= b for a, b in zip(trail, trail[1:])), f"afterglow is not fading: {trail}")

    def test_a_pad_that_sends_nothing_says_so(self):
        # the status chip (inverted, top-left of the left panel) appears only when output is blocked
        def chip_ink(scene):
            fb = oh.frame(self.lib, scene)
            return sum(oh.pixel(fb, x, y) for x in range(1, 60) for y in range(9, 18))

        ready, no_cal, off = (chip_ink(s) for s in ("standby", "standby_no_cal", "travelling_output_off"))
        self.assertGreater(no_cal, ready + 150, "standby does not flag missing calibration")
        self.assertGreater(off, ready + 150, "a travelling key does not flag that output is off")

    def test_rapid_trigger_marks_where_the_key_will_release(self):
        # held at 3.0 mm then back at 2.4 mm with RT 0.20: the key releases at 2.8 mm. The marker
        # is a pointer just above the scale (x = 1 + 2.8/4*75 = 54, rows 47..48)
        with_rt = oh.frame(self.lib, "rt_backing_off")
        without = oh.frame(self.lib, "no_rt_backing_off")
        marker = lambda fb: [oh.pixel(fb, 54, y) for y in (47, 48)]
        self.assertEqual(marker(with_rt), [1, 1], "no release marker with Rapid Trigger on")
        self.assertEqual(marker(without), [0, 0], "release marker shown with Rapid Trigger off")

    def test_big_text_uses_the_title_screens_slit(self):
        # the tuning value, the key label and the standby layer name are cut by a one-row slit
        def rows(scene, x0, x1, y0, y1):
            fb = oh.frame(self.lib, scene)
            return [sum(oh.pixel(fb, x, y) for x in range(x0, x1)) for y in range(y0, y1)]

        for scene, box in (("menu_rt", (10, 118, 18, 38)), ("travelling", (6, 74, 24, 42)), ("standby", (1, 77, 21, 34))):
            ink = rows(scene, *box)
            body = sorted(ink)[len(ink) // 2]
            self.assertLess(min(ink[2:-2]), max(1, body // 3), f"{scene}: no slit through the lettering")

    def test_the_widest_key_legend_stays_inside_its_box(self):
        # "WWWW" is as wide as four printable characters get. The box frame is at x = 1 and 76; the
        # slanted lettering must leave at least two clear columns before it on each side
        margin = [(x, y) for y in range(22, 44) for x in (2, 3, 74, 75)]
        plain = oh.frame(self.lib, "wide_label")
        self.assertEqual(sum(oh.pixel(plain, x, y) for x, y in margin), 0, "the legend runs into the box frame")
        solid = oh.frame(self.lib, "wide_label_actuated")   # a filled box: the legend is dark on white
        self.assertTrue(all(oh.pixel(solid, x, y) for x, y in margin), "the legend runs into the edge of the filled box")

    def test_screensaver_title_card_leaves_the_animation_clear(self):
        import ctypes
        self.lib.oled_screensaver_frame.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p]

        def card_ink(frames):
            buf = ctypes.create_string_buffer(1024)
            self.lib.oled_screensaver_frame(0, frames, buf)   # the starfield is sparse where the card sits
            fb = bytes(buf.raw)
            return sum(oh.pixel(fb, x, y) for x in range(34, 94) for y in range(47, 62))

        # the card (bracketed, tracked name) is ~130 px of ink; the animation adds only a few there
        early, late = card_ink(30), card_ink(140)
        self.assertGreater(early - late, 60, "the title card did not slide away")

    def test_mag_pulse_rings_keep_moving_and_spark_where_they_cross(self):
        import ctypes
        self.lib.oled_screensaver_frame.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p]

        def frame_at(n):
            buf = ctypes.create_string_buffer(1024)
            self.lib.oled_screensaver_frame(4, n, buf)
            return bytes(buf.raw)

        frames = [frame_at(n) for n in (60, 75, 100, 130)]
        self.assertEqual(len(set(frames)), 4, "the pulses are not moving")
        for fb in frames:
            self.assertGreater(sum(bin(b).count("1") for b in fb), 150, "the animation is nearly empty")
        # deterministic (seeded) and different frames are not just noise: a spark is a 5-pixel plus, so
        # somewhere in the busy frames a lit pixel has all four neighbours lit
        def has_plus(fb):
            return any(oh.pixel(fb, x, y) and oh.pixel(fb, x - 1, y) and oh.pixel(fb, x + 1, y) and
                       oh.pixel(fb, x, y - 1) and oh.pixel(fb, x, y + 1)
                       for x in range(2, 126) for y in range(2, 62))
        self.assertTrue(any(has_plus(fb) for fb in frames + [frame_at(n) for n in range(80, 140, 4)]),
                        "no crossing spark ever appears")

    def test_intro_animates_and_lands_on_the_name(self):
        import ctypes
        self.lib.oled_intro_frame.argtypes = [ctypes.c_uint32, ctypes.c_char_p]

        def frame_at(ms):
            buf = ctypes.create_string_buffer(1024)
            self.lib.oled_intro_frame(ms, buf)
            return bytes(buf.raw)

        early, mid, end = frame_at(300), frame_at(1500), frame_at(3900)
        self.assertNotEqual(early, mid)
        self.assertNotEqual(mid, end)
        # the wordmark's halves drift in and lock together: nothing of it before the first letter starts,
        # a partial word in the middle, the whole word at the end, cut by a one-row slit through every letter
        word = lambda fb: sum(oh.pixel(fb, x, y) for x in range(4, 124) for y in range(12, 32))
        self.assertGreater(word(end), 450, "'DRIFTPAD' is not on screen at the end of the intro")
        self.assertEqual(word(early), 0, "the wordmark is up before the first letter has started")
        half = frame_at(650)
        self.assertGreater(word(half), 0)
        self.assertLess(word(half), word(end) * 0.8, "the letters do not arrive one after another")
        slit = sum(oh.pixel(end, x, 13 + 9) for x in range(4, 124))
        rows_around = sum(oh.pixel(end, x, 13 + 5) for x in range(4, 124))
        self.assertLess(slit, rows_around // 4, "the slit through the letters is missing")
        # the ruler along the bottom fills as the pad boots
        bar = lambda fb: sum(oh.pixel(fb, x, 62) for x in range(0, 128))
        self.assertLess(bar(frame_at(600)), bar(frame_at(4000)), "the boot bar does not fill")
        # the tagline types in after the wordmark, is erased, and the pad's real status types in
        line = lambda fb: sum(oh.pixel(fb, x, y) for x in range(4, 124) for y in range(45, 54))
        self.assertEqual(line(early), 0)
        self.assertGreater(line(frame_at(2900)), 100, "the tagline never appears")
        self.assertLess(line(frame_at(3680)), 20, "the tagline is not erased")
        self.assertGreater(line(frame_at(4500)), 100, "the pad's status never appears")
        # nothing runs off the screen
        self.assertFalse(any(oh.pixel(frame_at(3000), 127, y) for y in range(12, 50)), "something runs off the right edge")
        # after the intro proper it wipes into the key screen: a mix of both, then the key screen alone
        before, mix, after = frame_at(5399), frame_at(5750), frame_at(6100)
        self.assertNotEqual(mix, before)
        self.assertNotEqual(mix, after)
        keys = oh.frame(self.lib, "standby_no_cal")
        self.assertEqual(sum(a != b for a, b in zip(after, keys)) < 60, True,
                         "the wipe does not end on the key screen")

    def test_intro_runs_its_length_and_a_key_press_ends_it(self):
        self.lib.oled_idle_reset()
        self.lib.oled_intro_restart()
        self.lib.oled_idle_step(100, 0)
        self.assertEqual(self.lib.oled_intro_done(), 0, "the intro ended immediately")
        self.lib.oled_idle_step(4000, 0)
        self.assertEqual(self.lib.oled_intro_done(), 0, "the intro ended before its wipe into the key screen")
        self.lib.oled_idle_step(2200, 0)
        self.assertEqual(self.lib.oled_intro_done(), 1, "the intro never ends by itself")
        self.lib.oled_idle_reset()
        self.lib.oled_intro_restart()
        self.lib.oled_idle_step(100, 0)
        self.lib.oled_idle_step(50, 1)
        self.assertEqual(self.lib.oled_intro_done(), 1, "a key press did not end the intro")

    def test_menu_arrives_with_a_wipe(self):
        import ctypes
        self.lib.oled_wipe_frame.argtypes = [ctypes.c_uint32, ctypes.c_char_p]

        def wipe(ms):
            buf = ctypes.create_string_buffer(1024)
            running = self.lib.oled_wipe_frame(ms, buf)
            return running, bytes(buf.raw)

        start_running, start = wipe(0)
        mid_running, mid = wipe(130)
        end_running, end = wipe(400)
        self.assertEqual((start_running, mid_running, end_running), (1, 1, 0))
        self.assertNotEqual(mid, start)
        self.assertNotEqual(mid, end)

    def test_screensaver_dims_and_input_restores(self):
        self.lib.oled_idle_reset()
        full, dim = self.lib.oled_contrast_full(), self.lib.oled_contrast_dim()
        self.assertEqual(self.lib.oled_idle_step(1000, 0), full, "not at full contrast when idle starts")
        self.assertEqual(self.lib.oled_idle_step(29000, 0), full, "dimmed before the screensaver started")
        self.assertEqual(self.lib.oled_idle_step(16000, 0), full, "dimmed the moment the screensaver started")
        self.assertEqual(self.lib.oled_idle_step(30000, 0), full, "dimmed before the screensaver had time to enjoy")
        self.assertEqual(self.lib.oled_idle_step(100000, 0), full, "dimmed before the screensaver's three minutes")
        self.assertEqual(self.lib.oled_idle_step(51000, 0), dim, "screensaver never dims")
        self.assertEqual([self.lib.oled_panel_level(i) for i in range(3)],
                         [self.lib.oled_panel_level_dim(i) for i in range(3)],
                         "contrast, pre-charge and VCOMH are not all lowered")
        self.assertEqual(self.lib.oled_idle_step(50, 1), full, "input did not restore contrast")
        self.assertEqual([self.lib.oled_panel_level(i) for i in range(3)],
                         [self.lib.oled_panel_level_full(i) for i in range(3)],
                         "brightness is not fully restored")


if __name__ == "__main__":
    unittest.main()
