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

    def test_standby_has_a_plain_caption_and_big_value_without_carousel_pips(self):
        fb = oh.frame(self.lib, "standby")
        caption = sum(oh.pixel(fb, x, y) for x in range(2, 80) for y in range(19, 27))
        value = sum(oh.pixel(fb, x, y) for x in range(2, 78) for y in range(30, 48))
        pips = sum(oh.pixel(fb, x, y) for x in range(30, 51) for y in range(58, 64))
        self.assertGreater(caption, 60, "no caption above the value")
        self.assertGreater(value, 200, "no big value on the standby page")
        self.assertEqual(pips, 0, "standby still advertises carousel pages")

    def test_every_screen_draws_something(self):
        for name in oh.SCENES:
            self.assertTrue(any(oh.frame(self.lib, name)), f"{name} is blank")

    def test_actuated_key_shows_solid_box_and_map_cell(self):
        fb = oh.frame(self.lib, "actuated_ent")
        # the focus card is filled ("ACTUATED"), and ENT (key 14: row 3, column 2) is solid in the map
        self.assertTrue(all(oh.pixel(fb, x, 20) for x in range(4, 74)), "key box is not filled")
        x0, y0 = 85 + 2 * 11, 10 + 3 * 11     # the map: x 85, y 10, a cell every 11 px
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
        # is a pointer just above the scale (x = 2 + 2.8/4*75 = 55, rows 47..48)
        with_rt = oh.frame(self.lib, "rt_backing_off")
        without = oh.frame(self.lib, "no_rt_backing_off")
        marker = lambda fb: [oh.pixel(fb, 55, y) for y in (47, 48)]
        self.assertEqual(marker(with_rt), [1, 1], "no release marker with Rapid Trigger on")
        self.assertEqual(marker(without), [0, 0], "release marker shown with Rapid Trigger off")

    def test_big_text_uses_the_title_screens_slit(self):
        # the tuning value, the key label and the standby layer name are cut by a one-row slit
        def rows(scene, x0, x1, y0, y1):
            fb = oh.frame(self.lib, scene)
            return [sum(oh.pixel(fb, x, y) for x in range(x0, x1)) for y in range(y0, y1)]

        for scene, box in (("menu_rt", (10, 118, 18, 38)), ("travelling", (6, 74, 24, 42)), ("standby", (2, 78, 34, 44))):
            ink = rows(scene, *box)
            body = sorted(ink)[len(ink) // 2]
            self.assertLess(min(ink[2:-2]), max(1, body // 3), f"{scene}: no slit through the lettering")

    def test_the_widest_key_legend_stays_inside_its_box(self):
        # "WWWW" is as wide as four printable characters get. The box frame is at x = 2 and 77; the
        # slanted lettering must leave at least two clear columns inside it on each side
        margin = [(x, y) for y in range(22, 43) for x in (3, 4, 75, 76)]
        plain = oh.frame(self.lib, "wide_label")
        self.assertEqual(sum(oh.pixel(plain, x, y) for x, y in margin), 0, "the legend runs into the box frame")
        solid = oh.frame(self.lib, "wide_label_actuated")   # a filled box: the legend is dark on white
        self.assertTrue(all(oh.pixel(solid, x, y) for x, y in margin), "the legend runs into the edge of the filled box")

    def test_multi_character_labels_leave_clear_margins_and_do_not_touch_map(self):
        # Multi-character labels (WWWW, Ctrl, 1.0, !=, ->) leave at least 2 clear columns inside
        # the key box border (columns 3, 4, 75, 76) and do not touch map cells (x >= 85).
        margin = [(x, y) for y in range(22, 43) for x in (3, 4, 75, 76)]
        gutter = [(x, y) for y in range(9, 58) for x in (78, 79, 80)]
        for label in ("WWWW", "Ctrl", "1.0", "!=", "->"):
            fb_rel = oh.label_frame(self.lib, label, False)
            fb_act = oh.label_frame(self.lib, label, True)

            # Resting: key box interior margin columns are clear of ink
            self.assertEqual(sum(oh.pixel(fb_rel, x, y) for x, y in margin), 0,
                             f"{label} released legend runs into key box margin")
            # Actuated: key box interior margin columns are filled white
            self.assertTrue(all(oh.pixel(fb_act, x, y) for x, y in margin),
                            f"{label} actuated legend runs into key box margin")
            # Neither state touches the gutter or map cells outside key box
            self.assertEqual(sum(oh.pixel(fb_rel, x, y) for x, y in gutter), 0,
                             f"{label} released touches gutter/map")
            self.assertEqual(sum(oh.pixel(fb_act, x, y) for x, y in gutter), 0,
                             f"{label} actuated touches gutter/map")
            # Row 46 above the travel scale is completely clear
            self.assertFalse(any(oh.pixel(fb_rel, x, 46) for x in range(2, 78)),
                             f"{label} released spills onto row 46")
            self.assertFalse(any(oh.pixel(fb_act, x, 46) for x in range(2, 78)),
                             f"{label} actuated spills onto row 46")


    def test_punctuation_and_small_legends_remain_visible_in_both_states(self):
        # Small glyphs (., -, /, +, etc.) previously vanished when actuated or lost critical rows
        # because the 1-row slit and capH baseline positioning truncated their minimal height.
        # Verify that punctuation legends retain all distinguishing pixels in both resting and actuated
        # states, with the actuated state knocking out identical pixel counts sinking by 1 px.
        expected = {
            ".": (5, 5, 25),      # 5x5 bold square dot
            "-": (9, 4, 36),      # 9x4 horizontal dash
            "/": (6, 17, 30),     # 6x17 diagonal slash
            "+": (16, 16, 112),   # 16x16 crossing plus
            "*": (7, 8, 26),      # 7x8 asterisk
            ",": (5, 11, 39),     # 5x11 comma
            "_": (21, 3, 63),     # 21x3 underscore
        }
        for label, (exp_w, exp_h, exp_cnt) in expected.items():
            fb_rel = oh.label_frame(self.lib, label, False)
            fb_act = oh.label_frame(self.lib, label, True)

            # In released state: card interior (x: 4..75, y: 21..44) is dark, glyph is lit (white)
            rel_pixels = [(x, y) for y in range(21, 45) for x in range(4, 76) if oh.pixel(fb_rel, x, y) == 1]
            # In actuated state: card interior is filled (white), glyph is knocked out (dark)
            act_pixels = [(x, y) for y in range(21, 45) for x in range(4, 76) if oh.pixel(fb_act, x, y) == 0]

            self.assertEqual(len(rel_pixels), exp_cnt, f"{label} released pixel count")
            self.assertEqual(len(act_pixels), exp_cnt, f"{label} actuated pixel count (must not lose pixels)")

            xs_rel = [x for x, y in rel_pixels]
            ys_rel = [y for x, y in rel_pixels]
            xs_act = [x for x, y in act_pixels]
            ys_act = [y for x, y in act_pixels]

            self.assertEqual((max(xs_rel) - min(xs_rel) + 1, max(ys_rel) - min(ys_rel) + 1),
                             (exp_w, exp_h), f"{label} released dimensions")
            self.assertEqual((max(xs_act) - min(xs_act) + 1, max(ys_act) - min(ys_act) + 1),
                             (exp_w, exp_h), f"{label} actuated dimensions")
            self.assertEqual(min(ys_act), min(ys_rel) + 1, f"{label} actuated sinks by exactly 1 pixel")

            # Check that row 46 (clear space above travel scale) is completely empty in both states
            self.assertFalse(any(oh.pixel(fb_rel, x, 46) for x in range(2, 78)), f"{label} rel row 46 spill")
            self.assertFalse(any(oh.pixel(fb_act, x, 46) for x in range(2, 78)), f"{label} act row 46 spill")

    def test_actuated_scene_shows_visible_period(self):
        # Scene 2 ("actuated") has key 13 ('.') pressed deep (3.9 mm).
        # Previously, the actuated card was 100% solid white inside (0 dark pixels).
        # It must now knock out the 5x5 period legend clearly.
        fb = oh.frame(self.lib, "actuated")
        dark_inside = [(x, y) for y in range(21, 45) for x in range(4, 76) if oh.pixel(fb, x, y) == 0]
        self.assertEqual(len(dark_inside), 25, "actuated card interior must show the 5x5 period")
        ys = [y for x, y in dark_inside]
        xs = [x for x, y in dark_inside]
        self.assertEqual((min(xs), max(xs)), (38, 42))
        self.assertEqual((min(ys), max(ys)), (31, 35))

    def test_lowercase_descenders_stay_inside_card_and_clear_travel_scale(self):
        # Letters with descenders ('g', 'j', 'p', 'q', 'y') must be safely vertically bounded
        # and must never spill onto the travel scale (rows 49..51) or row 46.
        for label in ("g", "j", "p", "q", "y"):
            fb_rel = oh.label_frame(self.lib, label, False)
            fb_act = oh.label_frame(self.lib, label, True)

            rel_pixels = [(x, y) for y in range(21, 45) for x in range(4, 76) if oh.pixel(fb_rel, x, y) == 1]
            act_pixels = [(x, y) for y in range(21, 45) for x in range(4, 76) if oh.pixel(fb_act, x, y) == 0]

            self.assertGreater(len(rel_pixels), 40, f"{label} released has substantial ink")
            self.assertGreater(len(act_pixels), 40, f"{label} actuated has substantial ink")

            self.assertLessEqual(max(y for x, y in rel_pixels), 42, f"{label} released bottom clearance")
            self.assertLessEqual(max(y for x, y in act_pixels), 43, f"{label} actuated bottom clearance")

            self.assertFalse(any(oh.pixel(fb_rel, x, 46) for x in range(2, 78)), f"{label} released row 46 spill")
            self.assertFalse(any(oh.pixel(fb_act, x, 46) for x in range(2, 78)), f"{label} actuated row 46 spill")

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

    def test_a_press_plays_travel_actuation_release_and_fade(self):
        import ctypes
        self.lib.oled_press_step.argtypes = [ctypes.c_float, ctypes.c_int, ctypes.c_int, ctypes.c_char_p]

        def step(travel, pressed, count):
            buf = ctypes.create_string_buffer(1024)
            self.lib.oled_press_step(travel, pressed, count, buf)
            return bytes(buf.raw)

        card_top = lambda fb: sum(oh.pixel(fb, x, 19) for x in range(6, 74))     # the focus card's frame
        card_mid = lambda fb: sum(oh.pixel(fb, x, 21) for x in range(6, 74))     # solid only when actuated (the first punch frame's bevel is on row 20)
        cell = lambda fb: sum(oh.pixel(fb, x, y) for x in range(96, 105) for y in range(21, 30))   # key 5 in the map

        for _ in range(8):   # long enough for any focus left by an earlier test to settle (100 ms)
            rest = step(0.0, 0, 0)
        self.assertEqual(card_top(rest), 0, "the focus card shows at rest")
        first = step(0.6, 0, 0)
        self.assertLess(card_top(first), 60, "the card is not revealed progressively")   # a wipe, not a pop
        for _ in range(4):
            moving = step(0.6, 0, 0)
        self.assertGreater(card_top(moving), 60, "the card does not appear when the key moves")
        self.assertLess(card_mid(moving), 5)
        OUTLINE = 32   # a bare 9x9 cell outline; at rest in standby the cell also carries its legend
        self.assertGreater(cell(rest), OUTLINE, "standby does not show the key's legend in the map")
        self.assertGreater(cell(moving), OUTLINE + 5, "the map cell does not fill as the key travels")
        deeper = step(1.15, 0, 0)
        self.assertGreater(cell(deeper), cell(moving), "the map cell does not fill further with travel")
        fired = step(1.6, 1, 1)
        self.assertGreater(card_mid(fired), 60, "the card does not flip solid on actuation")
        self.assertGreaterEqual(cell(fired), 81, "the map cell is not solid on actuation")
        released = step(1.0, 0, 1)
        self.assertLess(card_mid(released), 5, "the card stays solid after release")
        trail = [cell(step(0.0, 0, 1)) for _ in range(12)]
        self.assertGreater(trail[0], OUTLINE + 25, "no afterglow after release")
        low = trail.index(min(trail))       # the fade runs down to the bare outline; then the legend returns
        self.assertTrue(all(a >= b for a, b in zip(trail[:low + 1], trail[1:low + 1])), f"the afterglow does not fade: {trail}")
        self.assertEqual(trail[-1], cell(rest), "the cell does not settle back to its resting look, legend and all")
        self.assertEqual(card_top(step(0.0, 0, 1)), 0, "the card does not go away once the key has settled")

    def test_standby_keeps_the_layer_page_and_fits_the_panel(self):
        import ctypes
        self.lib.oled_settings_step.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint32, ctypes.c_char_p]
        self.lib.oled_state_reset()

        def step(dt):
            buf = ctypes.create_string_buffer(1024)
            self.lib.oled_settings_step(0, 5, dt, buf)
            return bytes(buf.raw)

        def settled_page(dt):       # the wipe between pages takes three frames
            step(dt)
            for _ in range(3):
                fb = step(33)
            return fb

        pages = [settled_page(33), settled_page(3000), settled_page(3000)]
        self.assertEqual(len(set(pages)), 1, "standby changed page without encoder input")
        for i, fb in enumerate(pages):
            body = sum(oh.pixel(fb, x, y) for x in range(2, 77) for y in range(20, 49))
            self.assertGreater(body, 150, f"page {i + 1} is nearly empty")
            spill = sum(oh.pixel(fb, x, y) for x in range(81, 85) for y in range(19, 49))   # the map starts at x = 85
            self.assertEqual(spill, 0, f"page {i + 1}: text runs into the keypad map")
        # layout: centred in the panel, a clear gutter to the map, and a clear row above the scale
        def centre(fb, y0, y1):
            xs = [x for y in range(y0, y1) for x in range(0, 82) if oh.pixel(fb, x, y)]
            return (min(xs) + max(xs)) / 2

        for i, fb in enumerate(pages):
            self.assertLessEqual(abs(centre(fb, 19, 27) - 40), 4, f"page {i + 1}: the caption is not centred in the panel")
            self.assertLessEqual(abs(centre(fb, 29, 47) - 40), 3, f"page {i + 1}: the value is not centred in the panel")
            gutter = sum(oh.pixel(fb, x, y) for x in range(80, 85) for y in range(9, 58))
            self.assertEqual(gutter, 0, f"page {i + 1}: something crosses the gutter to the keypad map")
            above_scale = sum(oh.pixel(fb, x, 48) for x in range(2, 78))
            self.assertEqual(above_scale, 0, f"page {i + 1}: the value touches the scale")
        back_to_first = settled_page(3000)
        self.assertEqual(back_to_first, pages[0], "standby did not stay on the layer")

    def test_button_selects_pages_and_selected_page_does_not_time_out(self):
        import ctypes
        self.lib.oled_manual_step.argtypes = [ctypes.c_int, ctypes.c_uint32]
        self.lib.oled_manual_reset()
        self.assertEqual(self.lib.oled_manual_step(0, 10000), -1)
        for page in (0, 1, 2, 3, 4, -1):   # sensitivity, actuation, RT on/off, layer, theme, closed
            self.assertEqual(self.lib.oled_manual_step(1, 500), page)
            if page >= 0:
                self.assertEqual(self.lib.oled_manual_step(0, 300), page)  # finish the entry wipe
                buf = ctypes.create_string_buffer(1024)
                self.lib.oled_last_frame(buf)
                self.assertEqual(sum(oh.pixel(buf.raw, x, 61) for x in range(10, 118)), 0,
                                 "selected page still shows the removed auto-return countdown")
            self.assertEqual(self.lib.oled_manual_step(0, 10000), page, "selection timed out")

    def test_rotary_opens_selected_setting_and_zero_delta_does_not_navigate(self):
        import ctypes
        self.lib.oled_manual_step.argtypes = [ctypes.c_int, ctypes.c_uint32]
        self.lib.oled_manual_reset()
        self.assertEqual(self.lib.oled_manual_step(3, 500), -1)
        self.assertEqual(self.lib.oled_manual_step(2, 500), 0)
        self.assertEqual(self.lib.oled_manual_step(0, 10000), 0)
        self.assertEqual(self.lib.oled_manual_step(1, 500), 1)
        self.assertEqual(self.lib.oled_manual_step(2, 500), 1)

    def test_unsaved_and_saved_chips(self):
        import ctypes
        self.lib.oled_settings_step.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint32, ctypes.c_char_p]
        self.lib.oled_state_reset()

        def chip(dirty, seq, dt):
            buf = ctypes.create_string_buffer(1024)
            self.lib.oled_settings_step(dirty, seq, dt, buf)
            fb = bytes(buf.raw)
            return sum(oh.pixel(fb, x, y) for x in range(78, 128) for y in range(0, 9))

        self.assertEqual(chip(0, 5, 33), 0, "a chip shows although the settings are saved")
        self.assertGreater(chip(1, 5, 33), 100, "no UNSAVED chip while changes are only in RAM")
        self.assertGreater(chip(0, 6, 33), 60, "no SAVED chip right after a save")
        self.assertGreater(chip(0, 6, 1000), 60, "the SAVED chip disappears too soon")
        self.assertEqual(chip(0, 6, 3000), 0, "the SAVED chip never goes away")

    def test_save_then_edit_cancels_saved_confirmation(self):
        import ctypes
        self.lib.oled_settings_step.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint32, ctypes.c_char_p]
        self.lib.oled_settings_text.restype = ctypes.c_char_p
        self.lib.oled_state_reset()
        buf = ctypes.create_string_buffer(1024)
        self.lib.oled_settings_step(0, 5, 33, buf)
        self.lib.oled_settings_step(0, 6, 33, buf)
        self.assertEqual(self.lib.oled_settings_text(), b"Saved")
        self.lib.oled_settings_step(1, 6, 33, buf)
        self.assertEqual(self.lib.oled_settings_text(), b"Unsaved")
        # Reverting the edit must not resurrect the old save confirmation.
        self.lib.oled_settings_step(0, 6, 33, buf)
        self.assertEqual(self.lib.oled_settings_text(), b"")

    def test_save_confirmation_does_not_reappear_at_long_uptime(self):
        import ctypes
        self.lib.oled_settings_step.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint32, ctypes.c_char_p]
        self.lib.oled_settings_text.restype = ctypes.c_char_p
        self.lib.host_clock_set_us.argtypes = [ctypes.c_uint64]
        self.addCleanup(self.lib.host_clock_set_us, 100000000)
        buf = ctypes.create_string_buffer(1024)
        for start in (100000, 0xfffffff0):
            self.lib.host_clock_set_us(start * 1000)
            self.lib.oled_state_reset()
            self.lib.oled_settings_step(0, 5, 0, buf)
            self.assertEqual(self.lib.oled_settings_text(), b"")
            self.lib.oled_settings_step(0, 6, 1, buf)
            self.lib.oled_settings_step(0, 6, 1000, buf)
            self.assertEqual(self.lib.oled_settings_text(), b"Saved")
            self.lib.oled_settings_step(0, 6, 1300, buf)
            self.assertEqual(self.lib.oled_settings_text(), b"")
            self.lib.oled_settings_step(0, 6, 0x80000000, buf)
            self.assertEqual(self.lib.oled_settings_text(), b"")
        self.lib.host_clock_set_us(100000000)

    def test_layer_header_stays_visible_with_notices_and_focus(self):
        import ctypes
        self.lib.oled_context_step.argtypes = [ctypes.c_int] * 4 + [ctypes.c_uint32, ctypes.c_char_p]
        def frame(layer, dirty, output, focused, dt=33):
            buf = ctypes.create_string_buffer(1024)
            self.lib.oled_context_step(layer, dirty, output, focused, dt, buf)
            return bytes(buf.raw)
        def header(fb):
            return tuple(oh.pixel(fb, x, y) for y in range(9) for x in range(2, 78))
        for layer in range(3):
            self.lib.oled_state_reset()
            idle = frame(layer, 0, 0, 0)
            self.assertGreater(sum(header(idle)), 50)
            for dirty, output, focused, dt in ((1, 0, 0, 3000), (1, 0, 1, 33), (0, 1, 1, 33), (0, 2, 0, 33), (1, 3, 1, 33)):
                fb = frame(layer, dirty, output, focused, dt)
                self.assertEqual(header(fb), header(idle), "layer context was covered by a notice or page")
                # The focus pointer uses x=81..83. Standby leaves the entire gutter clear.
                gutter_end = 81 if focused else 85
                self.assertFalse(any(oh.pixel(fb, x, y) for x in range(80, gutter_end) for y in range(9, 58)))
        self.lib.oled_state_reset()


    def test_a_layer_change_flashes_its_name(self):
        import ctypes
        self.lib.oled_layer_step.argtypes = [ctypes.c_int, ctypes.c_uint32, ctypes.c_char_p]
        self.lib.oled_state_reset()

        def frame(layer, dt):
            buf = ctypes.create_string_buffer(1024)
            self.lib.oled_layer_step(layer, dt, buf)
            return bytes(buf.raw)

        row = lambda fb, y: sum(oh.pixel(fb, x, y) for x in range(128))
        frame(0, 33)
        frame(1, 33)
        opened = frame(1, 250)
        # the band's two hairlines (rows 17 and 47) run the whole width; the page's own content never does
        self.assertGreaterEqual(min(row(opened, 17), row(opened, 47)), 126, "no band opens across the screen on a layer change")
        closed = frame(1, 1500)
        self.assertLess(max(row(closed, 17), row(closed, 47)), 110, "the layer flash never closes")

    def test_lava_lamp_sits_between_caps_and_keeps_moving(self):
        import ctypes
        self.lib.oled_screensaver_frame.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p]

        def frame_at(n):
            buf = ctypes.create_string_buffer(1024)
            self.lib.oled_screensaver_frame(5, n, buf)
            return bytes(buf.raw)

        a, b = frame_at(150), frame_at(210)   # after the title card has slid away from the bottom edge
        self.assertNotEqual(a, b, "the lava is not moving")
        for fb in (a, b):
            self.assertTrue(all(oh.pixel(fb, x, 2) for x in range(128)), "the top lamp cap is missing")
            self.assertTrue(all(oh.pixel(fb, x, 61) for x in range(128)), "the bottom lamp cap is missing")

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

    def test_startup_travel_offset_does_not_skip_the_intro(self):
        import ctypes
        self.lib.oled_idle_travel_step.argtypes = [ctypes.c_uint32, ctypes.c_float, ctypes.c_int]
        self.lib.oled_idle_reset()
        self.lib.oled_intro_restart()
        # The connected uncalibrated board reported 0.35 mm on every key, none pressed.
        self.lib.oled_idle_travel_step(100, 0.35, 0)
        self.assertEqual(self.lib.oled_intro_done(), 0, "a startup offset skipped the title")
        self.lib.oled_idle_travel_step(1500, 0.45, 0)
        self.assertEqual(self.lib.oled_intro_done(), 0, "unpressed travel skipped the title")
        self.lib.oled_idle_travel_step(33, 2.0, 1)
        self.assertEqual(self.lib.oled_intro_done(), 1, "a pressed key did not skip the title")

    def test_uncalibrated_or_calibrating_press_cannot_skip_title(self):
        import ctypes
        self.lib.oled_uncalibrated_intro_step.argtypes = [ctypes.c_uint32, ctypes.c_int]
        for output in (1, 3):
            self.lib.oled_idle_reset()
            self.lib.oled_intro_restart()
            self.assertEqual(self.lib.oled_uncalibrated_intro_step(100, output), 0)
            self.assertEqual(self.lib.oled_uncalibrated_intro_step(5900, output), 0)
            self.assertEqual(self.lib.oled_uncalibrated_intro_step(101, output), 1)

    def test_screensaver_dims_and_input_restores(self):
        self.lib.oled_idle_reset()
        full, dim = self.lib.oled_contrast_full(), self.lib.oled_contrast_dim()
        self.assertEqual(self.lib.oled_idle_step(1000, 0), full, "not at full contrast when idle starts")
        self.assertEqual(self.lib.oled_idle_step(29000, 0), full, "dimmed before the screensaver started")
        self.assertEqual(self.lib.oled_idle_step(16000, 0), full, "dimmed the moment the screensaver started")
        self.lib.oled_idle_start_screensaver()  # screensavers are now explicitly requested
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

    def test_idle_never_starts_screensaver_or_sleep(self):
        self.lib.oled_idle_reset()
        for dt in (46000, 200000, 3600000):
            self.lib.oled_idle_step(dt, 0)
            self.assertEqual(self.lib.oled_idle_hidden(), 0, "idle hid the selected screen")


