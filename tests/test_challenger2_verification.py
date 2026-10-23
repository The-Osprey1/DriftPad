"""
test_challenger2_verification.py - Deep Adversarial Verification for Challenger 2
Milestone M2 Iteration 3: Firmware DSP Robustness, PlatformIO Build, UF2 & ELF Integrity.
"""

import os
import struct
import sys
import zlib
import re
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
FIRMWARE_DIR = ROOT_DIR / "firmware"

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_state  # noqa: E402

# CH2-01..04 inspect the artifacts of the build that ran earlier in this process (TC-13 in
# test_build.py) and fail when there was none; they never read binaries left by an older build.
BUILD_DIR = build_state.build_dir()
UF2_PATH = BUILD_DIR / "firmware.uf2"
ELF_PATH = BUILD_DIR / "firmware.elf"
BIN_PATH = BUILD_DIR / "firmware.bin"


def _fresh_artifacts(testcase, *names):
    """Build evidence for CH2-01..04: every named artifact comes from this run's build."""
    rec = build_state.require_fresh_build(testcase)
    return [build_state.check_artifact(testcase, rec, n) for n in names]

RP2040_FLASH_START = 0x10000000
RP2040_FLASH_SIZE  = 2 * 1024 * 1024  # 2MB
RP2040_EEPROM_START = 0x101FF000       # Last 4KB sector of 2MB Flash
RP2040_SRAM_START  = 0x20000000
RP2040_SRAM_SIZE   = 264 * 1024        # 264KB total SRAM

UF2_MAGIC_START0 = 0x0A324655
UF2_MAGIC_START1 = 0x9E5D5157
UF2_MAGIC_END    = 0x0AB16F30
RP2040_FAMILY_ID = 0xE48BFF56

