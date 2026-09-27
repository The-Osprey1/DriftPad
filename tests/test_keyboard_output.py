"""
test_keyboard_output.py - Host-visible keyboard behaviour of the real firmware and the real library.

Scope: production C++ executed on the host. Each build links, unmodified:
  firmware/src/hall.cpp (key state machines, fed by a fake mux)
  firmware/src/keyboard_output.cpp + keyboard_output_hal_device.cpp + keycodes.cpp
  arduino-pico libraries/Keyboard/src/Keyboard.cpp and libraries/HID_Keyboard/src/*.cpp
Only TinyUSB and the USB host are fakes (tests/firmware_host/usb_fake.cpp): an endpoint that stays
busy until the host polls, a host that can stall, suspend (forgetting pressed keys) or unmount
(losing an in-flight report). Assertions are on what the HOST sees, not on internal state.

Every regression scenario is also run against the pre-fix firmware (commit e2031e2, whose
hall.cpp called Keyboard.press/release directly) and must show the defect there, which proves the
scenario detects it. Those checks skip in a shallow clone without that commit.

Pure Python standard library + a host C++ compiler (see tests/host_build.py).
"""

import ctypes
import random
import sys
import unittest
from pathlib import Path
from typing import FrozenSet, Optional, Tuple

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import host_build as hb

# Arduino Keyboard codes (libraries/HID_Keyboard/src/HID_Keyboard.h)
KEY_LEFT_CTRL = 0x80
KEY_LEFT_SHIFT = 0x81
KEY_DOWN_ARROW = 0xD9
KEY_F13 = 0xF0

# HID usages / modifier bits as they appear in reports
MOD_LCTRL = 0x01
MOD_LSHIFT = 0x02
U_A, U_B, U_H, U_DOWN, U_F13 = 0x04, 0x05, 0x0B, 0x51, 0x68

HostState = Tuple[int, FrozenSet[int]]
EMPTY: HostState = (0, frozenset())

_HOST_FAKES = ["host_clock.cpp", "mux_fake.cpp", "usb_fake.cpp", "kbd_harness.cpp"]
_libs = {}


def _build(prefix: bool) -> ctypes.CDLL:
    key = "prefix" if prefix else "current"
    if key in _libs:
        return _libs[key]
    hb.require_compiler()
    lib_sources = hb.keyboard_library_sources()
    fakes = hb.host_sources(*_HOST_FAKES)
    if prefix:
        root = hb.revision_files(hb.PREFIX_REVISION, ["firmware/src/hall.cpp", "firmware/include/hall.h"])
        sources = [root / "firmware" / "src" / "hall.cpp"] + fakes + \
            hb.host_sources("usb_fake_default_cb.cpp") + lib_sources
        path = hb.build("kbd_prefix", sources, hb.keyboard_include_dirs(root / "firmware" / "include"),
                        defines=["KH_PREFIX_REVISION=1"])
    else:
        sources = hb.firmware_sources("hall.cpp", "keyboard_output.cpp",
                                      "keyboard_output_hal_device.cpp", "keycodes.cpp") + fakes + lib_sources
        path = hb.build("kbd_current", sources, hb.keyboard_include_dirs())
    lib = ctypes.CDLL(str(path))
    i, f, u8p, u32p = ctypes.c_int, ctypes.c_float, ctypes.POINTER(ctypes.c_uint8), ctypes.POINTER(ctypes.c_uint32)
    sigs = {
        "kh_revision": ([], i), "kh_reset": ([], None), "kh_scan": ([i], None),
        "kh_set_travel": ([i, f], None), "kh_set_code": ([i, i], None), "kh_is_pressed": ([i], i),
        "kh_set_output": ([i], None), "kh_sim": ([i, f], None), "kh_sim_clear": ([i], None),
        "kh_set_rt_sens": ([f], None),
        "usbfake_set_host_polls": ([i], None), "usbfake_set_poll_interval_us": ([ctypes.c_uint32], None),
        "usbfake_suspend": ([], None), "usbfake_resume": ([], None),
        "usbfake_unmount": ([], None), "usbfake_mount": ([], None), "usbfake_fail_inflight": ([], None),
        "usbfake_host_state": ([u8p], None), "usbfake_busy": ([], i), "usbfake_counters": ([u32p], None),
        "usbfake_log_len": ([], i), "usbfake_log_entry": ([i, u8p], None), "usbfake_clear_log": ([], None),
    }
    if not prefix:
        sigs.update({
            "kh_release_all": ([], None), "kh_suppress": ([i, i], None), "kh_active_mask": ([], i),
            "kh_suppressed_mask": ([], i), "kh_pending": ([], i), "kh_delivery_state": ([], i),
            "kh_desired": ([u8p], None), "kh_stats": ([u32p], None),
        })
    for name, (args, res) in sigs.items():
        fn = getattr(lib, name)
        fn.argtypes = args
        fn.restype = res
    _libs[key] = lib
    return lib


