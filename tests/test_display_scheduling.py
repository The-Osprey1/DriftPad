"""
test_display_scheduling.py - What core 0 does for the display, and when it saves.

Scope: production C++ executed on the host (the whole current image, tests/device_host.py). The
display itself and core 1 are not on the host: oled.cpp is replaced by a stub that serves display
requests at once (or never, when a test stalls it). What is tested here is core 0's side of the
contract in display_link.h:
  - the snapshot core 1 draws from is published after every scan and follows the sensing engine
    and the settings (core 1 reads nothing else);
  - OLED_TEST / OLED_SCAN are deferred to core 1 and never block core 0: other commands are
    answered meanwhile, and a stalled core 1 ends in display_timeout;
  - an encoder edit is saved (a flash write pauses the scan) only once the knob has rested and no
    key has changed state for a second; a key held still does not block it.
The last one is also run against the scheduler loop as it was before this change (main.cpp of
MAIN_BEFORE), which saved in the middle of typing.

The I2C timing of core 1 and the snapshot seqlock on the real RP2040 are hardware acceptance items
(docs/hardware-acceptance.md); tests/test_display_link.py covers the seqlock on the host.
"""

import ctypes
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import device_host as dh

MAIN_BEFORE = "21834a8"      # last commit whose main.cpp saved encoder edits regardless of typing
LOOPS_PER_MS = 10            # vd_loop: one loop() per 100 us of fake time
ENCODER_A_PIN, ENCODER_B_PIN = 20, 21   # firmware/include/pins.h


class KeyView(ctypes.Structure):
    _fields_ = [("travelMm", ctypes.c_float), ("pressCount", ctypes.c_uint8), ("releaseCount", ctypes.c_uint8),
                ("pressed", ctypes.c_bool), ("label", ctypes.c_char * 5)]


class Snapshot(ctypes.Structure):
    _fields_ = [("keys", KeyView * 16), ("lastActiveKey", ctypes.c_int8), ("activeLayer", ctypes.c_uint8),
                ("rapidTrigger", ctypes.c_bool), ("actuationMm", ctypes.c_float), ("rtSensMm", ctypes.c_float)]


def fresh(lib) -> dh.Device:
    lib.reset_flash()
    for k in range(16):
        lib.set_travel(k, 0.0)
    lib.pin_fake_set(ENCODER_A_PIN, 1)
    lib.pin_fake_set(ENCODER_B_PIN, 1)
    lib.oled_stub_stall(0)
    return dh.Device(lib)


def turn_encoder(d: dh.Device, detents: int = 1) -> None:
    """Quadrature for `detents` clicks (four state changes each, A and B pulled up at rest)."""
    seq = [(0, 1), (0, 0), (1, 0), (1, 1)] if detents > 0 else [(1, 0), (0, 0), (0, 1), (1, 1)]
    for _ in range(abs(detents)):
        for a, b in seq:
            d.lib.pin_fake_set(ENCODER_A_PIN, a)
            d.lib.pin_fake_set(ENCODER_B_PIN, b)
            d.run(20)


def run_ms(d: dh.Device, ms: int) -> None:
    d.run(ms * LOOPS_PER_MS)


