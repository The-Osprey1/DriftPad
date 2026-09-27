"""
test_persistence_device.py - Settings persistence and the calibration lifecycle, whole firmware.

Scope: production C++ executed on the host. The whole firmware image runs on host fakes; the
settings flash is a NOR model with power-cut and fault injection (tests/firmware_host/fake_flash.cpp
for the current firmware, the EEPROM-sector fake for the pre-fix one). Power-cut results here are
SOFTWARE fault injection only: they show the recovery logic, not what a real flash chip does when
its supply collapses. Physical power-cut behaviour stays unverified until tested on hardware
(docs/hardware-acceptance.md).

Each regression scenario also runs against the pre-fix firmware (commit e2031e2) and must show the
defect there (skipped in a shallow clone without that commit).
"""

import struct
import sys
import unittest
import zlib
from pathlib import Path
from typing import Any, Tuple

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import device_host as dh

REST = 2048
LOOPS_PER_SCAN = 10          # the harness runs loop() every 100 us; scans are every 1 ms


def v1_image(actuation=1.2, rt=0.2, rt_enabled=1, layer=0, layers=None) -> bytes:
    """A v1 settings image (legacy_settings_v1.h layout, ARM EABI padding) with a valid CRC."""
    if layers is None:
        layers = [[(0x61 + k % 26, "K%d" % k) for k in range(16)] for _ in range(3)]
    img = bytearray(344)
    struct.pack_into("<IB", img, 0, 0x44524654, 1)
    struct.pack_into("<ff", img, 8, actuation, rt)
    img[16] = rt_enabled
    img[17] = layer
    for l in range(3):
        for k in range(16):
            code, label = layers[l][k]
            off = 18 + (l * 16 + k) * 6
            img[off] = code
            img[off + 1:off + 6] = label.encode("ascii").ljust(5, b"\0")[:5]
    for k in range(16):
        struct.pack_into("<H", img, 306 + 2 * k, 2048)
    struct.pack_into("<I", img, 340, zlib.crc32(bytes(img[:340])) & 0xFFFFFFFF)
    return bytes(img)


def calibrate(d: dh.Device) -> None:
    """Whatever calibration the firmware offers, done at rest (and, where guided, with every key
    pressed to the bottom once)."""
    if d.lib.revision == "prefix":
        d.replies("CALIBRATE")
        return
    r = d.replies("CAL START")
    assert r and r[0]["status"] == "ok", r
    d.run(700 * LOOPS_PER_SCAN)                  # rest phase: 500 ms and 100 scans
    for k in range(16):
        d.lib.set_travel(k, 3.6)
        d.run(8 * LOOPS_PER_SCAN)
        d.lib.set_travel(k, 0.0)
        d.run(8 * LOOPS_PER_SCAN)
    r = d.replies("CAL FINISH")
    assert r and r[0]["status"] == "ok", r


# ---------------------------------------------------------------------------------------------
# Scenarios: each returns (observed, correct)
# ---------------------------------------------------------------------------------------------

def sc_power_cut_during_save_keeps_old_or_new(d: dh.Device) -> Tuple[Any, Any]:
    d.replies("SET_ACTUATION 2.00")
    d.replies("SAVE")
    d.lib.arm_power_cut(100)                     # power fails 100 bytes into the next flash write
    d.replies("SET_ACTUATION 2.50")
    d.replies("SAVE")
    d.lib.power_on()
    after = dh.Device(d.lib).config()["actuation"]
    return after in (2.0, 2.5), True


def sc_key_held_at_boot_is_not_taken_as_rest(d: dh.Device) -> Tuple[Any, Any]:
    calibrate(d)
    d.replies("SAVE")
    d.lib.set_travel(3, 2.5)                     # finger on key 3 while the pad powers up
    d2 = dh.Device(d.lib)
    d2.lib.set_travel(3, 0.0)                    # finger lifted
    d2.run(30 * LOOPS_PER_SCAN)
    pressed_at_rest = bool(d2.lib.is_pressed(3))
    d2.lib.set_travel(3, 2.5)                    # a real press
    d2.run(30 * LOOPS_PER_SCAN)
    pressed_when_pressed = bool(d2.lib.is_pressed(3))
    d2.lib.set_travel(3, 0.0)
    return (pressed_at_rest, pressed_when_pressed), (False, True)