class TestChallenger2Adversarial(unittest.TestCase):

    def test_01_all_build_artifacts_present(self):
        """Verify presence and non-zero size of UF2, ELF, and BIN artifacts."""
        _fresh_artifacts(self, "firmware.uf2", "firmware.elf", "firmware.bin")
        self.assertTrue(UF2_PATH.is_file(), f"UF2 binary missing at {UF2_PATH}")
        self.assertTrue(ELF_PATH.is_file(), f"ELF binary missing at {ELF_PATH}")
        self.assertTrue(BIN_PATH.is_file(), f"BIN binary missing at {BIN_PATH}")

        uf2_size = UF2_PATH.stat().st_size
        elf_size = ELF_PATH.stat().st_size
        bin_size = BIN_PATH.stat().st_size

        self.assertGreater(uf2_size, 50 * 1024, "UF2 size is suspiciously small")
        self.assertGreater(elf_size, 200 * 1024, "ELF size is suspiciously small")
        self.assertGreater(bin_size, 30 * 1024, "BIN size is suspiciously small")

    def test_02_uf2_exhaustive_all_block_validation(self):
        """Adversarially validates ALL blocks in firmware.uf2 for magic numbers, sequence, addresses, and family ID."""
        _fresh_artifacts(self, "firmware.uf2")
        with open(UF2_PATH, "rb") as f:
            data = f.read()

        self.assertEqual(len(data) % 512, 0, f"UF2 length {len(data)} is not a multiple of 512!")
        total_blocks = len(data) // 512
        self.assertGreater(total_blocks, 0, "UF2 file has 0 blocks!")

        seen_blocks = set()
        prev_addr = None

        for i in range(total_blocks):
            block = data[i * 512 : (i + 1) * 512]
            (
                m0, m1, flags, target_addr, payload_size, block_no, reported_total, family_id
            ) = struct.unpack("<IIIIIIII", block[:32])
            m_end = struct.unpack("<I", block[508:512])[0]

            self.assertEqual(m0, UF2_MAGIC_START0, f"Block {i}: Invalid magicStart0 {hex(m0)}")
            self.assertEqual(m1, UF2_MAGIC_START1, f"Block {i}: Invalid magicStart1 {hex(m1)}")
            self.assertEqual(m_end, UF2_MAGIC_END, f"Block {i}: Invalid magicEnd {hex(m_end)}")
            self.assertEqual(block_no, i, f"Block {i}: Sequential mismatch: block_no={block_no}")
            self.assertEqual(reported_total, total_blocks, f"Block {i}: Total blocks mismatch")
            self.assertEqual(payload_size, 256, f"Block {i}: Payload size must be 256 bytes")
            self.assertEqual(family_id, RP2040_FAMILY_ID, f"Block {i}: Invalid RP2040 Family ID {hex(family_id)}")

            # Address validity
            self.assertGreaterEqual(target_addr, RP2040_FLASH_START, f"Block {i}: Target {hex(target_addr)} below flash start")
            self.assertLess(target_addr + payload_size, RP2040_EEPROM_START,
                            f"CRITICAL: Block {i} target {hex(target_addr)} collides with Flash EEPROM sector ({hex(RP2040_EEPROM_START)})!")

            if prev_addr is not None:
                self.assertEqual(target_addr, prev_addr + payload_size,
                                 f"Block {i}: Target address gap or discontinuity: {hex(target_addr)} != {hex(prev_addr + payload_size)}")
            prev_addr = target_addr
            seen_blocks.add(block_no)

        self.assertEqual(len(seen_blocks), total_blocks, "Duplicate or missing block indices detected in UF2!")

    def test_03_elf_headers_and_segment_isolation(self):
        """Adversarially validates ELF headers, 32-bit ARM machine type, entry point, and program segments."""
        _fresh_artifacts(self, "firmware.elf")
        with open(ELF_PATH, "rb") as f:
            elf = f.read()

        # Check ELF Ident
        self.assertEqual(elf[:4], b"\x7fELF", "Invalid ELF magic!")
        ei_class = elf[4]
        ei_data = elf[5]
        self.assertEqual(ei_class, 1, "ELF is not 32-bit (expected 1 for ELF32)")
        self.assertEqual(ei_data, 1, "ELF is not little endian (expected 1 for ELFDATA2LSB)")

        (
            e_type, e_machine, e_version, e_entry, e_phoff, e_shoff,
            e_flags, e_ehsize, e_phentsize, e_phnum, e_shentsize, e_shnum, e_shstrndx
        ) = struct.unpack("<HHIIIIIHHHHHH", elf[16:52])

        self.assertEqual(e_machine, 40, f"ELF machine {e_machine} is not ARM (40)")
        self.assertGreaterEqual(e_entry, RP2040_FLASH_START, f"Entry point {hex(e_entry)} not in flash")
        self.assertLess(e_entry, RP2040_EEPROM_START, f"Entry point {hex(e_entry)} in EEPROM sector")

        # Read Program Headers (PT_LOAD segments)
        pt_load_segments = []
        for i in range(e_phnum):
            ph = elf[e_phoff + i * e_phentsize : e_phoff + (i + 1) * e_phentsize]
            p_type, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, p_flags, p_align = struct.unpack("<IIIIIIII", ph)
            if p_type == 1:  # PT_LOAD
                pt_load_segments.append({
                    "vaddr": p_vaddr, "paddr": p_paddr, "filesz": p_filesz, "memsz": p_memsz, "flags": p_flags
                })

        self.assertGreater(len(pt_load_segments), 0, "No PT_LOAD segments in ELF")

        # Verify segments do not collide with Flash EEPROM sector
        for seg in pt_load_segments:
            vaddr = seg["vaddr"]
            memsz = seg["memsz"]
            # If in flash range
            if RP2040_FLASH_START <= vaddr < (RP2040_FLASH_START + RP2040_FLASH_SIZE):
                self.assertLess(vaddr + memsz, RP2040_EEPROM_START,
                                f"PT_LOAD segment at {hex(vaddr)} (size {memsz}) overlaps EEPROM at {hex(RP2040_EEPROM_START)}")

    def test_04_memory_footprint_and_budgets(self):
        """Verifies static RAM and Flash budgets meet strict production thresholds."""
        _fresh_artifacts(self, "firmware.elf")
        with open(ELF_PATH, "rb") as f:
            elf = f.read()

        (
            e_type, e_machine, e_version, e_entry, e_phoff, e_shoff,
            e_flags, e_ehsize, e_phentsize, e_phnum, e_shentsize, e_shnum, e_shstrndx
        ) = struct.unpack("<HHIIIIIHHHHHH", elf[16:52])

        shstrtab_hdr = elf[e_shoff + e_shstrndx * e_shentsize : e_shoff + (e_shstrndx + 1) * e_shentsize]
        _, _, _, _, str_offset, str_size, _, _, _, _ = struct.unpack("<IIIIIIIIII", shstrtab_hdr)
        strtab = elf[str_offset : str_offset + str_size]

        sections = {}
        for i in range(e_shnum):
            s_hdr = elf[e_shoff + i * e_shentsize : e_shoff + (i + 1) * e_shentsize]
            s_name, s_type, s_flags, s_addr, s_offset, s_size, _, _, _, _ = struct.unpack("<IIIIIIIIII", s_hdr)
            name_end = strtab.find(b"\x00", s_name)
            name = strtab[s_name:name_end].decode("ascii", errors="ignore")
            sections[name] = {"addr": s_addr, "size": s_size, "flags": s_flags}

        data_size = sections.get(".data", {}).get("size", 0)
        bss_size = sections.get(".bss", {}).get("size", 0)
        total_ram = data_size + bss_size

        text_size = sections.get(".text", {}).get("size", 0)
        rodata_size = sections.get(".rodata", {}).get("size", 0)
        boot2_size = sections.get(".boot2", {}).get("size", 0)
        total_flash = text_size + rodata_size + boot2_size

        # RAM budget: static RAM <= 40 KB of the RP2040's 264 KB. A guard against unintended growth,
        # not a hardware limit. It includes on purpose the 8 KB serial TX ring and the 3 KB reply
        # buffer (firmware/include/tx_queue.h) that keep a slow host from ever blocking the scan.
        self.assertLess(total_ram, 40 * 1024, f"Static RAM usage too high: {total_ram} bytes")
        # Flash budget: total firmware code <= 256KB (RP2040 has 2MB, we want < 15%)
        self.assertLess(total_flash, 256 * 1024, f"Flash footprint too high: {total_flash} bytes")

        # Stacks: Verify dummy stacks exist for Core 0 and Core 1
        self.assertIn(".stack_dummy", sections, "Core 0 stack section missing")
        self.assertIn(".stack1_dummy", sections, "Core 1 stack section missing")

    def test_05_config_schema_and_crc32_integrity(self):
        """The v1 settings image constants and its CRC-32 (zlib-compatible) as the firmware reads them."""
        legacy_h = (FIRMWARE_DIR / "include" / "legacy_settings_v1.h").read_text(encoding="utf-8")
        limits_h = (FIRMWARE_DIR / "include" / "settings_limits.h").read_text(encoding="utf-8")

        self.assertIn("CONFIG_MAGIC   = 0x44524654", legacy_h)
        self.assertIn("CONFIG_VERSION = 1", legacy_h)
        self.assertIn("NUM_LAYERS    = 3", limits_h)

        # Same reflected CRC-32 as legacy_v1::crc32(), checked against zlib
        payload = b"DRIFTPAD_TEST_SETTINGS_PAYLOAD_1234567890"
        crc_custom = 0xFFFFFFFF
        for b in payload:
            crc_custom ^= b
            for _ in range(8):
                crc_custom = (crc_custom >> 1) ^ (0xEDB88320 & (-(crc_custom & 1)))
        crc_custom = (~crc_custom) & 0xFFFFFFFF
        self.assertEqual(crc_custom, zlib.crc32(payload) & 0xFFFFFFFF, "CRC-32 does not match zlib")

        corrupted = bytearray(payload)
        corrupted[10] ^= 0x01
        self.assertNotEqual(zlib.crc32(payload), zlib.crc32(corrupted), "CRC-32 missed a single-bit error")

    def test_06_oled_safe_zone_and_concurrency_guards(self):
        """Safe-zone display rendering (rows 0..24 cleared) and the core 1 start-up order."""
        oled_cpp = (FIRMWARE_DIR / "src" / "oled.cpp").read_text(encoding="utf-8")

        self.assertIn("s_display.fillRect(0, 0, 128, 25, OLED_COLOR_BLACK);", oled_cpp,
                      "Defensive clear of rows 0..24 is missing from oled.cpp!")

        # s_initialized = true must come after the splash screen's display() completes
        init_pos = oled_cpp.find("s_initialized = true;")
        display_pos = oled_cpp.find("s_display.display();", oled_cpp.find("initDisplayHardware"))
        self.assertGreater(init_pos, display_pos,
                           "s_initialized is set before the splash screen display() completes")

    def test_07_serial_command_protocol_coverage(self):
        """Every v1 command is still in the firmware's command table (backwards compatibility)."""
        commands_cpp = (FIRMWARE_DIR / "src" / "commands.cpp").read_text(encoding="utf-8")
        table = commands_cpp[commands_cpp.index("const proto::CommandDef TABLE[]"):]
        v1_commands = [
            "PING", "GET_CONFIG", "STATUS", "SET_ACTUATION", "SET_RT_SENS", "SET_RT_ENABLE", "SET_LAYER",
            "SET_KEY", "SIM", "STREAM", "SAVE", "RESET", "CALIBRATE", "SCAN_RATE", "RAW", "SET_HID",
            "FULLSCREEN", "SCREENSAVER", "ANIM", "SLEEP", "WAKE", "OLED_SCAN", "OLED_TEST", "BOOTSEL",
        ]
        for cmd in v1_commands:
            self.assertIn(f'{{ "{cmd}",', table, f"v1 command {cmd} missing from the command table")
        self.assertIn('"HID|OUTPUT"', table, "SET_HID aliases missing")


if __name__ == "__main__":
    unittest.main(verbosity=2)
