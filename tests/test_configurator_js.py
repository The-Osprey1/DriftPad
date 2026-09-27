"""
test_configurator_js.py - The configurator's JavaScript, run in headless Chrome.

Scope: headless browser. Runs the REAL configurator modules and app (configurator/js/*.js,
configurator/index.html) against a fake WebSerial port and a fake DriftPad that speaks protocol v2
(configurator/js/fake_device.js, kept honest by tests/test_configurator_contract.py), and reads the
results written by configurator/tests/harness.js.

Defect reproduction: the reviewed defects are also run against the OLD pages (keymap.html and
index.html of commit e2031e2) with a fake v1 device (configurator/tests/v1_fake.js); each must be
present there. Skips in a shallow clone without that commit.
"""

import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import chrome_host
import host_build as hb

CONFIGURATOR = TESTS_DIR.parent / "configurator"

# Counts from inside the browser (run_all_tests.py reports them next to the Python test counts):
# one Python test runs many browser tests, and each old-page scenario is a subtest.
INNER_RESULTS = {}
PREFIX_SCENARIOS = {
    "keymap.html": ["keymap_edit_during_write", "keymap_write_rejected", "keymap_disconnect_teardown",
                    "keymap_label_rule", "keymap_load_is_stale", "keymap_no_telemetry_request",
                    "keymap_stray_reply_accepted", "keymap_unidentified_device"],
    "index.html": ["index_optimistic_setting", "index_layer_view_writes", "index_unidentified_device"],
}


def _prefix_page(name: str) -> Path:
    root = hb.revision_files(hb.PREFIX_REVISION, [f"configurator/{name}"])
    src = (root / "configurator" / name).read_text(encoding="utf-8")
    inject = "".join(f'<script src="{chrome_host.file_url(CONFIGURATOR / "tests" / s)}"></script>'
                     for s in ("harness.js", "v1_fake.js", "prefix_defects.js"))
    out = root / "configurator" / f"under_test_{name}"
    out.write_text(src.replace("</body>", inject + "</body>"), encoding="utf-8")
    return out


class TestPreFixConfiguratorDefects(unittest.TestCase):
    """Each reviewed configurator defect, on the pre-fix pages (e2031e2), is present."""

    @classmethod
    def setUpClass(cls):
        chrome_host.require_browser()

    def test_every_reviewed_defect_is_present_in_the_old_pages(self):
        for page, scenarios in PREFIX_SCENARIOS.items():
            path = _prefix_page(page)
            for scenario in scenarios:
                with self.subTest(page=page, scenario=scenario):
                    r = chrome_host.run_page(chrome_host.file_url(path, fragment=scenario), budget_ms=20000)
                    self.assertNotIn("error", r, r.get("error"))
                    reproduced = bool(r.get("defect"))
                    rec = INNER_RESULTS.setdefault("old-page defect reproductions (e2031e2)", {"passed": 0, "failed": 0})
                    rec["passed" if reproduced else "failed"] += 1
                    self.assertTrue(reproduced, f"{scenario} does not reproduce on the old page: {r.get('detail')}")


def _app_page() -> Path:
    """A copy of the shipped index.html with the harness and app_tests.js appended. A <base> makes
    every relative URL (css/, js/) resolve to the real configurator directory, so the page under
    test is the shipped markup, styles and scripts."""
    src = (CONFIGURATOR / "index.html").read_text(encoding="utf-8")
    base = chrome_host.file_url(CONFIGURATOR) + "/"
    assert src.count("<head>") == 1 and src.count("</body>") == 1
    inject = "".join(f'<script src="tests/{s}"></script>' for s in ("harness.js", "app_tests.js"))
    page = src.replace("<head>", f'<head><base href="{base}">').replace("</body>", inject + "</body>")
    out_dir = hb.CACHE_DIR / "configurator_app"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "index_under_test.html"
    out.write_text(page, encoding="utf-8")
    return out


class TestConfiguratorJs(unittest.TestCase):
    """The real modules (run.html) and the real page (index.html) against the fake device."""

    @classmethod
    def setUpClass(cls):
        chrome_host.require_browser()

    def _assert_all_pass(self, r, label):
        INNER_RESULTS[label] = {"passed": r["passed"], "failed": r["failed"], "uncaught_errors": len(r["errors"])}
        failed = [t for t in r["tests"] if not t["ok"]]
        self.assertEqual(r["errors"], [], "uncaught errors in the page")
        self.assertGreater(r["passed"], 0)
        self.assertEqual(failed, [], "\n\n".join(f"{t['name']}:\n{t['error']}" for t in failed))

    def test_modules(self):
        """contract, keycodes, protocol, transport, device session, sync, drafts and backups."""
        self._assert_all_pass(chrome_host.run_page(chrome_host.file_url(CONFIGURATOR / "tests" / "run.html"),
                                                   budget_ms=600000), "configurator module tests (run.html)")

    def test_app_page(self):
        """index.html + app.js in simulated-device mode: what the user sees and can do."""
        self._assert_all_pass(chrome_host.run_page(chrome_host.file_url(_app_page(), query="simulate=1", fragment="keys"),
                                                   budget_ms=600000), "configurator page tests (index.html)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