def sc_crc_valid_but_invalid_settings_are_repaired(d: dh.Device) -> Tuple[Any, Any]:
    d.lib.reset_flash()
    d.lib.write_legacy_image(v1_image(actuation=0.10, layer=5))
    cfg = dh.Device(d.lib).config()
    return (cfg["active_layer"], cfg["actuation"]), (0, 0.25)


DEFECT_SCENARIOS = [
    sc_power_cut_during_save_keeps_old_or_new,
    sc_key_held_at_boot_is_not_taken_as_rest,
    sc_crc_valid_but_invalid_settings_are_repaired,
]


class TestPreFixPersistenceDefects(unittest.TestCase):
    """Each persistence/calibration scenario, on the pre-fix firmware (e2031e2), shows the defect."""

    @classmethod
    def setUpClass(cls):
        cls.lib = dh.prefix_device()

    def test_every_scenario_exposes_a_defect_before_the_fix(self):
        for scenario in DEFECT_SCENARIOS:
            with self.subTest(scenario=scenario.__name__):
                self.lib.reset_flash()
                self.lib.power_on()
                for k in range(16):
                    self.lib.set_travel(k, 0.0)
                observed, correct = scenario(dh.Device(self.lib))
                self.assertNotEqual(observed, correct,
                                    f"{scenario.__name__} does not expose a defect in the pre-fix revision")


class TestPersistenceRegressions(unittest.TestCase):
    """The same scenarios on the current firmware."""

    @classmethod
    def setUpClass(cls):
        cls.lib = dh.current_device()

    def test_regression_scenarios_are_correct(self):
        for scenario in DEFECT_SCENARIOS:
            with self.subTest(scenario=scenario.__name__):
                self.lib.reset_flash()
                for k in range(16):
                    self.lib.set_travel(k, 0.0)
                observed, correct = scenario(dh.Device(self.lib))
                self.assertEqual(observed, correct)


RECORD_MAGIC = 0x32535044
COMMIT_MAGIC = 0x4B4F5044


def ab_record(schema: int, seq: int, payload: bytes, header_version: int = 1) -> bytes:
    """A committed A/B record (settings_store.h layout) padded with 0xFF to one 4 KB sector."""
    hdr = bytearray(32)
    struct.pack_into("<IBBHIHHI", hdr, 0, RECORD_MAGIC, header_version, 0, schema, seq, len(payload), 0,
                     zlib.crc32(payload) & 0xFFFFFFFF)
    struct.pack_into("<I", hdr, 28, zlib.crc32(bytes(hdr[:28])) & 0xFFFFFFFF)
    body = bytes(hdr) + payload
    pages = (len(body) + 255) // 256
    sector = bytearray(b"\xff" * 4096)
    sector[:len(body)] = body
    struct.pack_into("<II", sector, pages * 256, COMMIT_MAGIC, seq)
    return bytes(sector)


