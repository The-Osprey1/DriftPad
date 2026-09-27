"""
test_flash_layout.py - The settings flash region, verified against the build's actual layout.

Scope: build artifacts. Reads the linker symbols from the freshly built firmware.elf (pure-Python
ELF32 symbol table reader), the processed linker script, and the UF2 block addresses, and checks
the reservation that the A/B settings store relies on (docs/flash-layout.md):

- slot A and slot B are two whole, 4 KB-aligned flash sectors (independently erasable);
- the linker's FLASH region for code ends exactly where they begin, so code can never grow into
  them (the link fails first);
- the legacy v1 EEPROM sector follows them and is the last sector of flash;
- the firmware image and the UF2 written by an update never touch any of the three sectors;
- no firmware source hardcodes a flash address (everything goes through the linker symbols).

Requires the build from tests/test_build.py in the same run (tests/build_state.py).
"""

import re
import struct
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import build_state

XIP_BASE = 0x10000000
SECTOR = 4096
PICO_FLASH_BYTES = 2 * 1024 * 1024


def elf_symbols(path: Path) -> dict:
    """Name -> value for every symbol in an ELF32 little-endian file."""
    data = path.read_bytes()
    if data[:4] != b"\x7fELF" or data[4] != 1 or data[5] != 1:
        raise AssertionError(f"{path} is not a little-endian ELF32 file")
    e_shoff, = struct.unpack_from("<I", data, 0x20)
    e_shentsize, e_shnum = struct.unpack_from("<HH", data, 0x2E)
    sections = []
    for i in range(e_shnum):
        off = e_shoff + i * e_shentsize
        name, stype, flags, addr, offset, size, link, info, align, entsize = struct.unpack_from("<10I", data, off)
        sections.append((stype, offset, size, link, entsize))
    out = {}
    for stype, offset, size, link, entsize in sections:
        if stype != 2:          # SHT_SYMTAB
            continue
        str_off = sections[link][1]
        for i in range(size // entsize):
            st_name, st_value, st_size, st_info, st_other, st_shndx = struct.unpack_from(
                "<IIIBBH", data, offset + i * entsize)
            end = data.index(b"\0", str_off + st_name)
            out[data[str_off + st_name:end].decode("ascii", "replace")] = st_value
    return out


def elf_load_ranges(path: Path):
    """(start, end) of every PT_LOAD segment's file image by load (physical) address."""
    data = path.read_bytes()
    e_phoff, = struct.unpack_from("<I", data, 0x1C)
    e_phentsize, e_phnum = struct.unpack_from("<HH", data, 0x2A)
    ranges = []
    for i in range(e_phnum):
        p_type, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, p_flags, p_align = struct.unpack_from(
            "<8I", data, e_phoff + i * e_phentsize)
        if p_type == 1 and p_filesz > 0:
            ranges.append((p_paddr, p_paddr + p_filesz))
    return ranges


class TestFlashLayout(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.build_dir = build_state.firmware_dir() / ".pio" / "build" / "pico"

    def setUp(self):
        rec = build_state.require_fresh_build(self)
        self.elf = build_state.check_artifact(self, rec, "firmware.elf")
        self.uf2 = build_state.check_artifact(self, rec, "firmware.uf2")
        self.syms = elf_symbols(self.elf)

    def test_slots_are_two_whole_aligned_sectors_before_the_legacy_sector(self):
        fs_start, fs_end, eeprom = self.syms["_FS_start"], self.syms["_FS_end"], self.syms["_EEPROM_start"]
        self.assertEqual(fs_start % SECTOR, 0, "slot A must start on a sector boundary")
        self.assertEqual(fs_end - fs_start, 2 * SECTOR, "exactly two 4 KB sectors are reserved")
        self.assertEqual(eeprom, fs_end, "the legacy EEPROM sector follows the slots")
        self.assertEqual(eeprom + SECTOR, XIP_BASE + PICO_FLASH_BYTES, "the legacy sector is the last one")

    def test_linker_code_region_ends_at_the_slots(self):
        ld = (self.build_dir / "memmap_default.ld").read_text(encoding="utf-8", errors="replace")
        m = re.search(r"FLASH\(rx\)\s*:\s*ORIGIN\s*=\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*LENGTH\s*=\s*(0x[0-9a-fA-F]+|\d+)", ld)
        self.assertIsNotNone(m, "FLASH region not found in the processed linker script")
        origin, length = int(m.group(1), 0), int(m.group(2), 0)
        self.assertEqual(origin + length, self.syms["_FS_start"],
                         "code may only occupy flash below the settings sectors")

    def test_firmware_image_and_update_never_touch_the_settings_sectors(self):
        protected = (self.syms["_FS_start"], self.syms["_EEPROM_start"] + SECTOR)
        for start, end in elf_load_ranges(self.elf):
            if start >= XIP_BASE and start < XIP_BASE + PICO_FLASH_BYTES:
                self.assertLessEqual(end, protected[0], f"ELF segment {start:#x}-{end:#x} reaches the settings")
        data = self.uf2.read_bytes()
        for off in range(0, len(data), 512):
            addr, size = struct.unpack_from("<II", data, off + 12)
            self.assertTrue(addr + size <= protected[0] or addr >= protected[1],
                            f"UF2 block at {addr:#x} would overwrite the settings region")

    def test_no_source_hardcodes_a_flash_address(self):
        root = build_state.firmware_dir()
        offenders = []
        for p in list((root / "src").glob("*.cpp")) + list((root / "include").glob("*.h")):
            for n, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if re.search(r"0x10[0-9a-fA-F]{6}\b", line) and "XIP_BASE" not in line:
                    offenders.append(f"{p.name}:{n}: {line.strip()}")
        self.assertEqual(offenders, [], "flash addresses must come from the linker symbols")


if __name__ == "__main__":
    unittest.main(verbosity=2)
