"""
firmware_image.py - Checks a DriftPad firmware image before it is flashed.

* UF2 (https://github.com/microsoft/uf2): every 512-byte block has both start magics and the end
  magic, the RP2040 family id, 256 payload bytes, consistent block numbering, and a target
  address inside the code region: from the start of flash up to the settings slots.
* The code region's end comes from the ELF built with the image (linker symbol _FS_start, the
  first settings slot; docs/flash-layout.md), never from a hardcoded address.
* build_manifest.json (firmware/scripts/build_info.py): the UF2 and ELF are the files it lists
  (sha256 and size).

Pure Python standard library.
"""

import hashlib
import json
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional

UF2_MAGIC_START0 = 0x0A324655
UF2_MAGIC_START1 = 0x9E5D5157
UF2_MAGIC_END = 0x0AB16F30
UF2_FLAG_FAMILY_PRESENT = 0x00002000
UF2_FLAG_NOT_MAIN_FLASH = 0x00000001
RP2040_FAMILY_ID = 0xE48BFF56
FLASH_BASE = 0x10000000
BLOCK_SIZE = 512
PAYLOAD_SIZE = 256


class ImageError(Exception):
    pass


@dataclass
class Uf2Image:
    blocks: int
    start: int          # lowest target address
    end: int            # one past the highest byte written
    family: int


def read_uf2(data: bytes) -> Uf2Image:
    if not data or len(data) % BLOCK_SIZE:
        raise ImageError(f"not a UF2 file: size {len(data)} is not a multiple of {BLOCK_SIZE}")
    count = len(data) // BLOCK_SIZE
    lo, hi, family = None, 0, None
    for n in range(count):
        blk = data[n * BLOCK_SIZE:(n + 1) * BLOCK_SIZE]
        m0, m1, flags, addr, size, blockno, numblocks, fam = struct.unpack_from("<8I", blk, 0)
        (mend,) = struct.unpack_from("<I", blk, BLOCK_SIZE - 4)
        if (m0, m1, mend) != (UF2_MAGIC_START0, UF2_MAGIC_START1, UF2_MAGIC_END):
            raise ImageError(f"block {n}: bad UF2 magic")
        if flags & UF2_FLAG_NOT_MAIN_FLASH:
            raise ImageError(f"block {n}: marked 'not main flash'")
        if not flags & UF2_FLAG_FAMILY_PRESENT or fam != RP2040_FAMILY_ID:
            raise ImageError(f"block {n}: family {fam:#010x} is not RP2040 ({RP2040_FAMILY_ID:#010x})")
        if size != PAYLOAD_SIZE:
            raise ImageError(f"block {n}: payload {size} bytes (RP2040 bootrom expects {PAYLOAD_SIZE})")
        if blockno != n or numblocks != count:
            raise ImageError(f"block {n}: numbered {blockno}/{numblocks}, file has {count} blocks")
        if addr % PAYLOAD_SIZE:
            raise ImageError(f"block {n}: target {addr:#010x} is not 256-byte aligned")
        lo = addr if lo is None else min(lo, addr)
        hi = max(hi, addr + size)
        family = fam
    return Uf2Image(blocks=count, start=lo, end=hi, family=family)


def elf_symbols(data: bytes, names: Iterable[str]) -> Dict[str, int]:
    """Values of the named symbols in a little-endian ELF32 file (as built for the RP2040)."""
    want = set(names)
    if len(data) < 52 or data[:4] != b"\x7fELF" or data[4] != 1 or data[5] != 1:
        raise ImageError("not a little-endian ELF32 file")
    shoff, = struct.unpack_from("<I", data, 0x20)
    shentsize, shnum, _shstrndx = struct.unpack_from("<HHH", data, 0x2E)
    if shentsize < 40 or shoff > len(data) or shnum * shentsize > len(data) - shoff:
        raise ImageError("ELF section table is truncated or malformed")
    sections = []
    for i in range(shnum):
        sh = struct.unpack_from("<10I", data, shoff + i * shentsize)
        sections.append({"type": sh[1], "offset": sh[4], "size": sh[5], "link": sh[6], "entsize": sh[9]})
    found: Dict[str, int] = {}
    for sec in sections:
        if sec["type"] != 2:           # SHT_SYMTAB
            continue
        if sec["link"] >= len(sections):
            raise ImageError("ELF symbol table has an invalid string-table index")
        strtab = sections[sec["link"]]
        if strtab["type"] != 3 or strtab["offset"] > len(data) or strtab["size"] > len(data) - strtab["offset"]:
            raise ImageError("ELF symbol table has a truncated or invalid string table")
        if sec["offset"] > len(data) or sec["size"] > len(data) - sec["offset"]:
            raise ImageError("ELF symbol table is truncated")
        entsize = sec["entsize"] or 16
        if entsize < 16 or sec["size"] % entsize:
            raise ImageError("ELF symbol table has a malformed entry size")
        for off in range(sec["offset"], sec["offset"] + sec["size"], entsize):
            st_name, st_value = struct.unpack_from("<II", data, off)
            if st_name >= strtab["size"]:
                raise ImageError("ELF symbol name is outside the string table")
            start = strtab["offset"] + st_name
            limit = strtab["offset"] + strtab["size"]
            end = data.find(b"\0", start, limit)
            if end < 0:
                raise ImageError("ELF symbol name is not NUL-terminated")
            name = data[start:end].decode("ascii", "replace")
            if name in want:
                found[name] = st_value
    return found


def sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


@dataclass
class CheckedImage:
    uf2: Path
    image: Uf2Image
    code_end: Optional[int]
    manifest: Dict
    problems: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems


def check_image(uf2: Path, elf: Optional[Path], manifest_path: Optional[Path],
                allow_dirty: bool = False) -> CheckedImage:
    problems: List[str] = []
    warnings: List[str] = []
    try:
        image = read_uf2(Path(uf2).read_bytes())
    except (OSError, ImageError) as e:
        return CheckedImage(Path(uf2), Uf2Image(0, 0, 0, 0), None, {}, [f"{uf2}: {e}"])

    code_end = None
    if elf is None or not Path(elf).is_file():
        problems.append("no firmware.elf next to the image: the settings sectors cannot be located, "
                        "so the image cannot be shown to leave them alone")
    else:
        try:
            syms = elf_symbols(Path(elf).read_bytes(), ["_FS_start", "_EEPROM_start"])
            code_end = syms.get("_FS_start")
            if code_end is None:
                problems.append(f"{elf}: no _FS_start symbol (settings slots not reserved in this build)")
        except (OSError, ImageError, struct.error, ValueError, IndexError) as e:
            problems.append(f"{elf}: {e}")
    if image.start < FLASH_BASE:
        problems.append(f"image starts at {image.start:#010x}, below flash ({FLASH_BASE:#010x})")
    if code_end is not None and image.end > code_end:
        problems.append(f"image ends at {image.end:#010x}, inside the settings sectors (from {code_end:#010x}): "
                        "flashing it would erase the stored settings and calibration")

    manifest: Dict = {}
    if manifest_path is None or not Path(manifest_path).is_file():
        problems.append("no build_manifest.json: the pad cannot be verified after the update")
    else:
        manifest = {}
        try:
            value = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                raise ValueError("manifest must be a JSON object")
            manifest = value
        except (OSError, ValueError) as e:
            problems.append(f"{manifest_path}: {e}")
        if not isinstance(manifest.get("artifacts"), dict):
            problems.append("the manifest has no valid artifacts object")
            arts = {}
        else:
            arts = manifest["artifacts"]
        if manifest:
            for path in [p for p in (uf2, elf) if p is not None and Path(p).is_file()]:
                entry = arts.get(Path(path).name)
                if not isinstance(entry, dict):
                    problems.append(f"the manifest does not list {Path(path).name}")
                    continue
                expected_hash = entry.get("sha256")
                expected_size = entry.get("size")
                actual_size = Path(path).stat().st_size
                if not isinstance(expected_hash, str) or expected_hash != sha256(path):
                    problems.append(f"{Path(path).name} is not the file the manifest describes (sha256 differs): "
                                    "rebuild, or flash the files of one build together")
                if not isinstance(expected_size, int) or isinstance(expected_size, bool) or expected_size != actual_size:
                    problems.append(f"{Path(path).name} size does not match the build manifest")
            for key in ("fw_version", "build_id", "protocol"):
                if not manifest.get(key):
                    problems.append(f"the manifest has no {key}")
            if manifest.get("git_dirty"):
                (warnings if allow_dirty else problems).append(
                    f"build {manifest.get('build_id')} was made from uncommitted changes"
                    + ("" if allow_dirty else " (pass --allow-dirty for a development build)"))
    return CheckedImage(Path(uf2), image, code_end, manifest, problems, warnings)
