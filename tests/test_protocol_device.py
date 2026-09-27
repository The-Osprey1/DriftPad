"""
test_protocol_device.py - The serial protocol of the real firmware, end to end.

Scope: production C++ executed on the host. The whole firmware image (main.cpp and every module it
links; only the OLED is a stub) runs on host fakes: commands are fed into the fake USB serial port
and assertions are made on the JSON lines it sends back and on the sensing engine's effective
settings. This replaces the old Python MockSerialCommandParser as the evidence for the protocol.

Each regression scenario is also run against the pre-fix firmware (commit e2031e2) and must show
the defect there. Those checks skip in a shallow clone without that commit.
"""

import ctypes
import json
import random
import re
import sys
import unittest
from pathlib import Path
from typing import Any, Tuple

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import device_host as dh


def _errors(replies, code=None):
    return [r for r in replies if r.get("status") == "error" and (code is None or r.get("code") == code)]


# ---------------------------------------------------------------------------------------------
# Scenarios: each returns (observed, correct)
# ---------------------------------------------------------------------------------------------

def sc_actuation_floor_reported_equals_engine(d: dh.Device) -> Tuple[Any, Any]:
    """0.10 mm is below the sensing floor. Whatever the device does, the actuation it reports
    must be the one the sensing engine actually uses."""
    d.replies("SET_ACTUATION 0.10")
    reported = round(d.config()["actuation"], 2)
    engine = round(d.lib.engine_actuation(), 2)
    return reported, engine


def sc_invalid_bool_is_rejected(d: dh.Device) -> Tuple[Any, Any]:
    replies = d.replies("SET_RT_ENABLE abc")
    return (bool(d.lib.engine_rt_enabled()), len(_errors(replies)) == 1), (True, True)


def sc_extra_argument_is_rejected(d: dh.Device) -> Tuple[Any, Any]:
    replies = d.replies("SET_LAYER 1 junk")
    return (d.lib.active_layer(), len(_errors(replies)) == 1), (0, True)


def sc_trailing_junk_number_is_rejected(d: dh.Device) -> Tuple[Any, Any]:
    replies = d.replies("SET_RT_SENS 0.3x")
    return (round(d.lib.engine_rt_sens(), 2), len(_errors(replies)) == 1), (0.20, True)


def sc_malformed_command_gets_one_reply(d: dh.Device) -> Tuple[Any, Any]:
    return len(d.replies("SET_KEY 0 0 abc")), 1


def sc_overlong_line_is_not_executed(d: dh.Device) -> Tuple[Any, Any]:
    line = "SET_LAYER 2" + " " * 150 + "x"          # 162 bytes: longer than any accepted line
    replies = d.replies(line)
    return (d.lib.active_layer(), len(_errors(replies)) == 1), (0, True)


def sc_label_rule_is_shared(d: dh.Device) -> Tuple[Any, Any]:
    """"N/" is a valid label by the shared rule (tests/fixtures/label_vectors.json)."""
    d.replies("SET_KEY 1 5 220 N/")
    label = d.config()["layers"][1][5]["label"]
    return label, "N/"


def sc_request_id_is_echoed(d: dh.Device) -> Tuple[Any, Any]:
    replies = d.replies("@7 PING")
    ok = [r for r in replies if r.get("id") == "7" and r.get("status") == "ok"]
    return len(ok), 1


def sc_setting_changes_do_not_write_flash(d: dh.Device) -> Tuple[Any, Any]:
    """A slider drag sends many SET commands; none of them may commit flash (only SAVE does)."""
    before = d.lib.eeprom_fake_commits()
    for i in range(10):
        d.replies(f"SET_ACTUATION {1.20 + 0.05 * i:.2f}")
    return d.lib.eeprom_fake_commits() - before, 0


DEFECT_SCENARIOS = [
    sc_actuation_floor_reported_equals_engine, sc_invalid_bool_is_rejected,
    sc_extra_argument_is_rejected, sc_trailing_junk_number_is_rejected,
    sc_malformed_command_gets_one_reply, sc_overlong_line_is_not_executed,
    sc_label_rule_is_shared, sc_request_id_is_echoed, sc_setting_changes_do_not_write_flash,
]


