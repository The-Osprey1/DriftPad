"""Regression coverage for Chrome discovery, sandbox opt-in and process errors."""

import unittest
import sys
from pathlib import Path
from unittest.mock import patch

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import chrome_host


class TestBrowserDiscovery(unittest.TestCase):
    SCOPE = "host tooling with fakes"

    def test_environment_overrides_include_chrome_bin_and_edge_install(self):
        existing = {"C:/custom/chrome": True, "C:/PF/Microsoft/Edge/Application/msedge.exe": True}
        env = {"CHROME_BIN": "C:/custom/chrome", "ProgramFiles": "C:/PF"}
        exists = lambda path: existing.get(path.replace("\\", "/"), False)
        self.assertEqual(chrome_host.find_browser(env=env, which=lambda _: None, exists=exists),
                         "C:/custom/chrome")
        edge = chrome_host.find_browser(env={"ProgramFiles": "C:/PF"},
                                        which=lambda _: None, exists=exists)
        self.assertEqual(edge.replace("\\", "/"), "C:/PF/Microsoft/Edge/Application/msedge.exe")

    def test_no_sandbox_requires_explicit_truthy_opt_in(self):
        for value, expected in (("", False), ("0", False), ("false", False), ("yes", True),
                                ("ON", True)):
            with self.subTest(value=value), patch.dict("os.environ", {"DRIFTPAD_CHROME_NO_SANDBOX": value}):
                self.assertEqual(chrome_host.no_sandbox_requested(), expected)

    def test_page_runner_passes_only_explicit_sandbox_override(self):
        fake = type("CompletedProcess", (), {"returncode": 0, "stdout": '<pre id="results">{}</pre>',
                                              "stderr": ""})()
        for value, has_no_sandbox in (("0", False), ("1", True)):
            with self.subTest(value=value), \
                    patch.dict("os.environ", {"DRIFTPAD_CHROME_NO_SANDBOX": value}), \
                    patch.object(chrome_host, "require_browser", return_value="chrome"), \
                    patch.object(chrome_host.subprocess, "run", return_value=fake) as run:
                chrome_host.run_page("file:///test.html")
                self.assertEqual("--no-sandbox" in run.call_args.args[0], has_no_sandbox)

    def test_nonzero_browser_exit_fails_even_when_results_dom_exists(self):
        fake = type("CompletedProcess", (), {"returncode": 1, "stdout": '<pre id="results">{}</pre>',
                                              "stderr": "zygote fatal"})()
        with (patch.object(chrome_host, "require_browser", return_value="chrome"),
              patch.object(chrome_host.subprocess, "run", return_value=fake) as run):
            with self.assertRaisesRegex(AssertionError, "(?s)browser exited 1.*zygote fatal"):
                chrome_host.run_page("file:///test.html")


if __name__ == "__main__":
    unittest.main(verbosity=2)
