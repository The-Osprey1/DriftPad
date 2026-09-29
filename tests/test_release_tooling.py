"""
test_release_tooling.py - check_toolchain, timing_capture, save_stress, acceptance_record and
qualify_release, against generated PlatformIO trees, fake pads and fake subprocesses.

Scope: host tooling with fakes. Nothing is installed, flashed or published; no real port is opened.
The real lock file (firmware/toolchain.lock.json), platformio.ini and hardware acceptance procedure
are the inputs where it matters, so drift between them and the tools shows up here.
"""

import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

TESTS_DIR = Path(__file__).resolve().parent
REPO = TESTS_DIR.parent
TOOLS = REPO / "tools"
for _p in (TESTS_DIR, TOOLS):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import acceptance_record as ar      # noqa: E402
import check_toolchain as ct        # noqa: E402
import driftpad_serial as ds        # noqa: E402
import qualify_release as qr        # noqa: E402
import save_stress                  # noqa: E402
import timing_capture as tc         # noqa: E402
from firmware_images import make_build   # noqa: E402

LOCK = json.loads((REPO / "firmware" / "toolchain.lock.json").read_text(encoding="utf-8"))
SYSTYPE = "windows_amd64"


# ============================================================================ check_toolchain
def fake_pio_tree(root: Path, lock=LOCK, mutate=None):
    """A PIO home and firmware dir that match `lock` exactly; `mutate(paths)` changes one thing."""
    pio = root / "pio"
    platforms, packages = pio / "platforms", pio / "packages"
    plat = lock["platform"]

    def git_checkout(d: Path, commit: str, url: str):
        (d / ".git").mkdir(parents=True)
        (d / ".git" / "HEAD").write_text(commit + "\n")
        (d / ".git" / "config").write_text(f'[remote "origin"]\n\turl = {url}\n')

    pdir = platforms / plat["name"]
    git_checkout(pdir, plat["commit"], plat["repo"])
    (pdir / "platform.json").write_text(json.dumps({"version": plat["version"]}))

    fw = lock["framework"]
    fdir = packages / fw["package"]
    git_checkout(fdir, fw["commit"], fw["repo"])
    (fdir / "package.json").write_text(json.dumps({"version": fw["package_version"]}))
    for lib in lock.get("framework_libraries", []):
        d = fdir / "libraries" / lib["dir"]
        d.mkdir(parents=True)
        (d / "library.properties").write_text(f"name={lib['name']}\nversion={lib['version']}\n")

    tchain = lock["toolchain"]
    for pkg in [tchain] + lock.get("tools", []):
        d = packages / pkg["package"]
        d.mkdir(parents=True)
        uri = (pkg.get("archives") or {}).get(SYSTYPE)
        (d / ".piopm").write_text(json.dumps({"version": pkg["version"], "spec": {"uri": uri} if uri else {}}))
    gcc = packages / tchain["package"] / "bin" / ("arm-none-eabi-gcc" + (".exe" if os.name == "nt" else ""))
    gcc.parent.mkdir(parents=True)
    gcc.write_text("")

    firmware = root / "firmware"
    firmware.mkdir()
    shutil.copy(REPO / "firmware" / "platformio.ini", firmware / "platformio.ini")
    for lib in lock["libraries"]:
        d = firmware / ".pio" / "libdeps" / lock.get("env", "pico") / lib["name"]
        d.mkdir(parents=True)
        (d / ".piopm").write_text(json.dumps({"name": lib["name"], "version": lib["version"],
                                              "spec": {"owner": lib["owner"]}}))
    paths = SimpleNamespace(pio=pio, platforms=platforms, packages=packages, platform=pdir, framework=fdir,
                            firmware=firmware)
    if mutate:
        mutate(paths)
    return paths


def fake_run(cmd, **kw):
    text = ""
    if "--version" in cmd:
        text = f"arm-none-eabi-gcc (GCC) {LOCK['toolchain']['gcc']}\n"
    elif "describe" in cmd:
        text = LOCK["framework"]["describe"] + "\n"
    return SimpleNamespace(returncode=0, stdout=text, stderr="")