class TestPreFixProtocolDefects(unittest.TestCase):
    """Each protocol regression scenario, run on the pre-fix firmware (e2031e2), shows the defect."""

    @classmethod
    def setUpClass(cls):
        cls.lib = dh.prefix_device()

    def test_every_scenario_exposes_a_defect_before_the_fix(self):
        for scenario in DEFECT_SCENARIOS:
            with self.subTest(scenario=scenario.__name__):
                d = dh.Device(self.lib)
                observed, correct = scenario(d)
                self.assertNotEqual(observed, correct,
                                    f"{scenario.__name__} does not expose a defect in the pre-fix revision")


LIMITS_H = TESTS_DIR.parent / "firmware" / "include" / "settings_limits.h"
LABEL_VECTORS = json.loads((TESTS_DIR / "fixtures" / "label_vectors.json").read_text(encoding="utf-8"))


def _limit(name: str) -> int:
    m = re.search(name + r"\s*=\s*(\d+)", LIMITS_H.read_text(encoding="utf-8"))
    assert m, name
    return int(m.group(1))


class TestProtocolDevice(unittest.TestCase):
    """The current firmware, whole image on the host, through its serial port."""

    @classmethod
    def setUpClass(cls):
        cls.lib = dh.current_device()

    def setUp(self):
        self.lib.eeprom_fake_erase()
        self.d = dh.Device(self.lib)

    def one(self, line: str) -> dict:
        replies = self.d.replies(line)
        self.assertEqual(len(replies), 1, f"{line!r} produced {len(replies)} replies: {replies}")
        return replies[0]

    # -- the regression scenarios -------------------------------------------------------------

    def test_regression_scenarios_are_correct(self):
        for scenario in DEFECT_SCENARIOS:
            with self.subTest(scenario=scenario.__name__):
                self.lib.eeprom_fake_erase()
                observed, correct = scenario(dh.Device(self.lib))
                self.assertEqual(observed, correct)

    # -- identification and limits ------------------------------------------------------------

    def test_info_identifies_device_and_reports_the_one_set_of_limits(self):
        info = self.one("@a1 INFO")
        self.assertEqual(info["id"], "a1")
        self.assertEqual((info["device"], info["protocol"]), ("DriftPad", 2))
        self.assertRegex(info["fw"], r"^\d+\.\d+\.\d+")
        lim = info["limits"]
        self.assertEqual(lim["actuation"]["min"], _limit("ACTUATION_MIN_CMM") / 100)
        self.assertEqual(lim["actuation"]["max"], _limit("ACTUATION_MAX_CMM") / 100)
        self.assertEqual(lim["actuation"]["default"], _limit("ACTUATION_DEFAULT_CMM") / 100)
        self.assertEqual(lim["rt_sens"]["min"], _limit("RT_SENS_MIN_CMM") / 100)
        self.assertEqual(lim["rt_sens"]["max"], _limit("RT_SENS_MAX_CMM") / 100)
        self.assertEqual(lim["line_max"], _limit("LINE_MAX_LEN"))
        for key in ("calibration", "output", "settings", "build", "features", "uptime_ms"):
            self.assertIn(key, info)
        self.assertFalse(info["output"]["enabled"], "keyboard output must start disabled")

    def test_limits_are_enforced_at_both_ends(self):
        lo, hi = _limit("ACTUATION_MIN_CMM"), _limit("ACTUATION_MAX_CMM")
        for cmm, ok in ((lo - 1, False), (lo, True), (hi, True), (hi + 1, False)):
            r = self.one(f"SET_ACTUATION {cmm // 100}.{cmm % 100:02d}")
            self.assertEqual(r["status"] == "ok", ok, r)
            if ok:
                self.assertEqual(round(r["actuation"] * 100), cmm)
                self.assertAlmostEqual(self.lib.engine_actuation(), cmm / 100, places=4)
        lo, hi = _limit("RT_SENS_MIN_CMM"), _limit("RT_SENS_MAX_CMM")
        for cmm, ok in ((lo - 1, False), (lo, True), (hi, True), (hi + 1, False)):
            r = self.one(f"SET_RT_SENS {cmm // 100}.{cmm % 100:02d}")
            self.assertEqual(r["status"] == "ok", ok, r)
            if ok:
                self.assertAlmostEqual(self.lib.engine_rt_sens(), cmm / 100, places=4)

    def test_encoder_reaches_exactly_the_protocol_limits(self):
        # MenuMode order: 0 = RT sensitivity, 1 = actuation
        for _ in range(60):
            self.lib.vd_encoder_apply(1, -1)
        self.assertAlmostEqual(self.lib.engine_actuation(), _limit("ACTUATION_MIN_CMM") / 100, places=4)
        for _ in range(60):
            self.lib.vd_encoder_apply(1, +1)
        self.assertAlmostEqual(self.lib.engine_actuation(), _limit("ACTUATION_MAX_CMM") / 100, places=4)
        for _ in range(60):
            self.lib.vd_encoder_apply(0, -1)
        self.assertAlmostEqual(self.lib.engine_rt_sens(), _limit("RT_SENS_MIN_CMM") / 100, places=4)
        for _ in range(60):
            self.lib.vd_encoder_apply(0, +1)
        self.assertAlmostEqual(self.lib.engine_rt_sens(), _limit("RT_SENS_MAX_CMM") / 100, places=4)
        self.assertEqual(round(self.d.config()["rt_sens"] * 100), _limit("RT_SENS_MAX_CMM"))

    # -- strict parsing -----------------------------------------------------------------------

    def test_malformed_numbers_are_rejected_and_change_nothing(self):
        for bad in ("abc", "1.", ".5", "1.234", "-1", "+1", "1e0", "0x1", "1,5", "nan", "1.2.3", "0.3x"):
            with self.subTest(value=bad):
                r = self.one(f"SET_RT_SENS {bad}")
                self.assertEqual((r["status"], r["code"]), ("error", "bad_number"))
                self.assertAlmostEqual(self.lib.engine_rt_sens(), 0.20, places=4)
        for bad in ("2", "on2", "yes", "-1"):
            with self.subTest(bool_value=bad):
                r = self.one(f"SET_RT_ENABLE {bad}")
                self.assertEqual(r["status"], "error")
                self.assertTrue(self.lib.engine_rt_enabled())

    def test_argument_counts_are_exact(self):
        for line in ("SET_LAYER", "SET_LAYER 1 2", "SET_KEY 0 0", "SET_KEY 0 0 4 AB CD", "PING x",
                     "SAVE now", "SET_ACTUATION 1 2", "SET_RT_SENS"):
            with self.subTest(line=line):
                self.assertEqual(self.one(line)["code"], "bad_arguments")
        self.assertEqual(self.lib.active_layer(), 0)

    def test_every_request_gets_exactly_one_reply_with_its_id(self):
        verbs = ["PING", "INFO", "GET_CONFIG", "STATUS", "SET_ACTUATION", "SET_RT_SENS", "SET_RT_ENABLE",
                 "SET_LAYER", "SET_KEY", "SET_HID", "REVERT", "RESET", "SIM", "SCAN_RATE", "TIMING", "RAW",
                 "FULLSCREEN", "WAKE", "OLED_SCAN", "NOPE", "set_layer", "Ping"]
        args = ["", "0", "1", "1.25", "0.10", "abc", "2 3", "0 0 4", "0 0 4 A", "OFF", "RESET", "-1", "99999999999"]
        rng = random.Random(1)
        for n in range(150):
            line = f"@q{n} {rng.choice(verbs)} {rng.choice(args)}".rstrip()
            replies = self.d.replies(line)
            self.assertEqual(len(replies), 1, f"{line!r}: {replies}")
            self.assertEqual(replies[0]["id"], f"q{n}")
            self.assertIn(replies[0]["status"], ("ok", "error"))
            self.assertIn("cmd", replies[0])
        self.one("SIM OFF")

    def test_overlong_and_control_character_lines_are_discarded(self):
        r = self.one("@x9 SET_LAYER 2" + " " * 150 + "x")
        self.assertEqual((r["code"], r.get("id")), ("line_too_long", "x9"))
        self.d.send_raw(b"SET_LAYER\x012\n")
        self.d.run(200)
        got = [j for j in self.d.json_lines(self.d.drain()) if "status" in j]
        self.assertEqual([j["code"] for j in got], ["bad_request"])
        self.assertEqual(self.lib.active_layer(), 0)
        self.assertEqual(self.one("SET_LAYER 2")["active_layer"], 2)   # the stream recovered

    def test_unrelated_lines_never_carry_a_request_id(self):
        self.one("STREAM 1 60")
        self.d.send_raw(b"@z1 PING\n")
        self.d.run(600)
        lines = self.d.json_lines(self.d.drain())
        self.assertEqual(len([j for j in lines if j.get("id") == "z1"]), 1)
        telemetry = [j for j in lines if j.get("type") == "telemetry"]
        self.assertTrue(telemetry)
        for j in telemetry:
            self.assertNotIn("status", j)
            self.assertNotIn("id", j)
        self.one("STREAM 0")

    # -- labels -------------------------------------------------------------------------------

    def test_label_rule_matches_the_shared_vectors(self):
        out = ctypes.create_string_buffer(8)
        for v in LABEL_VECTORS["vectors"]:
            with self.subTest(label=v["in"]):
                ok = self.lib.vd_normalize_label(v["in"].encode("utf-8"), out)
                if v["out"] is None:
                    self.assertEqual(ok, 0)
                else:
                    self.assertEqual((ok, out.value.decode()), (1, v["out"]))

    def test_labels_over_the_protocol_are_normalised_or_rejected(self):
        for v in LABEL_VECTORS["vectors"]:
            label = v["in"]
            if not label or label != label.strip() or " " in label or any(ord(c) < 0x20 or ord(c) == 0x7F for c in label):
                continue    # not one protocol token (control bytes are rejected by the line reader)
            with self.subTest(label=label):
                r = self.one("SET_KEY 2 3 97 " + label)
                if v["out"] is None:
                    self.assertEqual(r["code"], "invalid_label")
                else:
                    self.assertEqual(r["label"], v["out"])
                    self.assertEqual(self.d.config()["layers"][2][3]["label"], v["out"])

    # -- apply, persist, revert ---------------------------------------------------------------

    def test_apply_then_save_then_reboot_restores_effective_values(self):
        self.assertTrue(self.one("SET_ACTUATION 2.35")["dirty"])
        self.one("SET_RT_SENS 0.45")
        self.one("SET_RT_ENABLE 0")
        self.one("SET_KEY 1 6 216 L2")
        self.one("SET_LAYER 1")
        before = self.d.config()
        self.assertTrue(before["dirty"])
        commits = self.lib.eeprom_fake_commits()
        saved = self.one("SAVE")
        self.assertEqual((saved["status"], saved["persisted"], saved["dirty"]), ("ok", True, False))
        self.assertEqual(self.lib.eeprom_fake_commits(), commits + 1)
        after = dh.Device(self.lib).config()     # power cycle over the same flash
        for k in ("actuation", "rt_sens", "rt_enabled", "active_layer", "layers"):
            self.assertEqual(after[k], before[k], k)
        self.assertFalse(after["dirty"])
        self.assertAlmostEqual(self.lib.engine_actuation(), 2.35, places=4)
        self.assertEqual(self.lib.vd_engine_code(6), 216)   # layer 1 is active after boot

    def test_unsaved_changes_are_lost_on_power_cycle_and_revert_restores_saved(self):
        self.one("SET_ACTUATION 1.50")
        self.one("SAVE")
        self.one("SET_ACTUATION 3.00")
        r = self.one("REVERT")
        self.assertEqual((r["status"], r["dirty"]), ("ok", False))
        self.assertEqual(self.d.config()["actuation"], 1.5)
        self.one("SET_ACTUATION 3.00")
        self.assertEqual(dh.Device(self.lib).config()["actuation"], 1.5)

    def test_revert_without_saved_settings_is_refused(self):
        self.assertEqual(self.one("REVERT")["code"], "not_allowed")

    def test_reset_applies_defaults_without_saving(self):
        self.one("SET_ACTUATION 2.00")
        self.one("SAVE")
        commits = self.lib.eeprom_fake_commits()
        r = self.one("RESET")
        self.assertEqual((r["applied"], r["persisted"], r["dirty"]), (True, False, True))
        self.assertEqual(self.d.config()["actuation"], 1.2)
        self.assertEqual(self.lib.eeprom_fake_commits(), commits)

    def test_saving_unchanged_settings_still_verifies(self):
        self.one("SAVE")
        r = self.one("SAVE")
        self.assertEqual((r["status"], r["persisted"]), ("ok", True))

    # -- keyboard output through the whole firmware -------------------------------------------

    def _host(self):
        buf = (ctypes.c_uint8 * 7)()
        self.lib.usbfake_host_state(buf)
        return buf[0], frozenset(k for k in buf[1:7] if k)

    def test_output_is_off_at_boot_and_hid_command_controls_it(self):
        self.lib.vd_set_travel(1, 2.5)       # key 1 = '7' on the numpad layer
        self.d.run(300)
        self.assertEqual(self._host(), (0, frozenset()))
        self.lib.vd_set_travel(1, 0.0)
        self.d.run(300)
        r = self.one("SET_HID 1")
        self.assertEqual((r["hid_output"], r["output"]["enabled"]), (True, True))
        self.lib.vd_set_travel(1, 2.5)
        self.d.run(300)
        self.assertEqual(self._host(), (0, frozenset({0x24})))   # usage of '7'
        # remap while held through the protocol: the captured key is released
        self.one("SET_KEY 0 1 98 B")
        self.lib.vd_set_travel(1, 0.0)
        self.d.run(300)
        self.assertEqual(self._host(), (0, frozenset()))
        self.one("SET_HID 0")

    def test_bootsel_replies_before_rebooting_and_drops_output(self):
        self.one("SET_HID 1")
        r = self.one("BOOTSEL")
        self.assertTrue(r["bootsel"])
        self.assertEqual(self.lib.rp2040_fake_bootloader_requests(), 1)
        self.assertEqual(self.lib.vd_output_enabled(), 0)

    # -- bounded output -----------------------------------------------------------------------

    def test_output_never_outruns_a_slow_host(self):
        self.lib.serial_fake_set_tx_space(24)     # the CDC FIFO takes 24 bytes per call
        before = self.lib.serial_fake_writes_when_full()
        replies = self.d.replies("GET_CONFIG", iterations=3000)
        self.lib.serial_fake_set_tx_space(4096)
        self.assertEqual([r["type"] for r in replies], ["config"])
        self.assertEqual(self.lib.serial_fake_writes_when_full(), before,
                         "firmware wrote more than the host FIFO could take (would block the scan)")

    def test_telemetry_stops_when_the_host_closes_the_port(self):
        self.one("STREAM 1 30")
        self.d.run(2000)
        frames = [j for j in self.d.json_lines(self.d.drain()) if j.get("type") == "telemetry"]
        self.assertGreaterEqual(len(frames), 3)
        self.lib.serial_fake_set_dtr(0)
        self.d.run(100)
        self.lib.serial_fake_set_dtr(1)
        self.d.drain()
        self.d.run(2000)
        frames = [j for j in self.d.json_lines(self.d.drain()) if j.get("type") == "telemetry"]
        self.assertEqual(frames, [], "telemetry kept streaming into a closed session")

    def test_raw_capture_arrives_in_bounded_chunks(self):
        r = self.one("RAW 3")
        self.assertEqual(r["samples"], 1000)
        self.d.run(15000)
        chunks = [j for j in self.d.json_lines(self.d.drain()) if j.get("type") == "raw"]
        self.assertEqual(sum(len(c["samples"]) for c in chunks), 1000)
        self.assertEqual([c["offset"] for c in chunks], list(range(0, 1000, 100)))

    def test_sim_is_reported_and_never_types(self):
        self.one("SET_HID 1")
        r = self.one("SIM 4 3.00")
        self.assertEqual((r["type"], r["key"], r["pressed"]), ("sim_event", 4, True))
        self.d.run(200)
        self.assertEqual(self._host(), (0, frozenset()))
        self.one("SIM OFF")
        self.one("SET_HID 0")


if __name__ == "__main__":
    unittest.main(verbosity=2)