class TestPersistence(unittest.TestCase):
    """A/B settings store, migration and fault injection, through the whole current firmware."""

    @classmethod
    def setUpClass(cls):
        cls.lib = dh.current_device()

    def setUp(self):
        self.lib.reset_flash()
        for k in range(16):
            self.lib.set_travel(k, 0.0)
        self.d = dh.Device(self.lib)

    def one(self, line, d=None):
        replies = (d or self.d).replies(line)
        self.assertEqual(len(replies), 1, f"{line!r}: {replies}")
        return replies[0]

    def reboot(self) -> dh.Device:
        self.d = dh.Device(self.lib)
        return self.d

    def info(self):
        return self.one("INFO")

    def sector(self, n) -> bytes:
        p = self.lib.ff_sector(n)
        return bytes(p[i] for i in range(4096))

    def write_sector(self, n, data: bytes):
        p = self.lib.ff_sector(n)
        for i, b in enumerate(data):
            p[i] = b

    # -- A/B basics ---------------------------------------------------------------------------

    def test_saves_alternate_slots_with_increasing_sequence(self):
        seen = []
        for i, v in enumerate(("1.30", "1.40", "1.50", "1.60")):
            self.one(f"SET_ACTUATION {v}")
            r = self.one("SAVE")
            self.assertEqual((r["status"], r["persisted"], r["dirty"]), ("ok", True, False))
            seen.append((r["slot"], r["seq"]))
        self.assertEqual(seen, [("a", 1), ("b", 2), ("a", 3), ("b", 4)])
        info = self.reboot().replies("INFO")[0]
        self.assertEqual((info["settings"]["source"], info["settings"]["seq"]), ("slot_b", 4))
        self.assertEqual(self.d.config()["actuation"], 1.6)

    def test_power_cut_at_every_programmed_byte_keeps_old_or_new(self):
        """Software fault injection: power fails after n programmed bytes of the second save, for
        every n. After power returns the device must hold exactly the old or the new settings."""
        outcomes = set()
        n = 0
        while True:
            self.lib.reset_flash()
            d = dh.Device(self.lib)
            d.replies("SET_ACTUATION 2.00")
            d.replies("SAVE")
            written_before = self.lib.ff_program_bytes()
            self.lib.arm_power_cut(n)
            d.replies("SET_ACTUATION 2.50")
            d.replies("SAVE")
            self.lib.power_on()
            got = dh.Device(self.lib).config()["actuation"]
            self.assertIn(got, (2.0, 2.5), f"power cut after {n} programmed bytes loaded {got}")
            outcomes.add(got)
            if got == 2.5:
                break
            n += 1
            self.assertLess(n, 4096, "the new record never became current")
        self.assertEqual(outcomes, {2.0, 2.5})
        # The record only counts once its commit page is programmed: that is the last 256 bytes
        self.assertGreaterEqual(n, 3 * 256 - 256)

    def test_power_cut_during_erase_keeps_the_previous_settings(self):
        for k in (0, 1, 256, 2048, 4095):
            with self.subTest(erased_bytes=k):
                self.lib.reset_flash()
                d = dh.Device(self.lib)
                d.replies("SET_ACTUATION 2.00")
                d.replies("SAVE")
                d.replies("SET_ACTUATION 2.50")
                d.replies("SAVE")                      # slot B now current
                self.lib.ff_cut_during_next_erase(k)   # the next save erases slot A and loses power
                d.replies("SET_ACTUATION 3.00")
                d.replies("SAVE")
                self.lib.power_on()
                self.assertEqual(dh.Device(self.lib).config()["actuation"], 2.5)

    def test_corrupt_newest_record_falls_back_to_the_older_one(self):
        self.one("SET_ACTUATION 2.00")
        self.one("SAVE")                                # slot a, seq 1
        self.one("SET_ACTUATION 2.50")
        self.one("SAVE")                                # slot b, seq 2
        self.lib.ff_flip_bits(1, 40, 0x01)              # one bit in slot B's payload
        info = self.reboot().replies("INFO")[0]
        self.assertEqual(info["settings"]["source"], "slot_a")
        self.assertIn("slot_b_corrupt", info["settings"]["load_errors"])
        self.assertEqual(self.d.config()["actuation"], 2.0)

    def test_verify_failure_reports_the_error_and_keeps_the_previous_record(self):
        self.one("SET_ACTUATION 2.00")
        self.one("SAVE")                                # slot a
        self.lib.ff_read_flip(1, 64, 0x10)              # slot B reads back wrong
        self.one("SET_ACTUATION 2.50")
        r = self.one("SAVE")
        self.assertEqual((r["status"], r["code"], r["persisted"], r["dirty"]),
                         ("error", "flash_verify_failed", False, True))
        self.lib.ff_read_flip(1, 64, 0)
        self.assertEqual(self.reboot().config()["actuation"], 2.0)

    def test_program_failure_reports_flash_error(self):
        self.one("SET_ACTUATION 2.00")
        self.one("SAVE")
        self.lib.ff_fail_program(1, 0)                  # the next program call writes nothing
        self.one("SET_ACTUATION 2.50")
        r = self.one("SAVE")
        self.assertEqual((r["status"], r["code"], r["persisted"]), ("error", "flash_error", False))
        self.assertTrue(self.info()["settings"]["dirty"])
        self.assertEqual(self.reboot().config()["actuation"], 2.0)

    def test_semantically_invalid_record_is_skipped(self):
        self.one("SET_ACTUATION 2.00")
        self.one("SAVE")                                # slot a, seq 1 (valid)
        payload = bytearray(self.sector(0)[32:32 + 396])
        struct.pack_into("<H", payload, 0, 5)           # actuation 0.05 mm: CRC-valid, out of range
        self.write_sector(1, ab_record(2, 9, bytes(payload)))
        info = self.reboot().replies("INFO")[0]
        self.assertEqual(info["settings"]["source"], "slot_a")
        self.assertIn("slot_b_invalid", info["settings"]["load_errors"])
        self.assertEqual(self.d.config()["actuation"], 2.0)

    def test_newer_schema_record_is_protected_until_the_second_save(self):
        self.one("SET_ACTUATION 2.00")
        self.one("SAVE")                                # slot a, seq 1
        newer = ab_record(3, 7, b"\x01" * 400)          # written by some future firmware
        self.write_sector(1, newer)
        info = self.reboot().replies("INFO")[0]
        self.assertEqual(info["settings"]["source"], "slot_a")
        self.assertIn("slot_b_newer_schema", info["settings"]["load_errors"])
        self.one("SET_ACTUATION 2.50")
        r = self.one("SAVE")
        self.assertEqual(r["slot"], "a")                # the newer record is not overwritten...
        self.assertEqual(self.sector(1), newer)
        self.assertGreater(r["seq"], 7)
        self.one("SET_ACTUATION 3.00")
        self.assertEqual(self.one("SAVE")["slot"], "b") # ...until the user saves a second time

    # -- migration ----------------------------------------------------------------------------

    def test_v1_settings_migrate_once_and_the_legacy_sector_is_never_written(self):
        layers = [[(0x61 + (k + l) % 26, "L%dK%d" % (l, k) if k < 10 else "L%d%d" % (l, k)) for k in range(16)]
                  for l in range(3)]
        image = v1_image(actuation=2.35, rt=0.45, rt_enabled=0, layer=2, layers=layers)
        self.lib.write_legacy_image(image)
        d = self.reboot()
        info = d.replies("INFO")[0]
        self.assertEqual(info["settings"]["source"], "legacy_v1")
        self.assertTrue(info["settings"]["dirty"], "migrated settings stay dirty until saved")
        self.assertEqual(info["calibration"]["state"], "missing")
        self.assertFalse(info["output"]["enabled"])
        cfg = d.config()
        self.assertEqual((cfg["actuation"], cfg["rt_sens"], cfg["rt_enabled"], cfg["active_layer"]),
                         (2.35, 0.45, False, 2))
        self.assertEqual(cfg["layers"][1][4]["code"], 0x61 + 5)
        self.assertEqual(cfg["layers"][1][4]["label"], "L1K4")
        legacy_before = bytes(self.lib.ff_legacy()[i] for i in range(4096))
        self.assertEqual(self.one("SAVE", d)["status"], "ok")
        info = self.reboot().replies("INFO")[0]
        self.assertEqual((info["settings"]["source"], info["settings"]["dirty"]), ("slot_a", False))
        self.assertEqual(bytes(self.lib.ff_legacy()[i] for i in range(4096)), legacy_before)

    def test_corrupt_legacy_image_falls_back_to_defaults_and_says_so(self):
        image = bytearray(v1_image(actuation=2.0))
        image[20] ^= 0xFF                               # CRC no longer matches
        self.lib.write_legacy_image(bytes(image))
        info = self.reboot().replies("INFO")[0]
        self.assertEqual(info["settings"]["source"], "defaults")
        self.assertIn("legacy_invalid", info["settings"]["load_errors"])
        self.assertEqual(self.d.config()["actuation"], 1.2)