class TestCheckToolchain(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def rows(self, mutate=None, pio_version=None, require_libs=True):
        p = fake_pio_tree(self.root, mutate=mutate)
        dirs = {"core": p.pio, "platforms": p.platforms, "packages": p.packages}
        return ct.check(LOCK, dirs, p.firmware, pio_version or LOCK["platformio_core"]["version"], require_libs,
                        SYSTYPE, run=fake_run)

    def failing(self, rows):
        return [(r.component, r.status) for r in rows if r.status in ct.FAILING]

    def test_a_tree_that_matches_the_lock_passes(self):
        rows = self.rows()
        self.assertEqual(self.failing(rows), [])
        self.assertGreater(len(rows), 20)

    def test_each_kind_of_drift_is_caught(self):
        def other_commit(p):
            (p.platform / ".git" / "HEAD").write_text("f" * 40)

        def second_platform(p):
            shutil.copytree(p.platform, p.platforms / (LOCK["platform"]["name"] + "@1.0.0"))

        def library_version(p):
            name = LOCK["libraries"][0]["name"]
            f = p.firmware / ".pio" / "libdeps" / "pico" / name / ".piopm"
            meta = json.loads(f.read_text())
            meta["version"] = "0.0.1"
            f.write_text(json.dumps(meta))

        def unpinned_lib_dep(p):
            ini = p.firmware / "platformio.ini"
            ini.write_text(re.sub(r"(Adafruit SSD1306) @ [\d.]+", r"\1 @ ^2.5.7", ini.read_text()))

        def unknown_framework_lib(p):   # the "Keyboard.pio" typo that once reached platformio.ini
            ini = p.firmware / "platformio.ini"
            ini.write_text(re.sub(r"(?m)^(\s+)Keyboard$", r"\1Keyboard.pio", ini.read_text()))

        def toolchain_version(p):
            f = p.packages / LOCK["toolchain"]["package"] / ".piopm"
            f.write_text(json.dumps({"version": "5.0.0", "spec": {}}))

        def foreign_platform_repo(p):
            ini = p.firmware / "platformio.ini"
            ini.write_text(ini.read_text().replace(LOCK["platform"]["repo"], "https://example.com/other.git"))

        for mutate, expect in ((other_commit, "commit"), (second_platform, "installs"),
                               (library_version, "library adafruit"), (unpinned_lib_dep, "lib_deps Adafruit SSD1306"),
                               (unknown_framework_lib, "lib_deps Keyboard.pio"),
                               (toolchain_version, LOCK["toolchain"]["package"]),
                               (foreign_platform_repo, "platformio.ini platform")):
            with self.subTest(mutate=mutate.__name__):
                shutil.rmtree(self.root, ignore_errors=True)
                self.root.mkdir(exist_ok=True)
                failing = self.failing(self.rows(mutate))
                self.assertTrue(any(expect in c for c, _ in failing), f"{expect!r} not flagged: {failing}")

    def test_wrong_platformio_core_is_caught(self):
        self.assertIn(("PlatformIO Core", "MISMATCH"), self.failing(self.rows(pio_version="6.1.0")))

    def test_libraries_not_installed_yet_are_pending_unless_required(self):
        def no_libs(p):
            shutil.rmtree(p.firmware / ".pio")
        rows = self.rows(no_libs, require_libs=False)
        self.assertEqual(self.failing(rows), [])
        self.assertTrue(any(r.status == ct.PENDING for r in rows))
        shutil.rmtree(self.root, ignore_errors=True)
        self.root.mkdir(exist_ok=True)
        self.assertTrue(self.failing(self.rows(no_libs, require_libs=True)))

    def test_pinned_project_conf(self):
        ini = (REPO / "firmware" / "platformio.ini").read_text(encoding="utf-8")
        pinned = ct.pinned_project_conf(ini, LOCK)
        self.assertIn(f"platform = {LOCK['platform']['repo']}#{LOCK['platform']['commit']}", pinned)
        self.assertEqual(pinned.replace(f"#{LOCK['platform']['commit']}", ""), ini, "only the platform line changes")
        with self.assertRaises(ValueError):
            ct.pinned_project_conf(ini.replace(LOCK["platform"]["repo"], "https://example.com/x.git"), LOCK)
        with self.assertRaises(ValueError):
            ct.pinned_project_conf(ini.replace(LOCK["platform"]["repo"], LOCK["platform"]["repo"] + "#deadbeef"), LOCK)

    def test_the_repository_ini_agrees_with_the_lock(self):
        rows = ct.check_project_ini(LOCK, REPO / "firmware" / "platformio.ini",
                                    fake_pio_tree(self.root).framework)
        self.assertEqual(self.failing(rows), [])


# ============================================================================ fake pad for the tools
class ScriptedLink:
    """Answers '@id VERB ...' lines through `handler(verb, args) -> dict fields | None (no reply)`."""

    def __init__(self, handler, fail_after=None):
        self.handler, self.out, self.sent = handler, [], []
        self.fail_after = fail_after

    def write(self, data):
        for line in data.decode().splitlines():
            if self.fail_after is not None and len(self.sent) >= self.fail_after:
                raise OSError("the device has been lost")
            self.sent.append(line)
            parts = line.split()
            rid = parts[0][1:] if parts[0].startswith("@") else None
            verb, args = (parts[1], parts[2:]) if rid else (parts[0], parts[1:])
            fields = self.handler(verb, args)
            if fields is not None:
                reply = {"status": "ok", "id": rid, "cmd": verb}
                reply.update(fields)
                self.out.append((json.dumps(reply) + "\n").encode())

    def readline(self):
        return self.out.pop(0) if self.out else b""

    def reset_input_buffer(self):
        self.out.clear()

    def close(self):
        pass


def clock():
    t = [0.0]

    def now():
        t[0] += 0.01
        return t[0]
    return now


# ============================================================================ timing_capture
QUIET = {"period_us": 1000, "max_gap_us": 1080, "missed_deadlines": 0, "save_count": 0, "save_max_us": 0,
         "gap_hist_us": {"le_1100": 1000, "le_1500": 0, "le_2000": 0, "le_5000": 0, "le_10000": 0,
                         "le_50000": 0, "gt_50000": 0}, "tx_replies_rejected": 0}


class TestTimingCapture(unittest.TestCase):

    def test_verdicts(self):
        def with_(**kw):
            d = json.loads(json.dumps(QUIET))
            for k, v in kw.items():
                if k in d["gap_hist_us"]:
                    d["gap_hist_us"][k] = v
                else:
                    d[k] = v
            return d
        self.assertTrue(tc.judge(QUIET, 2000, False)["pass"])
        self.assertFalse(tc.judge(with_(max_gap_us=2400), 2000, False)["pass"])
        self.assertFalse(tc.judge(with_(le_5000=1), 2000, False)["pass"], "one gap above 2 ms fails")
        saving = with_(save_count=3, save_max_us=48000, max_gap_us=48900, le_50000=3)
        self.assertFalse(tc.judge(saving, 2000, False)["pass"], "saves need --allow-save-gaps")
        self.assertTrue(tc.judge(saving, 2000, True)["pass"])
        self.assertFalse(tc.judge(with_(save_count=1, save_max_us=40000, max_gap_us=45000), 2000, True)["pass"],
                         "a gap longer than the save itself is not the save's")
        self.assertFalse(tc.judge(with_(tx_replies_rejected=1), 2000, False)["pass"])
        # The SAVE command's own parsing and reply come with the save (measured: save 23.1 ms, gap 24.8 ms)
        self.assertTrue(tc.judge(with_(save_count=10, save_max_us=23143, max_gap_us=24768, le_50000=9), 2000, True)["pass"])
        self.assertFalse(tc.judge(with_(save_count=10, save_max_us=23143, max_gap_us=25500, le_50000=9), 2000, True)["pass"])

    def test_capture_resets_then_samples(self):
        link = ScriptedLink(lambda verb, args: {"reset": True} if args == ["RESET"] else dict(QUIET, type="timing"))
        now = clock()
        slept = []
        result = tc.capture(ds.DeviceClient(link, now), seconds=1.0, interval=0.25,
                            sleep=lambda s: slept.append(s), clock=now)
        self.assertRegex(link.sent[0], r"^@\d+ TIMING RESET$")
        self.assertTrue(all(re.match(r"^@\d+ TIMING$", l) for l in link.sent[1:]))
        self.assertGreaterEqual(len(result["samples"]), 1)
        self.assertEqual(result["final"]["max_gap_us"], 1080)

    def test_the_default_capture_does_not_disturb_what_it_measures(self):
        # Answering TIMING costs the scan loop about 1.2 ms on the pad: every extra poll is a gap
        link = ScriptedLink(lambda verb, args: {"reset": True} if args == ["RESET"] else dict(QUIET, type="timing"))
        now = clock()
        tc.capture(ds.DeviceClient(link, now), seconds=60.0, interval=0,
                   sleep=lambda s: None, clock=now)
        self.assertEqual(len(link.sent), 2, "only the reset and the final read")

    def test_main_writes_a_record_with_the_verdict(self):
        info = {"type": "info", "device": "DriftPad", "protocol": 2, "fw": "2.1.0", "build": "b1", "hw": "V2"}

        def handler(verb, args):
            if verb == "INFO":
                return info
            return {"reset": True} if args == ["RESET"] else dict(QUIET, type="timing", max_gap_us=3000)
        port = ds.PortInfo("COM7", ds.RPI_VID, ds.DRIFTPAD_PID, "S1")
        with tempfile.TemporaryDirectory() as d:
            out_file = Path(d) / "t.json"
            code = tc.main(["--label", "idle", "--seconds", "0.1", "--interval", "0.05", "--out", str(out_file)],
                           list_ports=lambda: [port], opener=lambda dev: ScriptedLink(handler),
                           sleep=lambda s: None, clock=clock(), out=lambda s: None)
            record = json.loads(out_file.read_text())
        self.assertEqual(code, 1)
        self.assertEqual((record["schema"], record["label"], record["device"]["build"]), (tc.SCHEMA, "idle", "b1"))
        self.assertFalse(record["verdict"]["pass"])


# ============================================================================ save_stress
class PadState:
    def __init__(self):
        self.actuation, self.seq = 1.2, 0

    def handler(self, verb, args):
        if verb == "SET_ACTUATION":
            self.actuation = float(args[0])
            return {"actuation": self.actuation, "applied": True}
        if verb == "SAVE":
            self.seq += 1
            return {"persisted": True, "slot": "slot_a" if self.seq % 2 else "slot_b", "seq": self.seq}
        if verb == "GET_CONFIG":
            return {"type": "config", "actuation": self.actuation}
        if verb == "INFO":
            return {"type": "info", "settings": {"source": "slot_a", "seq": self.seq, "load_errors": []}}
        return {}


class TestSaveStress(unittest.TestCase):

    def test_saves_until_the_port_goes_away_and_verifies_after(self):
        pad = PadState()
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "s.log"
            lines = []
            link = ScriptedLink(pad.handler, fail_after=7)      # power cut before the 4th save completes
            last = save_stress.run_saves(ds.DeviceClient(link, clock()), 0, log, out=lines.append)
            # saves alternate 1.50, 2.50, 1.50; the cut hits the save of 2.50
            self.assertEqual((last["actuation"], last["seq"]), ("1.50", 3))
            self.assertIn("last confirmed save: actuation 1.50 mm", lines[-1])
            events = [json.loads(l)["event"] for l in log.read_text().splitlines()]
            self.assertEqual(events[-1], "saving", "the interrupted save is logged")
            # after power returns the pad may hold the last confirmed or the interrupted value
            for held, ok in ((2.5, True), (1.5, True), (1.2, False)):
                pad.actuation = held
                self.assertEqual(save_stress.verify(ds.DeviceClient(ScriptedLink(pad.handler), clock()), log,
                                                    out=lambda s: None), ok, held)


# ============================================================================ acceptance records
MANIFEST = {"build_id": "abc123def456", "fw_version": "2.1.0", "git_commit": "a" * 40}


class TestAcceptanceRecord(unittest.TestCase):

    def setUp(self):
        self.items = ar.doc_items()
        self.rec = ar.new_record(MANIFEST, "tester", self.items)

    def pass_all(self, rec, optional="n/a"):
        for i in rec["items"]:
            ar.set_result(rec, i["id"], "pass" if i["required"] else optional)

    def test_the_procedure_defines_unique_items_with_criteria(self):
        ids = [i["id"] for i in self.items]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertGreaterEqual(len(ids), 30)
        self.assertTrue(all(i["criterion"] for i in self.items))
        self.assertEqual(ids, sorted(ids), "items appear in order")

    def test_complete_only_when_every_required_item_passed_and_signed(self):
        ok, problems = ar.evaluate(self.rec, MANIFEST, self.items)
        self.assertFalse(ok)
        self.assertEqual(len([p for p in problems if "not run" in p]), len(self.items))
        self.pass_all(self.rec)
        with self.assertRaises(ValueError):
            ar.set_result(self.rec, "HW-01", "n/a")            # required items cannot be skipped
        self.assertEqual(ar.evaluate(self.rec, MANIFEST, self.items)[1], ["not signed off"])
        ar.sign(self.rec, "reviewer", self.items)
        self.assertEqual(ar.evaluate(self.rec, MANIFEST, self.items), (True, []))
        with self.assertRaises(ValueError):
            ar.set_result(self.rec, "HW-02", "fail")            # frozen after sign-off

    def test_failures_other_builds_and_changed_procedures_are_not_complete(self):
        self.pass_all(self.rec)
        ar.set_result(self.rec, "HW-20", "fail", "defaults after cut 7")
        with self.assertRaises(ValueError):
            ar.sign(self.rec, "reviewer", self.items)
        ar.set_result(self.rec, "HW-20", "pass")
        ar.sign(self.rec, "reviewer", self.items)
        self.assertFalse(ar.evaluate(self.rec, dict(MANIFEST, build_id="other"), self.items)[0])
        grown = self.items + [{"id": "HW-99", "title": "new", "required": True, "criterion": "x"}]
        ok, problems = ar.evaluate(self.rec, MANIFEST, grown)
        self.assertFalse(ok)
        self.assertIn("HW-99 is missing", problems[0])

    def test_invalid_duplicate_and_malformed_rows_fail_closed(self):
        self.pass_all(self.rec)
        self.rec["items"][0]["result"] = "unknown"
        ok, problems = ar.evaluate(self.rec, MANIFEST, self.items)
        self.assertFalse(ok)
        self.assertTrue(any("invalid result" in p for p in problems))
        self.pass_all(self.rec)
        self.rec["items"].append(dict(self.rec["items"][0]))
        ok, problems = ar.evaluate(self.rec, MANIFEST, self.items)
        self.assertFalse(ok)
        self.assertTrue(any("appears twice" in p for p in problems))
        self.assertEqual(ar.evaluate({"schema": ar.SCHEMA, "items": [None]}, items=self.items)[0], False)

    def test_manifest_match_covers_version_and_source_commit(self):
        self.pass_all(self.rec)
        ar.sign(self.rec, "reviewer", self.items)
        for changed in ({"fw_version": "2.2.0"}, {"git_commit": "b" * 40}):
            ok, problems = ar.evaluate(self.rec, dict(MANIFEST, **changed), self.items)
            self.assertFalse(ok, changed)
            self.assertTrue(any("does not match the manifest" in p for p in problems), problems)

    def test_empty_tester_and_signer_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "tester"):
            ar.new_record(MANIFEST, " ", self.items)
        self.pass_all(self.rec)
        with self.assertRaisesRegex(ValueError, "signer"):
            ar.sign(self.rec, " \t", self.items)

    def test_cli(self):
        with tempfile.TemporaryDirectory() as d:
            m = Path(d) / "build_manifest.json"
            m.write_text(json.dumps(MANIFEST))
            rec = Path(d) / "a.json"
            out = []
            self.assertEqual(ar.main(["new", "--manifest", str(m), "--tester", "t", "--out", str(rec)], out.append), 0)
            self.assertEqual(ar.main(["new", "--manifest", str(m), "--tester", "t", "--out", str(rec)], out.append), 2,
                             "never overwrites a record")
            self.assertEqual(ar.main(["set", str(rec), "HW-07", "pass", "--note", "ok"], out.append), 0)
            self.assertEqual(ar.main(["check", str(rec), "--manifest", str(m)], out.append), 1)
            self.assertEqual(ar.main(["sign", str(rec), "--by", "r"], out.append), 2, "cannot sign an open record")


