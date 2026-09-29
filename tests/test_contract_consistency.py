"""
test_contract_consistency.py - One set of facts across firmware, configurator and fake device.

Scope: Python only (reads source files; no compiler, no browser). The firmware headers are the
source of truth; every copy elsewhere must agree:
  - settings limits and protocol bounds (settings_limits.h) in contract.js and fake_device.js
  - INFO features (commands.cpp) in contract.js and fake_device.js
  - error codes (protocol.h) in contract.js
  - factory keymaps (config.cpp) in keycodes.js and fake_device.js
  - the firmware version (build_info.h) in fake_device.js
and the configurator's pages load what they should. tests/test_configurator_contract.py compares
live replies; this module catches drift even where no browser or compiler is available.
"""

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FW_INC = ROOT / "firmware" / "include"
FW_SRC = ROOT / "firmware" / "src"
CFG = ROOT / "configurator"


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def cpp_constexprs(text: str) -> dict:
    return {m.group(1): int(m.group(2), 0) for m in re.finditer(r"constexpr\s+\w+\s+(\w+)\s*=\s*(0x[0-9A-Fa-f]+|\d+)\s*;", text)}


def js_block(text: str, start: str) -> str:
    """The bracketed literal that follows `start` (balanced { } or [ ])."""
    i = text.index(start) + len(start)
    while text[i] not in "[{":
        i += 1
    open_ch = text[i]
    close_ch = "]" if open_ch == "[" else "}"
    depth = 0
    for j in range(i, len(text)):
        if text[j] == open_ch:
            depth += 1
        elif text[j] == close_ch:
            depth -= 1
            if depth == 0:
                return text[i:j + 1]
    raise AssertionError(f"unbalanced literal after {start}")


def js_strings(block: str) -> list:
    return re.findall(r'"([^"\\]*)"', block)


def js_keymap_rows(block: str) -> list:
    """[[code, "label"], ...] pairs in order, codes as ints (decimal or hex)."""
    return [(int(c, 0), l) for c, l in re.findall(r'\[\s*(0x[0-9A-Fa-f]+|\d+)\s*,\s*"([^"]*)"\s*\]', block)]


class TestLimits(unittest.TestCase):

    def test_contract_js_limits_equal_settings_limits_h(self):
        header = cpp_constexprs(read(FW_INC / "settings_limits.h"))
        block = js_block(read(CFG / "js" / "contract.js"), "const LIMITS_CMM = Object.freeze(")
        js = {k: int(v) for k, v in re.findall(r"(\w+):\s*(\d+)", block)}
        self.assertEqual(js, header, "contract.js LIMITS_CMM must list exactly the settings_limits.h constants")

    def test_fake_device_limits_equal_settings_limits_h(self):
        h = cpp_constexprs(read(FW_INC / "settings_limits.h"))
        fake = read(CFG / "js" / "fake_device.js")
        act = re.search(r"const ACT = \{ min: (\d+), max: (\d+), def: (\d+) \}", fake)
        rt = re.search(r"const RT = \{ min: (\d+), max: (\d+), def: (\d+) \}", fake)
        self.assertEqual(tuple(map(int, act.groups())), (h["ACTUATION_MIN_CMM"], h["ACTUATION_MAX_CMM"], h["ACTUATION_DEFAULT_CMM"]))
        self.assertEqual(tuple(map(int, rt.groups())), (h["RT_SENS_MIN_CMM"], h["RT_SENS_MAX_CMM"], h["RT_SENS_DEFAULT_CMM"]))
        for name, fw in (("LINE_MAX", "LINE_MAX_LEN"), ("STREAM_HZ_DEFAULT", "STREAM_HZ_DEFAULT"),
                         ("STREAM_HZ_MAX", "STREAM_HZ_MAX"), ("UI_STEP", "UI_STEP_CMM")):
            m = re.search(rf"const {name} = (\d+);", fake)
            self.assertIsNotNone(m, name)
            self.assertEqual(int(m.group(1)), h[fw], name)