class Rig:
    """Physical keys in, host-visible keyboard state out."""

    PRESS_MM = 2.5

    def __init__(self, lib: ctypes.CDLL):
        self.lib = lib
        lib.kh_reset()

    def scan(self, n: int = 1) -> None:
        self.lib.kh_scan(n)

    def code(self, key: int, code: int) -> None:
        self.lib.kh_set_code(key, code)

    def press(self, key: int) -> None:
        self.lib.kh_set_travel(key, self.PRESS_MM)
        for _ in range(30):
            self.scan()
            if self.lib.kh_is_pressed(key):
                self.scan(3)
                return
        raise AssertionError(f"key {key} did not actuate")

    def release(self, key: int) -> None:
        self.lib.kh_set_travel(key, 0.0)
        for _ in range(30):
            self.scan()
            if not self.lib.kh_is_pressed(key):
                self.scan(3)
                return
        raise AssertionError(f"key {key} did not release")

    def host(self) -> HostState:
        buf = (ctypes.c_uint8 * 7)()
        self.lib.usbfake_host_state(buf)
        return buf[0], frozenset(k for k in buf[1:7] if k)

    def desired(self) -> HostState:
        buf = (ctypes.c_uint8 * 7)()
        self.lib.kh_desired(buf)
        return buf[0], frozenset(k for k in buf[1:7] if k)

    def counters(self):
        buf = (ctypes.c_uint32 * 5)()
        self.lib.usbfake_counters(buf)
        return dict(zip(["queued", "delivered", "lost", "refused", "blocked_us"], buf))

    def stats(self):
        buf = (ctypes.c_uint32 * 7)()
        self.lib.kh_stats(buf)
        return dict(zip(["attempted", "confirmed", "resyncs", "overflow", "invalid", "link_drops", "lost"], buf))

    def log(self):
        out = []
        buf = (ctypes.c_uint8 * 8)()
        for i in range(self.lib.usbfake_log_len()):
            self.lib.usbfake_log_entry(i, buf)
            out.append((buf[0], buf[1], frozenset(k for k in buf[2:8] if k)))
        return out

    def delivered_reports(self):
        return [(m, k) for kind, m, k in self.log() if kind == 2]


# ---------------------------------------------------------------------------------------------
# Scenarios: each returns (host state observed at the checkpoint, the correct host state).
# ---------------------------------------------------------------------------------------------

def sc_remap_while_held(r: Rig) -> Tuple[HostState, HostState]:
    r.code(0, ord("a"))
    r.press(0)
    r.code(0, ord("b"))            # SET_KEY / layer switch while the key is down
    r.release(0)
    return r.host(), EMPTY


def sc_layer_change_while_held(r: Rig) -> Tuple[HostState, HostState]:
    # Key 6 is "5" on the numpad layer and Down on the navigation layer
    r.code(6, ord("5"))
    r.press(6)
    for k, code in enumerate([0xB1, 0xD2, 0xDA, 0xD3, 0xB3, 0xD8, 0xD9, 0xD7,
                              0xD1, 0xD5, 0xD9, 0xD6, 0xB2, 0xD4, 0x20, 0xB0]):
        r.code(k, code)            # configApplyToHardware() for layer 1
    r.release(6)
    return r.host(), EMPTY