# ============================================================================ qualify_release
class FakeRepo:
    """A repository skeleton plus a scripted `run` for git, check_toolchain and run_all_tests."""

    COMMIT = "b" * 40

    def __init__(self, root: Path, dirty=False, toolchain_ok=True, tests_ok=True, changelog=True):
        self.root = root
        (root / "firmware" / "include").mkdir(parents=True)
        (root / "firmware" / "include" / "build_info.h").write_text('#define DRIFTPAD_FW_VERSION "2.1.0"\n')
        if changelog:
            (root / "CHANGELOG.md").write_text("# Changelog\n\n## 2.1.0\n\n- things\n")
        (root / "configurator" / "js").mkdir(parents=True)
        (root / "configurator" / "index.html").write_text("<!DOCTYPE html>")
        (root / "configurator" / "tests").mkdir()
        (root / "configurator" / "tests" / "run.html").write_text("tests")
        (root / "docs").mkdir()
        shutil.copy(REPO / "docs" / "hardware-acceptance.md", root / "docs" / "hardware-acceptance.md")
        self.build = make_build(root / "build", manifest_extra={"fw_version": "2.1.0", "build_id": "bbbbbbbbbbbb",
                                                                "git_commit": self.COMMIT}).parent
        for extra in ("firmware.bin",):
            (self.build / extra).write_bytes(b"bin")
        self.dirty, self.toolchain_ok, self.tests_ok = dirty, toolchain_ok, tests_ok
        self.commands = []

    def run(self, cmd, cwd):
        self.commands.append(" ".join(map(str, cmd)))
        joined = " ".join(map(str, cmd))
        if cmd[:2] == ["git", "rev-parse"]:
            return SimpleNamespace(returncode=0, stdout=self.COMMIT + "\n", stderr="")
        if cmd[:2] == ["git", "status"]:
            return SimpleNamespace(returncode=0, stdout=" M firmware/src/main.cpp\n" if self.dirty else "", stderr="")
        if "check_toolchain.py" in joined:
            Path(cmd[cmd.index("--json") + 1]).write_text(json.dumps(
                {"ok": self.toolchain_ok, "rows": [] if self.toolchain_ok else
                 [{"component": "PlatformIO Core", "status": "MISMATCH"}]}))
            return SimpleNamespace(returncode=0 if self.toolchain_ok else 1, stdout="", stderr="")
        if "run_all_tests.py" in joined:
            Path(cmd[cmd.index("--json") + 1]).write_text(json.dumps({
                "verdict": "RELEASE_CHECKS_PASSED" if self.tests_ok else "RELEASE_CHECKS_FAILED",
                "counts": {"passed": 300, "planned": 300, "skipped": 0},
                "release_problems": [] if self.tests_ok else ["2 failed / 0 errored tests"],
                "tests": [{"scope": "compiled firmware on host", "status": "PASS"}],
                "inner_results": {"test_configurator_js": {"page": {"passed": 16, "failed": 0}}}}))
            return SimpleNamespace(returncode=0 if self.tests_ok else 1, stdout="", stderr="")
        raise AssertionError(f"unexpected command {cmd}")

    def qualifier(self):
        return qr.Qualifier(repo=self.root, run=self.run, out=lambda s: None, python="python", build_dir=self.build)