class CherryBlossomTheme(unittest.TestCase):
    """Theme 1 restyles the screens; every screen keeps its place and its information."""

    @classmethod
    def setUpClass(cls):
        import ctypes
        cls.lib = oh.load()
        cls.lib.oled_intro_frame.argtypes = [ctypes.c_uint32, ctypes.c_char_p]

    def setUp(self):
        self.lib.oled_scene_theme(1)

    def tearDown(self):
        self.lib.oled_scene_theme(0)

    def both(self, scene):
        self.lib.oled_scene_theme(0)
        drift = oh.frame(self.lib, scene)
        self.lib.oled_scene_theme(1)
        return drift, oh.frame(self.lib, scene)

    def intro(self, ms):
        import ctypes
        buf = ctypes.create_string_buffer(1024)
        self.lib.oled_intro_frame(ms, buf)
        return bytes(buf.raw)

    @staticmethod
    def lit(fb, x0, y0, x1, y1):
        return sum(oh.pixel(fb, x, y) for x in range(x0, x1) for y in range(y0, y1))

    def test_every_screen_is_restyled_but_the_key_map_and_header_stay(self):
        for scene in ("standby", "travelling", "actuated", "menu_theme"):
            with self.subTest(scene=scene):
                drift, sakura = self.both(scene)
                self.assertNotEqual(drift, sakura, "the theme changes nothing")
                if scene != "menu_theme":
                    # the layer caption (rows 0..8) and the keypad map (x 85..127) are the same information
                    self.assertEqual(self.lit(drift, 0, 0, 80, 9), self.lit(sakura, 0, 0, 80, 9))
                    if scene == "travelling":   # a fresh press differs on purpose: a ring in Drift, petals here
                        self.assertEqual(self.lit(drift, 85, 10, 128, 52), self.lit(sakura, 85, 10, 128, 52))

    def test_the_key_card_is_a_seal_and_a_pressed_key_a_solid_stamp(self):
        fb = oh.frame(self.lib, "travelling")
        # double border: outer at x 2, inner at x 4 (rows 23..41), clear between them
        self.assertEqual([oh.pixel(fb, x, 30) for x in (2, 3, 4)], [1, 0, 1])
        pressed = oh.frame(self.lib, "actuated")
        self.assertEqual([oh.pixel(pressed, x, 30) for x in (2, 3, 4, 5)], [1, 1, 0, 1],
                         "a solid stamp with a dark inner border")

    def test_a_key_press_throws_petals_instead_of_the_ring(self):
        oh.frame(self.lib, "key_press")
        self.assertGreater(self.lib.oled_key_petals(), 0, "no petals from the press")
        self.lib.oled_scene_theme(0)
        oh.frame(self.lib, "key_press")
        self.assertEqual(self.lib.oled_key_petals(), 0, "Drift has no petals")

    def test_standby_shows_a_sprig_in_place_of_the_empty_scale(self):
        drift, sakura = self.both("standby")
        self.assertGreater(self.lit(sakura, 4, 52, 78, 61), self.lit(drift, 4, 52, 78, 61))
        self.assertEqual(self.lit(sakura, 0, 61, 80, 64), 0, "the sprig stays above the bottom rows")

    def test_a_layer_change_slides_paper_doors_shut_and_open(self):
        start = oh.frame(self.lib, "layer_change_start")
        shut = oh.frame(self.lib, "layer_change")
        # 150 ms in, the doors are on their way: their top rail does not yet cross the middle
        self.assertLess(sum(oh.pixel(start, x, 0) for x in range(128)), 128, "the doors met too soon")
        full_column = lambda fb, xs: any(all(oh.pixel(fb, x, y) for y in range(64)) for x in xs)
        self.assertTrue(full_column(start, range(0, 64)) and full_column(start, range(64, 128)),
                        "both doors (their lattice runs top to bottom) are on screen")
        # in the middle of the change they are shut, and a paper strip names the layer
        self.assertEqual(sum(oh.pixel(shut, 127, y) for y in range(64)), 64)
        self.assertGreater(self.lit(shut, 30, 30, 98, 46), 80, "no layer name on the strip")

    def test_the_title_grows_a_branch_stamps_the_seal_and_says_the_status(self):
        early, seal, end = self.intro(300), self.intro(3000), self.intro(5000)
        self.assertLess(self.lit(early, 0, 0, 128, 64), self.lit(seal, 0, 0, 128, 64))
        self.assertEqual(self.lit(early, 96, 0, 128, 30), 0, "the seal is there before it is stamped")
        self.assertGreater(self.lit(seal, 101, 5, 121, 25), 250, "the seal (a 20 x 20 stamp) is missing")
        self.assertGreater(self.lit(end, 0, 54, 128, 63), 40, "the status line is not typed in")

    def test_sakura_screensaver_moves_and_keeps_petals_in_the_air(self):
        import ctypes
        self.lib.oled_animation_reset.argtypes = [ctypes.c_uint32]
        self.lib.oled_animation_step.argtypes = [ctypes.c_int, ctypes.c_uint32, ctypes.c_char_p]
        self.lib.oled_animation_reset(5)
        frames = []
        for _ in range(4):
            buf = ctypes.create_string_buffer(1024)
            self.lib.oled_animation_step(6, 500, buf)
            frames.append(bytes(buf.raw))
        self.assertEqual(len(set(frames)), 4, "the scene stands still")
        # the moon (left) and the branch (top right) are always there
        for fb in frames:
            self.assertGreater(self.lit(fb, 13, 12, 44, 42), 60)
            self.assertGreater(self.lit(fb, 64, 0, 128, 30), 40)

    def sakura_cycle(self):
        """The branch base (x, y, scale, angle) and moon centre (x, y) every 33 ms over one 34 s cycle"""
        import ctypes
        self.lib.oled_animation_reset.argtypes = [ctypes.c_uint32]
        self.lib.oled_animation_step.argtypes = [ctypes.c_int, ctypes.c_uint32, ctypes.c_char_p]
        self.lib.oled_animation_reset(9)
        buf = ctypes.create_string_buffer(1024)
        out = (ctypes.c_float * 6)()
        layers = []
        for _ in range(int(34000 / 33)):
            self.lib.oled_animation_step(6, 33, buf)
            self.lib.oled_sakura_view(out)
            layers.append(tuple(out))
        return layers

    def test_sakura_camera_starts_far_pushes_in_then_pulls_back(self):
        layers = self.sakura_cycle()
        scales = [v[2] for v in layers]
        self.assertAlmostEqual(scales[0], 0.75, places=3, msg="does not start far off")
        top = scales.index(max(scales))
        self.assertAlmostEqual(max(scales), 1.7, places=3, msg="never comes close")
        self.assertTrue(all(b >= a for a, b in zip(scales[:top], scales[1:top + 1])), "the push-in wavers")
        self.assertTrue(all(b <= a for a, b in zip(scales[top:], scales[top + 1:])), "the pull-back wavers")
        self.assertLess(scales[-1], 0.8, "does not return to far")
        for a, b in zip(layers, layers[1:]):
            self.assertLess(abs(b[0] - a[0]) + abs(b[1] - a[1]), 2.0, "the branch jumped")
        self.assertEqual({v[3] for v in layers}, {0.0}, "the camera tilts")
        self.assertGreaterEqual(min(v[0] for v in layers), 128, "the branch's cut end came on screen")

    def test_sakura_branch_grows_against_a_still_moon(self):
        layers = self.sakura_cycle()
        span = lambda i: max(v[i] for v in layers) - min(v[i] for v in layers)
        self.assertGreater(span(0), 20, "the branch hardly moves as the camera zooms")
        # the moon is the fixed point the eye measures the zoom against
        self.assertEqual((span(4), span(5)), (0, 0), "the moon moves")


if __name__ == "__main__":
    unittest.main()