class TestSnapshot(unittest.TestCase):
    """The snapshot is core 1's only view of the device."""

    @classmethod
    def setUpClass(cls):
        cls.lib = dh.current_device()

    def setUp(self):
        self.d = fresh(self.lib)

    def snap(self) -> Snapshot:
        s = Snapshot()
        self.assertEqual(self.lib.vd_display_snapshot(ctypes.byref(s)), 1, "nothing published")
        return s

    def published(self) -> int:
        out = (ctypes.c_uint32 * 4)()
        self.lib.vd_display_stats(out)
        return out[0]

    def one(self, line):
        r = self.d.replies(line)
        self.assertEqual(len(r), 1, r)
        return r[0]

    def test_layout_matches_the_firmware_struct(self):
        self.assertEqual(ctypes.sizeof(Snapshot), 204)

    def test_published_after_every_scan(self):
        before = self.published()
        run_ms(self.d, 200)
        scans = self.published() - before
        self.assertTrue(195 <= scans <= 205, f"{scans} publishes in 200 ms of 1 kHz scanning")

    def test_follows_keys_and_settings(self):
        s = self.snap()
        self.assertEqual((s.activeLayer, s.lastActiveKey, s.keys[1].label), (0, -1, b"7"))
        self.assertFalse(any(k.pressed for k in s.keys))
        presses = s.keys[5].pressCount

        self.lib.set_travel(5, 2.0)
        run_ms(self.d, 20)
        s = self.snap()
        self.assertTrue(s.keys[5].pressed)
        self.assertAlmostEqual(s.keys[5].travelMm, 2.0, delta=0.05)
        self.assertEqual((s.lastActiveKey, s.keys[5].pressCount), (5, (presses + 1) % 256))
        self.lib.set_travel(5, 0.0)
        run_ms(self.d, 20)
        self.assertFalse(self.snap().keys[5].pressed)

        self.one("SET_KEY 0 5 98 XY")
        self.one("SET_ACTUATION 2.00")
        self.one("SET_RT_SENS 0.50")
        self.one("SET_RT_ENABLE 0")
        run_ms(self.d, 2)
        s = self.snap()
        self.assertEqual((s.keys[5].label, s.actuationMm, s.rtSensMm, s.rapidTrigger), (b"XY", 2.0, 0.5, False))
        self.one("SET_LAYER 1")
        run_ms(self.d, 2)
        s = self.snap()
        self.assertEqual((s.activeLayer, s.keys[1].label), (1, b"HOME"))


class TestDisplayRequests(unittest.TestCase):
    """OLED_TEST / OLED_SCAN wait for core 1 without blocking core 0."""

    @classmethod
    def setUpClass(cls):
        cls.lib = dh.current_device()

    def setUp(self):
        self.d = fresh(self.lib)

    def tearDown(self):
        self.lib.oled_stub_stall(0)

    def test_served_requests_reply(self):
        self.assertEqual(self.d.replies("@t1 OLED_TEST"), [{"status": "ok", "id": "t1", "cmd": "OLED_TEST", "display": "test_pattern"}])
        self.assertEqual(self.d.replies("@s1 OLED_SCAN"), [{"status": "ok", "id": "s1", "cmd": "OLED_SCAN", "devices": [0x3C]}])

    def test_a_stalled_display_core_times_out_and_blocks_nothing(self):
        self.lib.oled_stub_stall(1)
        self.assertEqual(self.d.replies("@s1 OLED_SCAN"), [], "no reply until core 1 answers")
        ping = self.d.replies("@p1 PING")
        self.assertEqual([(r["id"], r["status"]) for r in ping], [("p1", "ok")], "core 0 keeps serving")
        busy = self.d.replies("@t1 OLED_TEST")
        self.assertEqual([(r["id"], r["code"]) for r in busy], [("t1", "busy")], "one deferred reply at a time")
        lines = self.d.exchange("", 1600 * LOOPS_PER_MS)
        replies = [j for j in dh.Device.json_lines(lines) if "status" in j]
        self.assertEqual([(r["id"], r["status"], r["code"]) for r in replies], [("s1", "error", "display_timeout")])

    def test_commands_post_display_requests_and_the_publish_is_timed(self):
        self.d.replies("TIMING RESET")
        for _ in range(5):
            self.d.replies("STATUS")
        run_ms(self.d, 50)
        t = self.d.replies("TIMING")[0]
        self.assertGreaterEqual(t["display_request_count"], 5)
        self.assertGreaterEqual(t["publish_count"], 45)