class TestProtocolFacts(unittest.TestCase):

    def firmware_features(self):
        src = read(FW_SRC / "commands.cpp")
        return js_strings(js_block(src, "static const char* const FEATURES[] ="))

    def test_features_agree(self):
        fw = self.firmware_features()
        self.assertGreaterEqual(len(fw), 11)
        contract = js_strings(js_block(read(CFG / "js" / "contract.js"), "const FEATURES = Object.freeze("))
        fake = js_strings(js_block(read(CFG / "js" / "fake_device.js"), "const FEATURES ="))
        self.assertEqual(contract, fw)
        self.assertEqual(fake, fw)

    def test_every_firmware_error_code_has_a_plain_language_explanation(self):
        fw = re.findall(r'inline constexpr const char\* \w+\s*=\s*"([a-z_]+)";', read(FW_INC / "protocol.h"))
        count = int(re.search(r"constexpr uint8_t COUNT = (\d+);", read(FW_INC / "protocol.h")).group(1))
        self.assertEqual(len(fw), count, "protocol.h err:: list and COUNT disagree")
        block = js_block(read(CFG / "js" / "contract.js"), "const ERROR_CODES = Object.freeze(")
        js = re.findall(r"^\s*(\w+):", block, re.M)
        self.assertEqual(sorted(js), sorted(fw))

    def test_firmware_version_is_the_fakes(self):
        fw = re.search(r'^#define DRIFTPAD_FW_VERSION "([^"]+)"', read(FW_INC / "build_info.h"), re.M).group(1)
        fake = re.search(r'const FW_VERSION = "([^"]+)";', read(CFG / "js" / "fake_device.js")).group(1)
        self.assertEqual(fake, fw)


class TestFactoryKeymaps(unittest.TestCase):

    def firmware_layers(self):
        src = read(FW_SRC / "config.cpp")
        kc = cpp_constexprs(src)
        layers = []
        for name in ("l0", "l1", "l2"):
            block = js_block(src, f"const LayerKey {name}[NUM_KEYS] =")
            keys = []
            for sym, label in re.findall(r"\{\s*(KC_\w+|'.')\s*,\s*\"([^\"]*)\"\s*\}", block):
                keys.append((ord(sym[1]) if sym.startswith("'") else kc[sym], label))
            self.assertEqual(len(keys), 16, name)
            layers.append(keys)
        return layers

    def test_keycodes_js_defaults_equal_config_cpp(self):
        rows = js_keymap_rows(js_block(read(CFG / "js" / "keycodes.js"), "const DEFAULT_KEYMAPS_ROWS ="))
        self.assertEqual([rows[i * 16:(i + 1) * 16] for i in range(3)], self.firmware_layers())

    def test_fake_device_defaults_equal_config_cpp(self):
        rows = js_keymap_rows(js_block(read(CFG / "js" / "fake_device.js"), "const DEFAULT_ROWS ="))
        self.assertEqual([rows[i * 16:(i + 1) * 16] for i in range(3)], self.firmware_layers())


class TestConfiguratorPages(unittest.TestCase):

    def scripts(self, page: Path) -> list:
        return re.findall(r'<script src="([^"]+)"></script>', read(page))

    def test_index_loads_only_local_files_that_exist(self):
        html = read(CFG / "index.html")
        for ref in re.findall(r'(?:src|href)="([^"#]+)"', html):
            self.assertTrue((CFG / ref).is_file(), f"index.html references missing {ref}")

    def test_configurator_needs_no_network(self):
        """Works offline and from the file system: no CDN script, stylesheet, font or import."""
        q = "[\"']"
        remote = re.compile(rf"(?:src|href)\s*=\s*{q}(?:https?:)?//|url\(\s*{q}?(?:https?:)?//|@import\s+{q}?(?:https?:)?//"
                            rf"|[^\w.]fetch\(\s*{q}https?:", re.I)
        files = [CFG / "index.html", CFG / "keymap.html", *sorted((CFG / "css").glob("*.css")), *sorted((CFG / "js").glob("*.js"))]
        self.assertGreater(len(files), 10)
        for f in files:
            m = remote.search(read(f))
            self.assertIsNone(m, f"{f.relative_to(ROOT)} loads from the network: {m and m.group(0)}")

    def test_test_page_loads_the_same_modules_in_the_same_order(self):
        app = [s for s in self.scripts(CFG / "index.html") if s != "js/app.js"]
        tests = [s.replace("../", "") for s in self.scripts(CFG / "tests" / "run.html") if s.startswith("../js/")]
        self.assertEqual(tests, app)

    def test_old_keymap_editor_url_redirects_to_the_keys_page(self):
        html = read(CFG / "keymap.html")
        self.assertIn('http-equiv="refresh" content="0; url=index.html#keys"', html)
        self.assertIn('href="index.html#keys"', html)
        self.assertNotIn("<script", html)