def sc_duplicate_release_keeps_output(r: Rig) -> Tuple[HostState, HostState]:
    # Default navigation layer maps keys 6 and 10 both to Down
    r.code(6, KEY_DOWN_ARROW)
    r.code(10, KEY_DOWN_ARROW)
    r.press(6)
    r.press(10)
    r.release(6)                   # key 10 is still held
    return r.host(), (0, frozenset({U_DOWN}))


def sc_implicit_shift_shared(r: Rig) -> Tuple[HostState, HostState]:
    r.code(0, KEY_LEFT_SHIFT)
    r.code(1, ord("A"))            # 'A' implies left shift in the en_US layout
    r.press(0)
    r.press(1)
    r.release(1)                   # the Shift key is still held
    return r.host(), (MOD_LSHIFT, frozenset())


def sc_explicit_modifier_duplicate(r: Rig) -> Tuple[HostState, HostState]:
    r.code(12, KEY_LEFT_CTRL)
    r.code(13, KEY_LEFT_CTRL)
    r.press(12)
    r.press(13)
    r.release(12)
    return r.host(), (MOD_LCTRL, frozenset())


def sc_rollover_blocked_modifier_leak(r: Rig) -> Tuple[HostState, HostState]:
    for k, ch in enumerate("abcdef"):
        r.code(k, ord(ch))
        r.press(k)
    r.code(6, ord("H"))            # 7th key, needs shift: must be blocked all-or-nothing
    r.press(6)
    r.release(0)                   # next report: must not carry a phantom shift
    return r.host(), (0, frozenset({0x05, 0x06, 0x07, 0x08, 0x09}))


def sc_release_lost_while_host_stalled(r: Rig) -> Tuple[HostState, HostState]:
    r.code(0, ord("a"))
    r.code(1, ord("b"))
    r.press(0)                     # delivered normally
    r.lib.usbfake_set_host_polls(0)
    r.press(1)                     # queued, host does not collect it
    r.release(0)                   # library waits 500 ms, then skips the report
    r.release(1)
    r.lib.usbfake_set_host_polls(1)
    r.scan(20)                     # transport recovers; firmware keeps running
    return r.host(), EMPTY


def sc_held_key_across_suspend(r: Rig) -> Tuple[HostState, HostState]:
    r.code(0, ord("a"))
    r.press(0)
    r.lib.usbfake_suspend()        # host sleeps and forgets pressed keys
    r.scan(5)
    r.lib.usbfake_resume()
    r.scan(20)
    return r.host(), (0, frozenset({U_A}))   # the key is still physically held


def sc_held_key_across_bus_reset(r: Rig) -> Tuple[HostState, HostState]:
    r.code(0, ord("a"))
    r.lib.usbfake_set_host_polls(0)
    r.press(0)                     # report queued but never collected
    r.lib.usbfake_unmount()        # in-flight report lost
    r.scan(5)
    r.lib.usbfake_mount()
    r.lib.usbfake_set_host_polls(1)
    r.scan(20)
    return r.host(), (0, frozenset({U_A}))


def sc_sim_does_not_type(r: Rig) -> Tuple[HostState, HostState]:
    r.code(3, KEY_F13)
    r.lib.kh_sim(3, 3.0)           # SIM with keyboard output enabled
    r.scan(5)
    # Observed: everything the host was ever sent, not just the end state (a pre-fix SIM press
    # was undone by the next real scan, but the keystroke had already been typed)
    mods, keys = 0, frozenset()
    for m, k in r.delivered_reports():
        mods |= m
        keys |= k
    return (mods, keys), EMPTY


