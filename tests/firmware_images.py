"""
firmware_images.py - Synthetic firmware builds for the tooling tests (not a test module).

A build directory holds firmware.uf2 (valid RP2040 UF2 blocks), firmware.elf (a minimal ELF32 with
the linker symbols firmware_image.py reads) and build_manifest.json (the files' sha256 and the
build identity), like the one PlatformIO leaves in firmware/.pio/build/pico/.
"""

import hashlib
import json
import struct
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import firmware_image as fimg   # noqa: E402

FS_START = 0x101FD000
NEW = {"fw_version": "2.1.0", "build_id": "c0ffee123456", "protocol": 2}


def uf2_blocks(start=0x10000000, count=8, family=fimg.RP2040_FAMILY_ID, corrupt=None):
    out = bytearray()
    for n in range(count):
        blk = bytearray(512)
        struct.pack_into("<8I", blk, 0, fimg.UF2_MAGIC_START0, fimg.UF2_MAGIC_START1,
                         fimg.UF2_FLAG_FAMILY_PRESENT, start + n * 256, 256, n, count, family)
        struct.pack_into("<I", blk, 508, fimg.UF2_MAGIC_END)
        out += blk
    if corrupt == "magic":
        out[0] ^= 0xFF
    if corrupt == "numbering":
        struct.pack_into("<I", out, 512 + 20, 7)
    return bytes(out)


def elf_with(symbols):
    """A minimal little-endian ELF32 with a symbol table (enough for firmware_image.elf_symbols)."""
    strtab = b"\0"
    syms = [b"\0" * 16]
    for name, value in symbols.items():
        syms.append(struct.pack("<IIIBBH", len(strtab), value, 0, 0, 0, 1))
        strtab += name.encode() + b"\0"
    symtab = b"".join(syms)
    header_size, shentsize = 52, 40
    sym_off = header_size
    str_off = sym_off + len(symtab)
    sh_off = str_off + len(strtab)
    ident = b"\x7fELF" + bytes([1, 1, 1]) + b"\0" * 9
    header = ident + struct.pack("<HHIIIIIHHHHHH", 2, 40, 1, 0, 0, sh_off, 0, header_size, 0, 0, shentsize, 3, 0)
    sections = [b"\0" * 40,
                struct.pack("<10I", 0, 2, 0, 0, sym_off, len(symtab), 2, 1, 4, 16),
                struct.pack("<10I", 0, 3, 0, 0, str_off, len(strtab), 0, 0, 1, 0)]
    return header + symtab + strtab + b"".join(sections)


def make_build(root: Path, uf2=None, fs_start=FS_START, manifest_extra=None, elf=True, tamper=False):
    root.mkdir(parents=True, exist_ok=True)
    (root / "firmware.uf2").write_bytes(uf2 if uf2 is not None else uf2_blocks())
    if elf:
        (root / "firmware.elf").write_bytes(elf_with({"_FS_start": fs_start, "_EEPROM_start": fs_start + 0x2000}))
    arts = {}
    for name in ("firmware.uf2", "firmware.elf"):
        p = root / name
        if p.is_file():
            arts[name] = {"sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "size": p.stat().st_size}
    manifest = dict(NEW, git_dirty=False, env="pico", artifacts=arts)
    manifest.update(manifest_extra or {})
    (root / "build_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    if tamper:
        (root / "firmware.uf2").write_bytes(uf2_blocks(count=9))
    return root / "firmware.uf2"