DOC_FILES = [ROOT / "README.md", ROOT / "CHANGELOG.md", ROOT / "tools" / "README.md",
             *sorted((ROOT / "docs").glob("*.md"))]


def firmware_commands() -> list:
    block = js_block(read(FW_SRC / "commands.cpp"), "const proto::CommandDef TABLE[] =")
    return re.findall(r'\{\s*"([A-Z_]+)",', block)


class TestDocs(unittest.TestCase):
    """The documents say what the code does, and point at files that exist."""

    def test_every_relative_link_resolves(self):
        broken = []
        for doc in DOC_FILES:
            text = read(doc)
            text = re.sub(r"```.*?```", "", text, flags=re.S)          # code blocks are not links
            for target in re.findall(r"\]\(([^)\s]+)\)", text):
                if re.match(r"^[a-z]+:", target) or target.startswith("#"):
                    continue                                            # URLs and in-page anchors
                path = (doc.parent / target.split("#", 1)[0]).resolve()
                if not path.exists():
                    broken.append(f"{doc.relative_to(ROOT)} -> {target}")
        self.assertEqual(broken, [])

    def test_the_protocol_reference_covers_the_firmware(self):
        text = read(ROOT / "docs" / "serial-protocol.md")
        missing = [v for v in firmware_commands() if not re.search(rf"`{v}\b", text)]
        self.assertEqual(missing, [], "commands in the firmware table but not in docs/serial-protocol.md")
        codes = re.findall(r'inline constexpr const char\* \w+\s*=\s*"([a-z_]+)";', read(FW_INC / "protocol.h"))
        self.assertEqual([c for c in codes if f"`{c}`" not in text], [], "error codes missing from the reference")
        h = cpp_constexprs(read(FW_INC / "settings_limits.h"))
        for name in ("ACTUATION_MIN_CMM", "ACTUATION_MAX_CMM", "ACTUATION_DEFAULT_CMM",
                     "RT_SENS_MIN_CMM", "RT_SENS_MAX_CMM", "RT_SENS_DEFAULT_CMM"):
            mm = f"{h[name] / 100:.2f}"
            self.assertIn(mm, text, f"{name} ({mm} mm) not stated in docs/serial-protocol.md")
        for name in ("LINE_MAX_LEN", "REQUEST_ID_MAX_LEN", "STREAM_HZ_MAX"):
            self.assertRegex(text, rf"\b{h[name]}\b", f"{name} ({h[name]}) not stated in docs/serial-protocol.md")

    def test_the_testing_guide_names_every_test_module(self):
        text = read(ROOT / "docs" / "testing.md")
        modules = sorted(p.stem for p in (ROOT / "tests").glob("test_*.py"))
        self.assertEqual([m for m in modules if m not in text], [])

    def test_the_readme_indexes_every_document(self):
        text = read(ROOT / "README.md")
        self.assertEqual([d.name for d in sorted((ROOT / "docs").glob("*.md")) if d.name not in text], [])

    def test_the_changelog_has_the_current_version(self):
        version = re.search(r'^#define DRIFTPAD_FW_VERSION "([^"]+)"', read(FW_INC / "build_info.h"), re.M).group(1)
        self.assertRegex(read(ROOT / "CHANGELOG.md"), rf"(?m)^## \[?{re.escape(version)}\]?(\s|$)")

    def test_no_reference_to_retired_documents(self):
        retired = ("protocol-v2-draft.md",)
        hits = []
        for p in [*DOC_FILES, *sorted(FW_SRC.glob("*.cpp")), *sorted(FW_INC.glob("*.h")),
                  *sorted((CFG / "js").glob("*.js")), *sorted((ROOT / "tests").glob("*.py")),
                  *sorted((ROOT / "tools").glob("*.py"))]:
            for r in retired:
                if r in read(p) and p.name != "test_contract_consistency.py":
                    hits.append(f"{p.relative_to(ROOT)} mentions {r}")
        self.assertEqual(hits, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