def sc_fast_press_types_once(r: Rig) -> Tuple[int, int]:
    """Observed: keystrokes of 'a' the host saw for ONE physical press at 300 mm/s."""
    r.lib.kh_set_rt_sens(0.10)
    r.code(0, ord("a"))
    mm = 0.0
    while mm < 3.5:
        mm = min(3.5, mm + 0.3)
        r.lib.kh_set_travel(0, mm)
        r.scan()
    r.scan(20)
    strokes, down = 0, False
    for _, keys in r.delivered_reports():
        if U_A in keys and not down:
            strokes += 1
        down = U_A in keys
    return strokes, 1


DEFECT_SCENARIOS = [
    sc_remap_while_held, sc_layer_change_while_held, sc_duplicate_release_keeps_output,
    sc_implicit_shift_shared, sc_explicit_modifier_duplicate, sc_rollover_blocked_modifier_leak,
    sc_release_lost_while_host_stalled, sc_held_key_across_suspend, sc_held_key_across_bus_reset,
    sc_sim_does_not_type, sc_fast_press_types_once,
]


class _Base(unittest.TestCase):
    PREFIX = False

    @classmethod
    def setUpClass(cls):
        cls.lib = _build(cls.PREFIX)

    def rig(self) -> Rig:
        return Rig(self.lib)


class TestPreFixRevisionDefects(_Base):
    """Each regression scenario, run on the pre-fix firmware (e2031e2), must show the defect."""
    PREFIX = True

    def test_every_scenario_exposes_a_defect_before_the_fix(self):
        self.assertEqual(self.lib.kh_revision(), 0)
        for scenario in DEFECT_SCENARIOS:
            with self.subTest(scenario=scenario.__name__):
                observed, correct = scenario(self.rig())
                self.assertNotEqual(observed, correct,
                                    f"{scenario.__name__} does not expose a defect in the pre-fix revision")