class TestEncoderSave(unittest.TestCase):
    """An encoder edit is saved when the knob rests and typing has stopped."""

    @classmethod
    def setUpClass(cls):
        cls.lib = dh.current_device()

    def setUp(self):
        self.d = fresh(self.lib)

    def rt_sens(self):
        return self.d.config()["rt_sens"]

    def edit(self):
        before = self.rt_sens()
        turn_encoder(self.d, 1)
        self.assertNotEqual(self.rt_sens(), before, "the knob changed the setting")
        return self.lib.flash_writes()

    def test_saved_once_the_knob_rests(self):
        writes = self.edit()
        run_ms(self.d, 2800)
        self.assertEqual(self.lib.flash_writes(), writes, "not while the knob may still move")
        run_ms(self.d, 400)
        self.assertEqual(self.lib.flash_writes(), writes + 1)
        self.assertFalse(self.d.config()["dirty"])

    def test_not_saved_while_keys_change(self):
        typing_saves = typing_while(self.d, self.edit())
        self.assertEqual(typing_saves, 0, "a flash write paused the scan in the middle of typing")
        writes = self.lib.flash_writes()
        run_ms(self.d, 1200)
        self.assertEqual(self.lib.flash_writes(), writes + 1, "saved a second after typing stopped")

    def test_a_key_held_still_does_not_block_the_save(self):
        self.lib.set_travel(3, 3.0)
        run_ms(self.d, 50)
        writes = self.edit()
        run_ms(self.d, 3300)
        self.assertEqual(self.lib.flash_writes(), writes + 1)
        self.lib.set_travel(3, 0.0)

    def test_a_failed_save_is_tried_again(self):
        self.lib.ff_fail_erase(1, 0)                 # the first erase fails, power stays on
        self.edit()
        run_ms(self.d, 3400)
        self.assertTrue(self.d.config()["dirty"], "the failed save left the change unsaved")
        run_ms(self.d, 3400)
        self.assertFalse(self.d.config()["dirty"], "the save was never tried again")


def typing_while(d: dh.Device, writes_before: int) -> int:
    """Taps key 3 every 200 ms for 5 s; returns the flash writes that happened meanwhile."""
    for _ in range(25):
        d.lib.set_travel(3, 3.0)
        run_ms(d, 60)
        d.lib.set_travel(3, 0.0)
        run_ms(d, 140)
    return d.lib.flash_writes() - writes_before


class TestCoreOwnershipInSource(unittest.TestCase):
    """The ownership rules of docs/scheduling.md, checked where they can be: in the source."""

    SCOPE = "source inspection"
    SRC = TESTS_DIR.parent / "firmware" / "src"

    def test_the_display_code_reads_nothing_of_core_0(self):
        text = (self.SRC / "oled.cpp").read_text(encoding="utf-8")
        code = "\n".join(l.split("//", 1)[0] for l in text.splitlines())   # comments may name things
        for header in ("hall.h", "config.h", "keyboard_output.h", "calibration.h", "commands.h"):
            self.assertNotIn(f'#include "{header}"', code)
        for name in ("HallManager::", "HallKey::", "configGet(", "KeyboardOutput::", "Calibration::"):
            self.assertNotIn(name, code)

    def test_only_the_display_code_uses_i2c(self):
        users = sorted(p.name for p in self.SRC.glob("*.cpp")
                       if "Wire." in p.read_text(encoding="utf-8") or "s_display." in p.read_text(encoding="utf-8"))
        self.assertEqual(users, ["oled.cpp"])


class TestEncoderSaveBeforeThisChange(unittest.TestCase):
    """The same typing scenario on the scheduler loop of MAIN_BEFORE: it saved mid-typing."""

    @classmethod
    def setUpClass(cls):
        cls.lib = dh.device_with_main_from(MAIN_BEFORE, TESTS_DIR / "firmware_host" / "legacy_main_shim.h")

    def test_old_loop_saved_in_the_middle_of_typing(self):
        d = fresh(self.lib)
        before = d.config()["rt_sens"]
        turn_encoder(d, 1)
        self.assertNotEqual(d.config()["rt_sens"], before)
        self.assertGreater(typing_while(d, self.lib.flash_writes()), 0,
                           "the old loop is expected to save during typing (the defect)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
