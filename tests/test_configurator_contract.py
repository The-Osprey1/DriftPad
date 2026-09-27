"""
test_configurator_contract.py - The configurator's fake DriftPad answers like the real firmware.

Scope: headless browser + production C++ on the host. The same request lines go to
  - configurator/js/fake_device.js (in headless Chrome), which the configurator's own tests and
    its simulated mode talk to, and
  - the current firmware compiled for the host (tests/device_host.py: the whole image with fake
    Serial, flash and sensors),
and every reply is compared: status, cmd, id, error code, and every field's value and JSON type.
Human-readable "msg" text and time-dependent fields are excluded; a few diagnostic replies are
compared by shape (same fields, same types) only.

This is what keeps the fake honest: a configurator test that passes against the fake is passing
against the firmware's protocol, not against an invention. Skips without a browser or compiler.
"""

import json
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import chrome_host
import device_host as dh
import host_build as hb

CONFIGURATOR = TESTS_DIR.parent / "configurator"
INNER_RESULTS = {}   # reported by run_all_tests.py

# Stateful sequence: both devices start from a fresh flash with no calibration.
SCRIPT = [
    "@c1 INFO", "HELLO", "info", "GET_CONFIG", "STATUS", "PING",
    # settings: accepted, normalised, rejected
    "SET_ACTUATION 1.5", "SET_ACTUATION 01.50", "SET_ACTUATION 0.10", "SET_ACTUATION 3.81", "SET_ACTUATION 1.234",
    "SET_ACTUATION abc", "SET_ACTUATION 1.5x", "SET_ACTUATION -1", "SET_ACTUATION 99999999999",
    "SET_RT_SENS 0.3", "SET_RT_SENS 0.05", "SET_RT_SENS 2.5",
    "SET_RT_ENABLE 0", "SET_RT_ENABLE on", "SET_RT_ENABLE abc", "SET_RT_ENABLE 2",
    "SET_LAYER 1", "SET_LAYER 3", "SET_LAYER 1 junk", "SET_LAYER",
    # keys and labels
    "SET_KEY 0 5 241 F14", "SET_KEY 0 5 241 n/", "SET_KEY 0 5 98", "SET_KEY 0 5 98 A@", "SET_KEY 0 5 98 ABCDE",
    'SET_KEY 0 5 98 A"', "SET_KEY 0 5 137 X", "SET_KEY 3 0 98", "SET_KEY 0 16 98", "SET_KEY 0 5 256", "SET_KEY 0 5",
    "SET_BOOT_OUTPUT 1", "SET_BOOT_OUTPUT 0", "SET_BOOT_OUTPUT x",
    # output gating
    "SET_HID 1", "SET_HID 1 FORCE", "HID 0", "SET_HID 1 NOPE", "OUTPUT 0",
    # persistence
    "SAVE", "GET_CONFIG", "SET_ACTUATION 2.00", "REVERT", "GET_CONFIG", "SAVE", "SAVE",
    "RESET", "GET_CONFIG", "RESET NOPE", "RESET ALL", "STATUS",
    # calibration commands without a run
    "CAL STATUS", "CAL FINISH", "CAL CANCEL", "CAL NOPE", "CALIBRATE",
    # telemetry subscription (the frames themselves are events and not compared here)
    "STREAM 1", "STREAM 1 99", "STREAM 1 20", "STREAM 0", "STREAM x",
    # simulation and diagnostics
    "SIM 0 2.00", "SIM 0 9.00", "SIM 0 OFF", "SIM OFF", "SIM 16 1.00", "SIM NOPE",
    "TIMING", "TIMING RESET", "TIMING NOPE", "SCAN_RATE", "RAW 3", "RAW 16",
    "ANIM 2", "ANIM 9", "ANIM", "FULLSCREEN 1", "FULLSCREEN 0", "SCREENSAVER", "WAKE",
    "OLED_TEST", "OLED_SCAN",   # deferred to core 1 on the firmware; the host stub serves at once
    # framing and ids
    "NOPE", "@bad!id INFO", "@x1", "@" + "a" * 13 + " INFO", "SET_KEY 0 0 98 " + "X" * 170, "@id-_9 PING",
]
# Every key code once: the assignable-code rule must agree byte for byte.
SCRIPT += [f"SET_KEY 0 0 {c}" for c in range(256)] + ["RESET"]

# Human text and time-dependent fields. "delivery" follows the USB host's report acknowledgements,
# which the fake does not model (tests/test_keyboard_output.py covers it on the firmware).
VOLATILE = {"msg", "uptime_ms", "t", "elapsed_ms", "duration_ms", "build", "build_date", "delivery"}
SHAPE_ONLY = {"TIMING", "SCAN_RATE"}   # counters that depend on how long each side ran