class TestKeyboardOutputRegressions(_Base):
    """The same scenarios on the current firmware must leave the host in the correct state."""

    def _check(self, scenario):
        r = self.rig()
        observed, correct = scenario(r)
        self.assertEqual(observed, correct, f"{scenario.__name__}: host sees {observed}, expected {correct}")
        return r

    def test_remap_while_held_releases_the_captured_key(self):
        r = self._check(sc_remap_while_held)
        # The new code never reached the host at any point
        self.assertNotIn(U_B, set().union(*[k for _, k in r.delivered_reports()]))

    def test_layer_change_while_held_releases_the_captured_key(self):
        self._check(sc_layer_change_while_held)

    def test_duplicate_mapping_output_stays_until_last_owner_releases(self):
        r = self._check(sc_duplicate_release_keeps_output)
        r.release(10)
        self.assertEqual(r.host(), EMPTY)

    def test_implicit_shift_does_not_release_a_held_shift_key(self):
        r = self._check(sc_implicit_shift_shared)
        r.release(0)
        self.assertEqual(r.host(), EMPTY)

    def test_duplicate_explicit_modifiers_are_reference_counted(self):
        r = self._check(sc_explicit_modifier_duplicate)
        r.release(13)
        self.assertEqual(r.host(), EMPTY)

    def test_rollover_blocks_seventh_key_including_its_modifier(self):
        r = self._check(sc_rollover_blocked_modifier_leak)
        self.assertEqual(r.stats()["overflow"], 1)
        # Never sent late: releasing more of the six does not bring the 7th in
        r.release(1)
        self.assertEqual(r.host(), (0, frozenset({0x06, 0x07, 0x08, 0x09})))
        r.release(6)               # the blocked key's release sends nothing it did not own
        for k in (2, 3, 4, 5):
            r.release(k)
        self.assertEqual(r.host(), EMPTY)
        for mods, keys in r.delivered_reports():
            self.assertLessEqual(len(keys), 6)
            self.assertNotIn(U_H, keys)
            self.assertFalse(mods & MOD_LSHIFT, "the blocked key's shift reached the host")

    def test_modifier_only_press_is_sent_while_six_usages_are_held(self):
        r = self.rig()
        for k, ch in enumerate("abcdef"):
            r.code(k, ord(ch))
            r.press(k)
        r.code(6, KEY_LEFT_SHIFT)
        r.press(6)
        # HID_Keyboard::press(128+bit) sets the bit but returns before sending when 6 slots are
        # full; the firmware must still get the modifier to the host
        self.assertEqual(r.host(), (MOD_LSHIFT, frozenset({4, 5, 6, 7, 8, 9})))

    def test_release_lost_while_host_stalled_is_reconciled(self):
        r = self._check(sc_release_lost_while_host_stalled)
        self.assertGreaterEqual(r.stats()["resyncs"], 1)

    def test_stalled_host_blocking_is_bounded_by_library_timeout(self):
        r = self.rig()
        r.code(0, ord("a"))
        r.code(1, ord("b"))
        r.press(0)
        r.lib.usbfake_set_host_polls(0)
        r.press(1)
        before = r.counters()["blocked_us"]
        r.release(0)
        blocked = r.counters()["blocked_us"] - before
        # arduino-pico USB.HIDReady() gives up after 500 ms per report while mounted and stalled
        self.assertLessEqual(blocked, 500000 + 1000)
        # service() itself never waits on a stalled host
        before = r.counters()["blocked_us"]
        r.scan(50)
        self.assertEqual(r.counters()["blocked_us"], before)

    def test_unconfirmed_report_is_not_assumed_delivered(self):
        r = self.rig()
        r.code(0, ord("a"))
        r.lib.usbfake_set_host_polls(0)
        r.press(0)
        self.assertEqual(r.host(), EMPTY)
        self.assertNotEqual(r.lib.kh_delivery_state(), 0, "an uncollected report was reported as confirmed")
        r.lib.usbfake_set_host_polls(1)
        r.scan(5)
        self.assertEqual(r.host(), (0, frozenset({U_A})))
        self.assertEqual(r.lib.kh_delivery_state(), 0)

    def test_failed_transfer_is_resent(self):
        r = self.rig()
        r.code(0, ord("a"))
        r.lib.usbfake_set_host_polls(0)
        r.press(0)
        r.lib.usbfake_fail_inflight()     # TinyUSB reports the transfer as failed
        r.lib.usbfake_set_host_polls(1)
        r.scan(5)
        self.assertEqual(r.host(), (0, frozenset({U_A})))
        self.assertGreaterEqual(r.stats()["lost"], 1)
        self.assertEqual(r.lib.kh_delivery_state(), 0)

    def test_held_key_is_restored_after_suspend(self):
        r = self._check(sc_held_key_across_suspend)
        r.release(0)
        self.assertEqual(r.host(), EMPTY)

    def test_held_key_is_restored_after_bus_reset(self):
        r = self._check(sc_held_key_across_bus_reset)
        self.assertGreaterEqual(r.stats()["link_drops"], 1)
        r.release(0)
        self.assertEqual(r.host(), EMPTY)

    def test_simulated_travel_never_reaches_the_host(self):
        r = self._check(sc_sim_does_not_type)
        r.lib.kh_sim(3, 0.0)
        r.lib.kh_sim(3, 3.0)
        r.scan(5)
        self.assertEqual(r.host(), EMPTY)
        self.assertEqual(r.delivered_reports(), [])

    def test_physically_held_key_does_not_fire_when_sim_ends(self):
        r = self.rig()
        r.code(3, KEY_F13)
        r.lib.kh_sim(3, 0.0)
        r.lib.kh_set_travel(3, 3.0)    # finger on the key while it is simulated
        r.scan(10)
        r.lib.kh_sim_clear(3)
        r.scan(20)
        self.assertEqual(r.host(), EMPTY)
        r.release(3)
        r.press(3)                     # a fresh press after returning to rest works
        self.assertEqual(r.host(), (0, frozenset({U_F13})))

    def test_disable_while_held_releases_and_enable_does_not_press(self):
        r = self.rig()
        r.code(0, ord("a"))
        r.press(0)
        r.lib.kh_set_output(0)
        r.scan(3)
        self.assertEqual(r.host(), EMPTY)
        r.lib.kh_set_output(1)
        r.scan(10)
        self.assertEqual(r.host(), EMPTY, "enabling output pressed a key that was already held")
        r.release(0)
        r.press(0)
        self.assertEqual(r.host(), (0, frozenset({U_A})))

    def test_release_all_then_held_key_needs_a_fresh_press(self):
        r = self.rig()
        r.code(0, ord("a"))
        r.press(0)
        r.lib.kh_release_all()      # calibration start, RESET ALL, BOOTSEL
        r.scan(3)
        self.assertEqual(r.host(), EMPTY)
        r.release(0)
        self.assertEqual(r.host(), EMPTY)
        r.press(0)
        self.assertEqual(r.host(), (0, frozenset({U_A})))

    def test_hard_suppression_survives_release_edge_until_rest(self):
        r = self.rig()
        r.code(0, ord("a"))
        r.lib.kh_set_travel(0, 3.0)   # held at boot: not yet pressed in the state machine
        r.lib.kh_suppress(0, 1)
        r.scan(20)
        self.assertEqual(r.host(), EMPTY)
        # A Rapid Trigger release mid-stroke and re-press must not fire either
        r.lib.kh_set_travel(0, 2.0)
        r.scan(10)
        r.lib.kh_set_travel(0, 3.0)
        r.scan(10)
        self.assertEqual(r.host(), EMPTY)
        r.release(0)
        r.press(0)
        self.assertEqual(r.host(), (0, frozenset({U_A})))

    def test_fast_press_at_minimum_rt_types_once(self):
        self._check(sc_fast_press_types_once)

    def test_code_zero_and_unmapped_codes_send_nothing(self):
        r = self.rig()
        r.code(0, 0)                  # "None"
        r.code(1, 1)                  # unmapped ASCII control code
        r.press(0)
        r.press(1)
        self.assertEqual(r.host(), EMPTY)
        self.assertEqual(r.stats()["invalid"], 1)
        r.release(0)
        r.release(1)
        self.assertEqual(r.delivered_reports(), [])

    def test_random_fault_schedule_converges_to_desired_state(self):
        """Fuzz: keys, remaps, output toggles and transport faults; after the transport is healthy
        again the host must equal the union of the actions the firmware says keys own."""
        codes = [ord("a"), ord("b"), ord("A"), ord("!"), KEY_LEFT_SHIFT, KEY_LEFT_CTRL, KEY_DOWN_ARROW,
                 KEY_F13, 0xB0, 0, ord("c"), ord("d"), ord("e"), ord("f"), ord("g"), ord("h")]
        for seed in range(6):
            with self.subTest(seed=seed):
                rng = random.Random(seed)
                r = self.rig()
                for k in range(16):
                    r.code(k, rng.choice(codes))
                held = set()
                for step in range(150):
                    op = rng.random()
                    k = rng.randrange(16)
                    if op < 0.45:
                        if k in held:
                            r.release(k)
                            held.discard(k)
                        else:
                            r.press(k)
                            held.add(k)
                    elif op < 0.6:
                        r.code(k, rng.choice(codes))
                    elif op < 0.65:
                        r.lib.kh_set_output(rng.random() < 0.8)
                    elif op < 0.72:
                        r.lib.usbfake_set_host_polls(int(rng.random() < 0.6))
                    elif op < 0.76:
                        r.lib.usbfake_suspend()
                    elif op < 0.80:
                        r.lib.usbfake_resume()
                    elif op < 0.83:
                        r.lib.usbfake_unmount()
                    elif op < 0.86:
                        r.lib.usbfake_mount()
                    else:
                        r.scan(rng.randrange(1, 5))
                    desired = r.desired()
                    self.assertLessEqual(len(desired[1]), 6)
                r.lib.usbfake_mount()
                r.lib.usbfake_resume()
                r.lib.usbfake_set_host_polls(1)
                r.scan(30)
                self.assertEqual(r.host(), r.desired(), f"seed {seed}: host diverged from desired state")
                self.assertEqual(r.lib.kh_delivery_state(), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