class TestQualifyRelease(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_clean_passing_checkout_is_bundled_as_pending_hardware_acceptance(self):
        repo = FakeRepo(self.root / "r")
        q = repo.qualifier()
        self.assertEqual(q.qualify(self.root / "dist", None), 0)
        bundle = self.root / "dist" / "driftpad-2.1.0-bbbbbbbbbbbb"
        for f in ("firmware.uf2", "firmware.elf", "firmware.bin", "build_manifest.json", "test-results.json",
                  "toolchain.json", "RELEASE.md", "SHA256SUMS", "configurator/index.html"):
            self.assertTrue((bundle / f).is_file(), f)
        self.assertFalse((bundle / "configurator" / "tests").exists(), "configurator tests stay out of the bundle")
        notes = (bundle / "RELEASE.md").read_text()
        self.assertIn("hardware acceptance pending", notes)
        self.assertIn("No automated check exercises a physical DriftPad", notes)
        sums = (bundle / "SHA256SUMS").read_text().splitlines()
        self.assertTrue(any(l.endswith("  firmware.uf2") for l in sums))
        self.assertTrue(any("--release" in c and "--clean" in c for c in repo.commands))

    def test_each_failure_stops_qualification(self):
        for kw, step in (({"dirty": True}, "git"), ({"changelog": False}, "version"),
                         ({"toolchain_ok": False}, "toolchain"), ({"tests_ok": False}, "tests")):
            with self.subTest(step=step):
                root = self.root / step
                repo = FakeRepo(root, **kw)
                q = repo.qualifier()
                self.assertEqual(q.qualify(root / "dist", None), 1)
                self.assertEqual([s.name for s in q.steps if not s.ok], [step])
                self.assertFalse((root / "dist").exists() and any((root / "dist").glob("driftpad-*")))
        repo = FakeRepo(self.root / "dirty2", dirty=True)
        repo.qualifier().qualify(self.root / "dirty2" / "dist", None)
        self.assertFalse(any("run_all_tests" in c for c in repo.commands), "stops at the first failure")

    def test_a_build_from_another_commit_is_refused(self):
        repo = FakeRepo(self.root / "r")
        repo.COMMIT = "c" * 40
        q = repo.qualifier()
        self.assertEqual(q.qualify(self.root / "dist", None), 1)
        self.assertIn("HEAD is", [s for s in q.steps if s.name == "image"][0].detail)

    def test_only_a_complete_signed_record_of_this_build_makes_it_beta_ready(self):
        repo = FakeRepo(self.root / "r")
        items = ar.doc_items(repo.root / "docs" / "hardware-acceptance.md")
        rec = ar.new_record({"build_id": "bbbbbbbbbbbb", "fw_version": "2.1.0",
                             "git_commit": FakeRepo.COMMIT}, "t", items)
        path = self.root / "acceptance.json"
        path.write_text(json.dumps(rec))
        q = repo.qualifier()
        self.assertEqual(q.qualify(self.root / "dist", path), 0)
        self.assertFalse(q.steps[-1].data["beta_ready"])
        for i in rec["items"]:
            ar.set_result(rec, i["id"], "pass" if i["required"] else "n/a")
        ar.sign(rec, "reviewer", items)
        path.write_text(json.dumps(rec))
        q = repo.qualifier()
        self.assertEqual(q.qualify(self.root / "dist", path), 0)
        self.assertTrue(q.steps[-1].data["beta_ready"])
        bundle = Path(q.steps[-1].data["path"])
        self.assertIn("ready for external beta", (bundle / "RELEASE.md").read_text())
        self.assertTrue((bundle / "hardware-acceptance.json").is_file())


class TestCiWorkflow(unittest.TestCase):
    """.github/workflows/ci.yml cannot be run here; these checks keep it tied to the lock and to the
    release runner, so it cannot silently build with another toolchain or skip suites."""

    SCOPE = "source inspection"
    TEXT = (REPO / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    def test_runs_on_every_push_and_pull_request(self):
        self.assertRegex(self.TEXT, r"(?m)^on:\s*\n\s+push:\s*\n\s+pull_request:")

    def test_toolchain_comes_from_the_lock_not_from_the_workflow(self):
        self.assertIn('json.load(open("firmware/toolchain.lock.json"))', self.TEXT)
        self.assertNotIn(LOCK["platform"]["commit"], self.TEXT, "the commit must be read from the lock")
        self.assertIn("--write-pinned-conf", self.TEXT)
        self.assertIn("DRIFTPAD_PIO_PROJECT_CONF", self.TEXT)
        self.assertIn("pip install -r tests/requirements-dev.txt", self.TEXT)
        self.assertIn("check_toolchain.py --require-libs", self.TEXT)

    def test_runs_every_suite_in_release_mode_with_full_history(self):
        self.assertRegex(self.TEXT, r"run_all_tests\.py --release --clean --json")
        self.assertIn("fetch-depth: 0", self.TEXT)
        self.assertNotRegex(self.TEXT, r"continue-on-error:\s*true")

    def test_runner_temp_and_browser_sandbox_are_step_scoped(self):
        self.assertIn("matrix:\n        os: [ubuntu-24.04, windows-2022]", self.TEXT)
        self.assertIn("${{ runner.temp }}/platformio.pinned.ini", self.TEXT)
        job_env = self.TEXT.split("    env:\n", 1)[1].split("    steps:\n", 1)[0]
        self.assertNotIn("DRIFTPAD_PIO_PROJECT_CONF", job_env)
        self.assertIn("DRIFTPAD_CHROME_NO_SANDBOX: ${{ runner.os == 'Linux' && '1' || '0' }}", self.TEXT)
        self.assertNotIn("DRIFTPAD_CHROME_NO_SANDBOX", job_env)

    def test_publishes_nothing(self):
        self.assertIn("contents: read", self.TEXT)
        for verb in ("gh release", "git push", "git tag", "softprops/action-gh-release", "twine", "npm publish"):
            self.assertNotIn(verb, self.TEXT)


class TestOfflinePages(unittest.TestCase):

    SCOPE = "source inspection"

    def test_key_tester_needs_no_network(self):
        html = (TOOLS / "key_tester.html").read_text(encoding="utf-8")
        self.assertNotRegex(html, r"(src|href)\s*=\s*[\"'](https?:)?//")
        self.assertNotIn("fetch(", html)


if __name__ == "__main__":
    unittest.main(verbosity=2)
