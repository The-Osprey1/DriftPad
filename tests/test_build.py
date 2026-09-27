"""
test_build.py - PlatformIO build of the DriftPad RP2040 firmware and checks of what THIS build produced.

TC-13 builds the firmware (`pio` from PATH, else `<python> -m platformio`) after deleting the
previous firmware.elf/.bin/.uf2 and build_manifest.json, and records the evidence in
tests/build_state.py. The artifact tests (TC-B1..TC-B4) then require that evidence: they fail if
the build did not run (or failed) in this process, if an artifact predates the build start, or if
its sha256 differs from the manifest written by the build. They never validate cached binaries.

Test methods are numbered so the build runs first under plain `python -m unittest` too.

Options (see build_state.py for the full list):
  --clean / DRIFTPAD_CLEAN_BUILD=1   run `pio run -t clean` before building
  DRIFTPAD_FIRMWARE_DIR=<dir>        build a copy of firmware/ instead of the repository's
  DRIFTPAD_RELEASE=1                 missing manifest, dirty build or build id mismatch fail

Usage:
    python -m unittest -v tests.test_build
    python tests/test_build.py --clean

Pure Python 3 standard library: zero external pip dependencies.
"""

import os
import struct
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import build_state  # noqa: E402

UF2_MAGIC_START0 = 0x0A324655
UF2_MAGIC_START1 = 0x9E5D5157
UF2_MAGIC_END = 0x0AB16F30
RP2040_FAMILY_ID = 0xE48BFF56


class TestPlatformIOBuild(unittest.TestCase):
    """Builds the firmware once, then checks the artifacts that build produced."""

    def test_00_tc13_platformio_build(self):
        """TC-13: `pio run` in the firmware directory exits 0 and reports [SUCCESS]."""
        fw = build_state.firmware_dir()
        self.assertTrue((fw / "platformio.ini").is_file(), f"Missing platformio.ini in {fw}")

        rec = build_state.run_build()
        if rec.skipped_reason:
            self.skipTest(rec.skipped_reason)

        header = (f"build of {rec.firmware_dir} via {rec.pio_how}"
                  f"{' (clean)' if rec.clean else ''}")
        if rec.clean and rec.clean_returncode not in (None, 0):
            self.fail(f"{header}: `pio run -t clean` failed with exit {rec.clean_returncode}\n{rec.output_tail}")
        self.assertEqual(rec.returncode, 0,
                         f"{header}: PlatformIO exited {rec.returncode}\n{rec.output_tail}")
        self.assertTrue(rec.success_marker, f"{header}: output did not report [SUCCESS]\n{rec.output_tail}")

        for w in rec.warnings:
            print(f"\n  [build warning] {w}", file=sys.stderr)
        if build_state.release_mode():
            problems = list(rec.release_problems)
            if build_state.using_foreign_firmware_dir():
                problems.append(f"DRIFTPAD_FIRMWARE_DIR points at {rec.firmware_dir}, not this repository")
            if problems:
                self.fail("Build not release-qualified:\n  - " + "\n  - ".join(problems))

    def test_01_uf2_artifact_from_this_build(self):
        """TC-B1: firmware.uf2 was produced by this run's build and has a plausible size."""
        rec = build_state.require_fresh_build(self)
        path = build_state.check_artifact(self, rec, "firmware.uf2")
        size = path.stat().st_size
        self.assertGreaterEqual(size, 100 * 1024, f"firmware.uf2 size ({size} bytes) is suspiciously small")
        self.assertLessEqual(size, 2 * 2 * 1024 * 1024,
                             f"firmware.uf2 size ({size} bytes) cannot fit 2 MB of flash")
        self.assertEqual(size % 512, 0, "UF2 files are a whole number of 512-byte blocks")

    def test_02_elf_and_bin_artifacts_from_this_build(self):
        """TC-B2: firmware.elf and firmware.bin were produced by this run's build."""
        rec = build_state.require_fresh_build(self)
        for name in ("firmware.elf", "firmware.bin"):
            path = build_state.check_artifact(self, rec, name)
            self.assertGreater(path.stat().st_size, 0, f"{name} is empty")

    def test_03_uf2_header_and_magic_numbers(self):
        """TC-B3: first UF2 block has the UF2 magics, 256-byte payload and the RP2040 family ID."""
        rec = build_state.require_fresh_build(self)
        path = build_state.check_artifact(self, rec, "firmware.uf2")
        with open(path, "rb") as f:
            header = f.read(512)
        self.assertEqual(len(header), 512, "First UF2 block must be exactly 512 bytes")

        (magic_start0, magic_start1, _flags, _target_addr, payload_size, _block_no, num_blocks,
         family_id) = struct.unpack("<IIIIIIII", header[:32])
        magic_end = struct.unpack("<I", header[508:512])[0]

        self.assertEqual(magic_start0, UF2_MAGIC_START0, f"Invalid UF2 magicStart0: {hex(magic_start0)}")
        self.assertEqual(magic_start1, UF2_MAGIC_START1, f"Invalid UF2 magicStart1: {hex(magic_start1)}")
        self.assertEqual(magic_end, UF2_MAGIC_END, f"Invalid UF2 magicEnd: {hex(magic_end)}")
        self.assertEqual(family_id, RP2040_FAMILY_ID, f"Invalid family ID {hex(family_id)} (RP2040 expected)")
        self.assertEqual(payload_size, 256, f"Expected 256 payload bytes per UF2 block, got {payload_size}")
        self.assertGreater(num_blocks, 0, "UF2 block count must be > 0")

    def test_04_build_manifest_matches_artifacts(self):
        """TC-B4: build_manifest.json was written by this build and hashes exactly these artifacts."""
        rec = build_state.require_fresh_build(self)
        if rec.manifest_error:
            self.fail(rec.manifest_error)
        if rec.manifest is None:
            msg = (f"no {build_state.MANIFEST_NAME} in {rec.build_dir}: the build_info.py post-build step "
                   "is not part of this build, so artifacts are not tied to a build id")
            if build_state.release_mode():
                self.fail(msg)
            self.skipTest(msg)

        manifest_path = Path(rec.manifest_path)
        self.assertGreaterEqual(manifest_path.stat().st_mtime, rec.started_at - build_state.MTIME_TOLERANCE_S,
                                f"{manifest_path.name} predates this run's build")
        errors = build_state.manifest_consistency_errors(rec.manifest, rec.artifacts)
        self.assertEqual(errors, [], "Manifest does not describe the artifacts of this build:\n  - "
                         + "\n  - ".join(errors))
        self.assertEqual(rec.manifest.get("env"), build_state.PIO_ENV)

        head = (rec.git or {}).get("commit")
        if head is not None and rec.manifest.get("git_commit") != head:
            msg = f"manifest git_commit {rec.manifest.get('git_commit')} != checkout HEAD {head}"
            if build_state.release_mode():
                self.fail(msg)
            print(f"\n  [build warning] {msg}", file=sys.stderr)


if __name__ == "__main__":
    if "--clean" in sys.argv:
        sys.argv.remove("--clean")
        os.environ[build_state.ENV_CLEAN] = "1"
    unittest.main(verbosity=2)
