"""
test_build.py - Automated PlatformIO Build Verification for DriftPad RP2040 Firmware.

Authoritative References:
- ORIGINAL_REQUEST.md: "PlatformIO project builds cleanly (`python -m platformio run`) producing a valid `.pio/build/pico/firmware.uf2` with zero build errors."
- spec_verification_harness.md: Section 7 (Build Verification Specification), TC-13

Pure Python 3 standard library: zero external pip dependencies.
"""

import os
import shutil
import struct
import subprocess
import sys
import unittest
from pathlib import Path


class TestPlatformIOBuild(unittest.TestCase):
    """
    Automated PlatformIO RP2040 firmware build verification.
    """

    @classmethod
    def setUpClass(cls):
        cls.root_dir = Path(__file__).resolve().parent.parent
        cls.firmware_dir = cls.root_dir / "firmware"
        cls.build_dir = cls.firmware_dir / ".pio" / "build" / "pico"
        cls.uf2_path = cls.build_dir / "firmware.uf2"
        cls.elf_path = cls.build_dir / "firmware.elf"
        cls.bin_path = cls.build_dir / "firmware.bin"

    def test_tc13_platformio_clean_build(self):
        """TC-13: Execute 'python -m platformio run' (or 'pio run') in firmware/ and assert exit code 0."""
        self.assertTrue(
            self.firmware_dir.is_dir(),
            f"Firmware directory does not exist: {self.firmware_dir}"
        )
        self.assertTrue(
            (self.firmware_dir / "platformio.ini").is_file(),
            "Missing platformio.ini in firmware directory"
        )

        cmd = [sys.executable, "-m", "platformio", "run"]
        try:
            result = subprocess.run(
                cmd,
                cwd=str(self.firmware_dir),
                capture_output=True,
                text=True
            )
            # If the platformio module is missing from the active Python environment, fall back to 'pio' on PATH
            if result.returncode != 0 and (
                "No module named platformio" in result.stderr
                or "No module named platformio" in result.stdout
            ):
                pio_path = shutil.which("pio") or "pio"
                result = subprocess.run(
                    [pio_path, "run"],
                    cwd=str(self.firmware_dir),
                    capture_output=True,
                    text=True
                )
        except (FileNotFoundError, OSError):
            pio_path = shutil.which("pio") or "pio"
            result = subprocess.run(
                [pio_path, "run"],
                cwd=str(self.firmware_dir),
                capture_output=True,
                text=True
            )

        self.assertEqual(
            result.returncode, 0,
            f"PlatformIO build failed with return code {result.returncode}.\n"
            f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
        self.assertIn("SUCCESS", result.stdout, "Build output did not report [SUCCESS]")

    def test_firmware_uf2_artifact_exists_and_non_empty(self):
        """Verifies that .pio/build/pico/firmware.uf2 exists and is non-empty."""
        self.assertTrue(
            self.uf2_path.is_file(),
            f"Expected firmware.uf2 binary at {self.uf2_path}, but file was not found."
        )
        file_size = self.uf2_path.stat().st_size
        self.assertGreater(
            file_size, 0,
            f"firmware.uf2 exists but is empty (0 bytes)."
        )
        # Expected size range: between 100 KB and 1 MB
        self.assertGreaterEqual(
            file_size, 100 * 1024,
            f"firmware.uf2 size ({file_size} bytes) is suspiciously small for RP2040 image."
        )
        self.assertLessEqual(
            file_size, 2 * 1024 * 1024,
            f"firmware.uf2 size ({file_size} bytes) exceeds RP2040 Flash partition limit (2MB)."
        )

    def test_firmware_elf_and_bin_artifacts(self):
        """Verifies that .pio/build/pico/firmware.elf and firmware.bin exist and are non-empty."""
        self.assertTrue(self.elf_path.is_file(), f"Missing {self.elf_path}")
        self.assertGreater(self.elf_path.stat().st_size, 0)

        self.assertTrue(self.bin_path.is_file(), f"Missing {self.bin_path}")
        self.assertGreater(self.bin_path.stat().st_size, 0)

    def test_uf2_binary_header_and_magic_numbers(self):
        """Verifies UF2 512-byte block format, magic numbers, and RP2040 family ID."""
        self.assertTrue(self.uf2_path.is_file())
        with open(self.uf2_path, "rb") as f:
            header = f.read(512)

        self.assertEqual(len(header), 512, "First UF2 block must be exactly 512 bytes")

        # Unpack UF2 header:
        # uint32 magicStart0 (0x0A324655)
        # uint32 magicStart1 (0x9E5D5157)
        # uint32 flags
        # uint32 targetAddr
        # uint32 payloadSize (typically 256)
        # uint32 blockNo
        # uint32 numBlocks
        # uint32 familyID (RP2040: 0xe48bff56)
        (
            magic_start0,
            magic_start1,
            flags,
            target_addr,
            payload_size,
            block_no,
            num_blocks,
            family_id
        ) = struct.unpack("<IIIIIIII", header[:32])

        magic_end = struct.unpack("<I", header[508:512])[0]

        UF2_MAGIC_START0 = 0x0A324655
        UF2_MAGIC_START1 = 0x9E5D5157
        UF2_MAGIC_END = 0x0AB16F30
        RP2040_FAMILY_ID = 0xE48BFF56

        self.assertEqual(
            magic_start0, UF2_MAGIC_START0,
            f"Invalid UF2 magicStart0: {hex(magic_start0)} != {hex(UF2_MAGIC_START0)}"
        )
        self.assertEqual(
            magic_start1, UF2_MAGIC_START1,
            f"Invalid UF2 magicStart1: {hex(magic_start1)} != {hex(UF2_MAGIC_START1)}"
        )
        self.assertEqual(
            magic_end, UF2_MAGIC_END,
            f"Invalid UF2 magicEnd: {hex(magic_end)} != {hex(UF2_MAGIC_END)}"
        )
        self.assertEqual(
            family_id, RP2040_FAMILY_ID,
            f"Invalid target family ID: {hex(family_id)} != {hex(RP2040_FAMILY_ID)} (RP2040)"
        )
        self.assertEqual(payload_size, 256, f"Expected 256 payload bytes per UF2 block, got {payload_size}")
        self.assertGreater(num_blocks, 0, "UF2 block count must be > 0")


if __name__ == "__main__":
    unittest.main(verbosity=2)
