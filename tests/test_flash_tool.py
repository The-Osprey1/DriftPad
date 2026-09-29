"""
test_flash_tool.py - tools/flash.py and tools/firmware_image.py against fake pads and drives.

Scope: host tooling with fakes. No board is touched: serial ports, the bootloader drive, the copy
and the clock are replaced (flash.Env). The pads speak enough protocol 2 (and protocol 1) for
identification, BOOTSEL and the INFO read after the update. Images are synthetic (UF2 blocks, a
minimal ELF32 with the linker symbols, a manifest), plus the real build when one exists.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
TOOLS = TESTS_DIR.parent / "tools"
for _p in (TESTS_DIR, TOOLS):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import driftpad_serial as ds     # noqa: E402
import firmware_image as fimg    # noqa: E402
import flash                     # noqa: E402
from firmware_images import FS_START, NEW, make_build, uf2_blocks   # noqa: E402


# ------------------------------------------------------------------------------ fake machine
class Pad:
    def __init__(self, world, device, serial, fw="2.0.0", build="old000000000", dirty=False, source="slot_a",
                 seq=3, cal="valid", legacy=False, after=None):
        self.world, self.device, self.serial = world, device, serial
        self.fw, self.build, self.dirty, self.source, self.seq, self.cal = fw, build, dirty, source, seq, cal
        self.legacy = legacy
        self.state = "app"            # app | bootloader
        self.after = dict(fw=NEW["fw_version"], build=NEW["build_id"], legacy=False)
        self.after.update(after or {})
        self.bootsel_lines = []
        world.pads.append(self)

    def port(self):
        return ds.PortInfo(self.device, ds.RPI_VID, ds.DRIFTPAD_PID, self.serial, "DriftPad")

    def info(self, rid):
        return {"status": "ok", "id": rid, "cmd": "INFO", "type": "info", "device": "DriftPad", "hw": "DriftPad V2",
                "fw": self.fw, "protocol": 2, "build": self.build,
                "calibration": {"state": self.cal}, "settings": {"dirty": self.dirty, "source": self.source, "seq": self.seq}}

    def handle(self, line, out):
        parts = line.split()
        rid = parts[0][1:] if parts and parts[0].startswith("@") else None
        verb = parts[1] if rid else (parts[0] if parts else "")
        if self.legacy:
            if verb == "PING" and rid is None:
                out.append(b'{"type":"pong"}\n')
            elif verb == "BOOTSEL":
                self.bootsel_lines.append(line)
                self.state = "bootloader"
            else:
                out.append(b'{"status":"error","msg":"Unknown command"}\n')
            return
        if verb == "INFO":
            out.append((json.dumps(self.info(rid)) + "\n").encode())
        elif verb == "BOOTSEL":
            self.bootsel_lines.append(line)
            out.append((json.dumps({"status": "ok", "id": rid, "cmd": "BOOTSEL", "bootsel": True}) + "\n").encode())
            self.state = "bootloader"
        else:
            out.append((json.dumps({"status": "error", "id": rid, "cmd": "", "code": "unknown_command"}) + "\n").encode())

    def boot_new_image(self):
        self.state = "app"
        self.fw, self.build, self.legacy = self.after["fw"], self.after["build"], self.after["legacy"]
        if "seq" in self.after:
            self.seq = self.after["seq"]
        if "cal" in self.after:
            self.cal = self.after["cal"]
        self.dirty = False


class Link:
    def __init__(self, world, pad):
        self.world, self.pad, self.out = world, pad, []

    def write(self, data):
        for line in data.decode().splitlines():
            if self.pad.state == "app":
                self.pad.handle(line, self.out)

    def readline(self):
        self.world.now += 0.01
        return self.out.pop(0) if self.out else b""

    def reset_input_buffer(self):
        self.out.clear()

    def close(self):
        pass


class World:
    def __init__(self, answer="y", stuck_in_app=False, extra_drives=()):
        self.now = 0.0
        self.pads = []
        self.copies = []
        self.answer = answer
        self.stuck_in_app = stuck_in_app       # BOOTSEL acknowledged but no drive appears
        self.extra = [Path(d) for d in extra_drives]

    def env(self):
        return flash.Env(list_ports=self.list_ports, opener=self.opener, drives=self.drives, copy=self.copy,
                         build=lambda out: True, sleep=self.sleep, clock=lambda: self.now,
                         ask=lambda prompt: self.answer, out=lambda text: None)

    def list_ports(self):
        return [p.port() for p in self.pads if p.state == "app"]

    def opener(self, device):
        for p in self.pads:
            if p.device == device and p.state == "app":
                return Link(self, p)
        raise OSError(f"could not open port {device}")

    def drive_of(self, pad):
        return Path(f"BOOT-{pad.serial}")

    def drives(self):
        if self.stuck_in_app:
            for p in self.pads:
                if p.state == "bootloader":
                    p.state = "app"
        return self.extra + [self.drive_of(p) for p in self.pads if p.state == "bootloader"]

    def copy(self, src, dst):
        self.copies.append((Path(src), Path(dst)))
        for p in self.pads:
            if p.state == "bootloader" and Path(dst).parent == self.drive_of(p):
                p.boot_new_image()
        for d in self.extra:
            if Path(dst).parent == d:
                self.extra.remove(d)
                if getattr(self, "board_dead", False):     # the image never starts
                    break
                self.pads.append(self.bootloader_board)
                self.bootloader_board.boot_new_image()
                break

    def sleep(self, s):
        self.now += s


# ------------------------------------------------------------------------------ tests
class TestImageChecks(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, **kw):
        allow_dirty = kw.pop("allow_dirty", False)
        self.n = getattr(self, "n", 0) + 1
        uf2 = make_build(self.root / f"b{self.n}", **kw)   # a fresh directory per build
        return fimg.check_image(uf2, uf2.parent / "firmware.elf", uf2.parent / "build_manifest.json", allow_dirty)

    def test_a_good_image_passes(self):
        c = self.check()
        self.assertEqual((c.ok, c.problems, c.image.blocks, c.code_end), (True, [], 8, FS_START))

    def test_uf2_structure_and_family_are_enforced(self):
        for uf2, expect in ((uf2_blocks(corrupt="magic"), "magic"), (uf2_blocks(corrupt="numbering"), "numbered"),
                            (uf2_blocks(family=0x68ED2B88), "family"), (b"\0" * 100, "multiple of 512")):
            with self.subTest(expect=expect):
                c = self.check(uf2=uf2)
                self.assertFalse(c.ok)
                self.assertIn(expect, " ".join(c.problems))

    def test_an_image_reaching_the_settings_sectors_is_refused(self):
        c = self.check(uf2=uf2_blocks(start=FS_START - 4 * 256, count=8))
        self.assertFalse(c.ok)
        self.assertIn("settings sectors", " ".join(c.problems))

    def test_the_settings_boundary_comes_from_the_elf(self):
        c = self.check(fs_start=0x10000000 + 4 * 256)     # a build that reserves more flash
        self.assertFalse(c.ok, "8 blocks do not fit below this build's _FS_start")
        c = self.check(elf=False)
        self.assertFalse(c.ok)
        self.assertIn("no firmware.elf", " ".join(c.problems))

    def test_the_files_must_be_the_manifest_s(self):
        c = self.check(tamper=True)
        self.assertIn("sha256 differs", " ".join(c.problems))
        c = self.check(manifest_extra={"build_id": ""})
        self.assertIn("no build_id", " ".join(c.problems))

    def test_dirty_builds_need_an_explicit_allowance(self):
        c = self.check(manifest_extra={"git_dirty": True})
        self.assertIn("uncommitted", " ".join(c.problems))
        c = self.check(manifest_extra={"git_dirty": True}, allow_dirty=True)
        self.assertTrue(c.ok)
        self.assertIn("uncommitted", " ".join(c.warnings))

    def test_the_real_build_passes_when_present(self):
        build = TESTS_DIR.parent / "firmware" / ".pio" / "build" / "pico"
        if not (build / "firmware.uf2").is_file():
            self.skipTest("no firmware build in this checkout")
        c = fimg.check_image(build / "firmware.uf2", build / "firmware.elf", build / "build_manifest.json",
                             allow_dirty=True)
        self.assertEqual(c.problems, [])
        self.assertLess(c.image.end, c.code_end)


class TestFlash(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.uf2 = make_build(Path(self.tmp.name) / "build")

    def tearDown(self):
        self.tmp.cleanup()

    def run_flash(self, world, *argv):
        env = world.env()
        code = flash.main(["--uf2", str(self.uf2), *argv], env)
        return code, "\n".join(env.log)

    def test_one_pad_is_updated_and_verified(self):
        w = World()
        pad = Pad(w, "COM7", "E661A")
        code, log = self.run_flash(w, "--yes")
        self.assertEqual(code, flash.OK, log)
        self.assertIn("Updated and verified: fw 2.1.0 build c0ffee123456", log)
        self.assertEqual(len(pad.bootsel_lines), 1)
        self.assertRegex(pad.bootsel_lines[0], r"^@\d+ BOOTSEL$")
        self.assertEqual(w.copies, [(self.uf2, Path("BOOT-E661A") / "firmware.uf2")])

    def test_several_pads_are_never_guessed_between(self):
        w = World()
        a, b = Pad(w, "COM7", "AAA"), Pad(w, "COM8", "BBB")
        code, log = self.run_flash(w, "--yes")
        self.assertEqual(code, flash.REFUSED)
        self.assertIn("2 DriftPads connected", log)
        self.assertEqual((a.bootsel_lines, b.bootsel_lines, w.copies), ([], [], []))
        code, log = self.run_flash(w, "--yes", "--port", "COM8")
        self.assertEqual(code, flash.OK, log)
        self.assertEqual((len(a.bootsel_lines), len(b.bootsel_lines)), (0, 1))
        self.assertEqual((a.build, b.build), ("old000000000", NEW["build_id"]))

    def test_unsaved_settings_are_not_lost_silently(self):
        w = World()
        pad = Pad(w, "COM7", "AAA", dirty=True)
        code, log = self.run_flash(w, "--yes")
        self.assertEqual(code, flash.REFUSED)
        self.assertIn("not saved", log)
        self.assertEqual(pad.bootsel_lines, [])
        code, log = self.run_flash(w, "--yes", "--discard-unsaved")
        self.assertEqual(code, flash.OK, log)

    def test_downgrades_need_an_explicit_allowance(self):
        w = World()
        Pad(w, "COM7", "AAA", fw="2.2.0")
        code, log = self.run_flash(w, "--yes")
        self.assertEqual(code, flash.REFUSED)
        self.assertIn("downgrade", log)
        self.assertEqual(self.run_flash(w, "--yes", "--allow-downgrade")[0], flash.OK)

    def test_the_user_is_asked_first(self):
        w = World(answer="n")
        pad = Pad(w, "COM7", "AAA")
        code, log = self.run_flash(w)
        self.assertEqual(code, flash.REFUSED)
        self.assertEqual((pad.bootsel_lines, w.copies), ([], []))

    def test_a_pad_that_comes_back_with_another_build_fails_verification(self):
        w = World()
        Pad(w, "COM7", "AAA", after={"build": "somethingelse"})
        code, log = self.run_flash(w, "--yes")
        self.assertEqual(code, flash.FAILED)
        self.assertIn("UPDATE NOT VERIFIED", log)
        self.assertIn("build_id", log)

    def test_saved_settings_and_calibration_must_survive(self):
        for after, expect in (({"seq": 0}, "saved settings changed"), ({"cal": "missing"}, "calibration was")):
            with self.subTest(after=after):
                w = World()
                Pad(w, "COM7", "AAA", after=after)
                code, log = self.run_flash(w, "--yes")
                self.assertEqual(code, flash.FAILED)
                self.assertIn(expect, log)

    def test_no_bootloader_drive_means_nothing_was_flashed(self):
        w = World(stuck_in_app=True)
        Pad(w, "COM7", "AAA")
        code, log = self.run_flash(w, "--yes")
        self.assertEqual(code, flash.FAILED)
        self.assertIn("did not appear", log)
        self.assertEqual(w.copies, [])

    def test_legacy_firmware_is_updated_with_a_plain_bootsel(self):
        w = World()
        pad = Pad(w, "COM7", "AAA", legacy=True)
        code, log = self.run_flash(w, "--yes")
        self.assertEqual(code, flash.OK, log)
        self.assertEqual(pad.bootsel_lines, ["BOOTSEL"])
        self.assertIn("legacy firmware", log)

    def test_a_board_already_in_bootloader_mode(self):
        w = World(extra_drives=["BOOT-X"])
        w.bootloader_board = Pad(w, "COM9", "XYZ")
        w.pads.remove(w.bootloader_board)
        code, log = self.run_flash(w, "--yes")
        self.assertEqual(code, flash.OK, log)
        self.assertIn("cannot be identified before flashing", log)
        w2 = World(extra_drives=["BOOT-X", "BOOT-Y"])
        code, log = self.run_flash(w2, "--yes")
        self.assertEqual(code, flash.REFUSED)
        self.assertIn("choose one with --drive", log)

    def test_another_pad_is_not_mistaken_for_the_flashed_board(self):
        w = World(extra_drives=["BOOT-X"])
        w.bootloader_board = Pad(w, "COM9", "XYZ")
        w.pads.remove(w.bootloader_board)
        w.board_dead = True
        Pad(w, "COM7", "OTHER", fw=NEW["fw_version"], build=NEW["build_id"])   # already on this build
        code, log = self.run_flash(w, "--yes", "--drive", "BOOT-X")
        self.assertEqual(code, flash.FAILED, log)
        self.assertNotIn("Updated and verified", log)

    def test_a_bad_image_stops_before_any_pad_is_touched(self):
        make_build(Path(self.tmp.name) / "build", uf2=uf2_blocks(start=FS_START - 256, count=4))
        w = World()
        pad = Pad(w, "COM7", "AAA")
        code, log = self.run_flash(w, "--yes")
        self.assertEqual(code, flash.REFUSED)
        self.assertEqual((pad.bootsel_lines, w.copies), ([], []))

    def test_version_ordering(self):
        k = flash.version_key
        self.assertLess(k("2.1.0-beta.1"), k("2.1.0-beta.2"))
        self.assertLess(k("2.1.0-beta.2"), k("2.1.0"))
        self.assertLess(k("2.1.0"), k("2.1.1"))
        self.assertLess(k("2.9.0"), k("2.10.0"))
        self.assertIsNone(k("unknown"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