def _strip(v):
    if isinstance(v, dict):
        return {k: _strip(x) for k, x in v.items() if k not in VOLATILE}
    if isinstance(v, list):
        return [_strip(x) for x in v]
    return v


def _shape(v):
    if isinstance(v, dict):
        return {k: _shape(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_shape(x) for x in v[:1]]
    return type(v).__name__


def _replies(lines):
    out = []
    for line in lines:
        line = line.strip()
        if not line.startswith("{"):
            continue
        obj = json.loads(line)
        if "status" in obj:
            out.append(obj)
    return out


def _fake_page() -> Path:
    fake = chrome_host.file_url(CONFIGURATOR / "js" / "fake_device.js")
    body = f"""<!DOCTYPE html><meta charset="utf-8"><body><script src="{fake}"></script><script>
const LINES = {json.dumps(SCRIPT)};
const dev = new DriftPad.fake.FakeDevice({{ calibration: "missing" }});
const out = [];
for (const line of LINES) {{
    const n = dev.sent.length;
    dev.receive(line + "\\n");
    out.push(dev.sent.slice(n));
}}
dev.destroy();
const pre = document.createElement("pre");
pre.id = "results";
pre.textContent = JSON.stringify({{ lines: out }});
document.body.appendChild(pre);
</script>"""
    out_dir = hb.CACHE_DIR / "contract"
    out_dir.mkdir(parents=True, exist_ok=True)
    page = out_dir / "fake_contract.html"
    page.write_text(body, encoding="utf-8")
    return page


class TestFakeDeviceMatchesFirmware(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        chrome_host.require_browser()
        lib = dh.current_device()
        lib.reset_flash()
        for k in range(16):
            lib.set_travel(k, 0.0)             # every key at rest, like an untouched pad
        dev = dh.Device(lib)
        cls.firmware = [_replies(dev.exchange(line)) for line in SCRIPT]
        cls.fake = [_replies(lines) for lines in chrome_host.run_page(chrome_host.file_url(_fake_page()))["lines"]]

    def test_every_line_gets_exactly_one_reply_from_both(self):
        for i, line in enumerate(SCRIPT):
            with self.subTest(line=line):
                self.assertEqual(len(self.firmware[i]), 1, f"firmware replies: {self.firmware[i]}")
                self.assertEqual(len(self.fake[i]), 1, f"fake replies: {self.fake[i]}")

    def test_replies_match(self):
        mismatches = []
        for i, line in enumerate(SCRIPT):
            if len(self.firmware[i]) != 1 or len(self.fake[i]) != 1:
                continue   # reported by the test above
            fw, fk = self.firmware[i][0], self.fake[i][0]
            verb = fw.get("cmd", "")
            a, b = (_shape(fw), _shape(fk)) if verb in SHAPE_ONLY else (_strip(fw), _strip(fk))
            if a != b:
                mismatches.append(f"{line}\n  firmware: {json.dumps(a, sort_keys=True)}\n  fake:     {json.dumps(b, sort_keys=True)}")
        compared = sum(1 for i in range(len(SCRIPT)) if len(self.firmware[i]) == 1 and len(self.fake[i]) == 1)
        INNER_RESULTS["request lines compared, fake vs firmware"] = {"passed": compared - len(mismatches), "failed": len(mismatches)}
        self.assertEqual(mismatches, [], f"{len(mismatches)} replies differ:\n" + "\n".join(mismatches))

    def test_the_script_covers_every_command_and_error_code(self):
        """Guards the value of this test: the sequence must exercise the whole command table and
        most error codes, so a new command or code without contract coverage is noticed."""
        seen_cmds = {r[0].get("cmd") for r in self.firmware if r}
        table = {"PING", "INFO", "GET_CONFIG", "STATUS", "STREAM", "SET_ACTUATION", "SET_RT_SENS", "SET_RT_ENABLE",
                 "SET_LAYER", "SET_KEY", "SET_HID", "SAVE", "REVERT", "RESET", "CALIBRATE", "CAL", "SET_BOOT_OUTPUT",
                 "SIM", "SCAN_RATE", "TIMING", "RAW", "FULLSCREEN", "SCREENSAVER", "ANIM", "WAKE",
                 "OLED_TEST", "OLED_SCAN"}
        self.assertEqual(table - seen_cmds, set())
        codes = {r[0].get("code") for r in self.firmware if r and r[0].get("status") == "error"}
        expected = {"unknown_command", "bad_request", "bad_arguments", "bad_number", "out_of_range", "invalid_label",
                    "invalid_code", "not_allowed", "calibration_required", "line_too_long"}
        self.assertEqual(expected - codes, set())


if __name__ == "__main__":
    unittest.main(verbosity=2)