class TestCalibrationRules(unittest.TestCase):
    """Plausibility of stored calibration (calibration.h), the rule applied on every load."""

    @classmethod
    def setUpClass(cls):
        cls.lib = dh.current_device()

    def test_plausibility_boundaries(self):
        ok = self.lib.vd_cal_key_plausible
        self.assertEqual((ok(63, 1000, 1), ok(64, 1000, 1)), (0, 1))            # rest off the low rail
        self.assertEqual((ok(4031, 1000, -1), ok(4032, 1000, -1)), (1, 0))      # rest off the high rail
        self.assertEqual((ok(2048, 299, 1), ok(2048, 300, 1)), (0, 1))          # minimum bottom-out range
        self.assertEqual((ok(3000, 1095, 1), ok(3000, 1096, 1)), (1, 0))        # bottom-out inside the ADC
        self.assertEqual((ok(1000, 1000, -1), ok(1000, 1001, -1)), (1, 0))
        self.assertEqual(ok(2048, 1000, 0), 0)                                   # polarity must be known


class TestCalibrationLifecycle(unittest.TestCase):
    """Guided calibration, restore at power-up, standalone output, through the whole firmware."""

    @classmethod
    def setUpClass(cls):
        cls.lib = dh.current_device()

    def setUp(self):
        self.lib.reset_flash()
        for k in range(16):
            self.lib.set_travel(k, 0.0)
        self.d = dh.Device(self.lib)

    def one(self, line, d=None):
        replies = (d or self.d).replies(line)
        self.assertEqual(len(replies), 1, f"{line!r}: {replies}")
        return replies[0]

    def host(self):
        import ctypes
        buf = (ctypes.c_uint8 * 7)()
        self.lib.usbfake_host_state(buf)
        return buf[0], frozenset(k for k in buf[1:7] if k)

    def events(self, lines):
        return [j for j in dh.Device.json_lines(lines) if j.get("type") == "cal" and "status" not in j]

    def test_calibration_is_saved_restored_and_gates_output(self):
        info = self.one("INFO")
        self.assertEqual((info["calibration"]["state"], info["output"]["reason"]), ("missing", "calibration_missing"))
        calibrate(self.d)
        info = self.one("INFO")
        self.assertEqual((info["calibration"]["state"], info["calibration"]["keys_valid"]), ("valid", 16))
        self.assertTrue(info["settings"]["dirty"])
        self.assertEqual(self.one("SET_HID 1")["output"]["reason"], "enabled")   # no FORCE needed now
        self.one("SET_HID 0")
        self.one("SAVE")
        info = dh.Device(self.lib).replies("INFO")[0]
        self.assertEqual(info["calibration"]["state"], "valid")
        self.assertEqual(info["output"]["reason"], "disabled_default", "output stays off unless standalone mode is on")

    def test_standalone_mode_enables_output_at_power_up_and_suppresses_held_keys(self):
        calibrate(self.d)
        self.one("SET_BOOT_OUTPUT 1")
        self.one("SAVE")
        self.lib.set_travel(1, 2.5)                     # key 1 ('7') held while powering up
        d = dh.Device(self.lib)
        info = d.replies("INFO")[0]
        self.assertEqual((info["output"]["enabled"], info["output"]["reason"]), (True, "enabled"))
        self.assertEqual(info["calibration"]["held_at_boot"], [1])
        d.run(300)
        self.assertEqual(self.host(), (0, frozenset()), "a key held at power-up typed")
        self.lib.set_travel(1, 0.0)
        d.run(300)
        self.lib.set_travel(1, 2.5)
        d.run(300)
        self.assertEqual(self.host(), (0, frozenset({0x24})))
        self.lib.set_travel(1, 0.0)
        d.run(300)
        self.assertEqual(self.host(), (0, frozenset()))

    def test_standalone_mode_without_calibration_keeps_output_off(self):
        self.one("SET_BOOT_OUTPUT 1")
        self.one("SAVE")
        info = dh.Device(self.lib).replies("INFO")[0]
        self.assertEqual((info["output"]["enabled"], info["output"]["reason"]), (False, "calibration_missing"))

    def test_guided_calibration_reports_progress_and_blocks_output(self):
        self.one("SET_HID 1 FORCE")
        r = self.one("CAL START")
        self.assertEqual(r["phase"], "rest")
        info = self.one("INFO")
        self.assertEqual((info["calibration"]["state"], info["output"]["reason"]),
                         ("in_progress", "calibration_in_progress"))
        self.assertEqual(self.one("SET_HID 1 FORCE")["code"], "busy")
        lines = self.d.exchange("CAL STATUS", 700 * LOOPS_PER_SCAN)
        phases = [e["phase"] for e in self.events(lines)]
        self.assertIn("travel", phases)
        self.lib.set_travel(5, 3.6)
        self.d.run(80)
        self.assertEqual(self.host(), (0, frozenset()), "a calibration press typed")
        self.lib.set_travel(5, 0.0)
        lines = self.d.exchange("CAL STATUS", 80)
        status = [j for j in dh.Device.json_lines(lines) if j.get("cmd") == "CAL"][0]
        self.assertEqual(status["travel_done"], [5])
        r = self.one("CAL FINISH")
        self.assertEqual((r["code"], len(r["missing"])), ("calibration_incomplete", 15))
        r = self.one("CAL CANCEL")
        self.assertEqual((r["phase"], r["output"]["enabled"], r["output"]["reason"]), ("cancelled", True, "forced"))
        self.assertEqual(self.one("INFO")["calibration"]["state"], "missing")

    def test_noisy_rest_fails_the_rest_phase_and_restores_output(self):
        self.one("SET_HID 1 FORCE")
        self.one("CAL START")
        for i in range(700):                            # key 9 flickers by 200 counts at rest
            self.lib.set_travel(9, 0.8 if i % 2 else 0.0)
            self.d.run(LOOPS_PER_SCAN)
        self.lib.set_travel(9, 0.0)
        lines = self.d.drain()
        failed = [e for e in self.events(lines) if e["phase"] == "failed"]
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]["rest_failed"], [9])
        info = self.one("INFO")
        self.assertEqual((info["calibration"]["state"], info["output"]["enabled"]), ("missing", True))

    def test_inactivity_cancels_calibration(self):
        self.one("CAL START")
        self.d.run(700 * LOOPS_PER_SCAN)
        self.d.drain()
        self.d.run(121000 * LOOPS_PER_SCAN // 10)       # 12.1 s of fake time in coarse steps...
        for _ in range(9):
            self.d.run(121000 * LOOPS_PER_SCAN // 10)   # ...to 121 s without a key moving
        phases = [e["phase"] for e in self.events(self.d.drain())]
        self.assertIn("cancelled", phases)
        self.assertEqual(self.one("INFO")["calibration"]["state"], "missing")

    def test_negative_polarity_sensors_calibrate(self):
        self.one("CAL START")
        self.d.run(700 * LOOPS_PER_SCAN)
        for k in range(16):
            self.lib.set_travel(k, -3.6)               # raw falls when pressed
            self.d.run(8 * LOOPS_PER_SCAN)
            self.lib.set_travel(k, 0.0)
            self.d.run(8 * LOOPS_PER_SCAN)
        self.assertEqual(self.one("CAL FINISH")["calibration"]["state"], "valid")
        self.lib.set_travel(2, -2.5)
        self.d.run(100)
        self.assertTrue(self.lib.is_pressed(2))
        self.lib.set_travel(2, 0.0)
        self.d.run(100)
        self.assertFalse(self.lib.is_pressed(2))

    def test_reset_all_clears_calibration_but_reset_keeps_it(self):
        calibrate(self.d)
        self.one("SET_ACTUATION 2.00")
        r = self.one("RESET")
        self.assertFalse(r["all"])
        info = self.one("INFO")
        self.assertEqual(info["calibration"]["state"], "valid")
        self.assertEqual(self.d.config()["actuation"], 1.2)
        r = self.one("RESET ALL")
        self.assertTrue(r["all"])
        info = self.one("INFO")
        self.assertEqual((info["calibration"]["state"], info["output"]["reason"]), ("missing", "calibration_missing"))
        self.assertEqual(self.one("RESET FOO")["code"], "bad_request")

    def test_quick_calibrate_refuses_while_a_key_is_held(self):
        calibrate(self.d)
        self.lib.set_travel(7, 2.0)
        self.d.run(100)
        r = self.one("CALIBRATE")
        self.assertEqual((r["code"], r["keys"]), ("keys_not_at_rest", [7]))
        self.lib.set_travel(7, 0.0)
        self.d.run(100)
        r = self.one("CALIBRATE")
        self.assertEqual((r["status"], r["calibration"]), ("ok", "valid"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
