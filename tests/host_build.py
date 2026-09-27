"""
host_build.py - Compile firmware sources for the host so tests can run the production C++.

Compiler discovery order:
  1. $CXX (a path or a command name)
  2. g++, clang++, c++ on PATH
  3. zig's bundled clang via the `ziglang` Python package (`python -m ziglang c++`)

Builds are cached under tests/.host_build/ keyed by a hash of every source/header that can
affect them plus the flags, so repeated runs are fast and a DLL that is still loaded by another
test process is never overwritten.

When no compiler exists, `require_compiler()` raises unittest.SkipTest with a clear reason. The
release runner (run_all_tests.py --release) treats such skips as failures.

Pure Python standard library.
"""

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = TESTS_DIR.parent
FIRMWARE_DIR = PROJECT_ROOT / "firmware"
FIRMWARE_INCLUDE = FIRMWARE_DIR / "include"
FIRMWARE_SRC = FIRMWARE_DIR / "src"
HOST_DIR = TESTS_DIR / "firmware_host"
CACHE_DIR = TESTS_DIR / ".host_build"

# arduino-pico sources that keyboard tests compile unmodified (present once PlatformIO has
# installed the framework for the firmware build; DRIFTPAD_ARDUINO_PICO overrides the location).
FRAMEWORK_DIR = Path(os.environ.get("DRIFTPAD_ARDUINO_PICO") or
                     Path(os.path.expanduser("~")) / ".platformio" / "packages" / "framework-arduinopico")
HID_KEYBOARD_SRC = FRAMEWORK_DIR / "libraries" / "HID_Keyboard" / "src"
KEYBOARD_SRC = FRAMEWORK_DIR / "libraries" / "Keyboard" / "src"
TUSB_HID_SRC = FRAMEWORK_DIR / "libraries" / "tusb-hid" / "src"
USB_HOST_STUBS = Path(__file__).resolve().parent / "firmware_host" / "usb_host"
NO_FRAMEWORK_REASON = (
    f"arduino-pico framework not found at {FRAMEWORK_DIR} (run a PlatformIO build once, or set "
    "DRIFTPAD_ARDUINO_PICO); keyboard library tests not run"
)


def require_keyboard_library() -> None:
    for d in (HID_KEYBOARD_SRC, KEYBOARD_SRC, TUSB_HID_SRC):
        if not d.is_dir():
            raise unittest.SkipTest(NO_FRAMEWORK_REASON)


def keyboard_library_sources() -> List[Path]:
    """The unmodified arduino-pico Keyboard stack compiled into keyboard host tests."""
    require_keyboard_library()
    return [KEYBOARD_SRC / "Keyboard.cpp", HID_KEYBOARD_SRC / "HID_Keyboard.cpp",
            HID_KEYBOARD_SRC / "KeyboardLayout_en_US.cpp"]


def keyboard_include_dirs(firmware_include: Optional[Path] = None) -> List[Path]:
    """Host stubs, fake USB headers, firmware headers, then the real library headers."""
    inc = [HOST_DIR, USB_HOST_STUBS]
    if firmware_include is not None:
        inc.append(firmware_include)
    inc += [FIRMWARE_INCLUDE, KEYBOARD_SRC, HID_KEYBOARD_SRC, TUSB_HID_SRC]
    return inc

NO_COMPILER_REASON = (
    "No host C++ compiler found (set CXX, install g++/clang++, or `pip install ziglang`); "
    "compiled firmware tests not run"
)

_compiler: Optional[Tuple[List[str], str]] = None
_compiler_searched = False


def find_compiler() -> Optional[Tuple[List[str], str]]:
    """Returns (argv prefix, kind) or None. kind is 'gcc', 'clang' or 'zig'."""
    global _compiler, _compiler_searched
    if _compiler_searched:
        return _compiler
    _compiler_searched = True

    candidates = []
    env_cxx = os.environ.get("CXX")
    if env_cxx:
        candidates.append(env_cxx)
    candidates += ["g++", "clang++", "c++"]
    for c in candidates:
        path = shutil.which(c)
        if path:
            kind = "clang" if "clang" in Path(path).name else "gcc"
            if Path(path).suffix.lower() in (".cmd", ".bat"):
                kind = "zig" if "zig" in Path(path).name.lower() else kind
            _compiler = ([path], kind)
            return _compiler

    try:
        import importlib.util
        if importlib.util.find_spec("ziglang") is not None:
            _compiler = ([sys.executable, "-m", "ziglang", "c++"], "zig")
            return _compiler
    except (ImportError, ValueError):
        pass
    return None


def require_compiler() -> Tuple[List[str], str]:
    found = find_compiler()
    if found is None:
        raise unittest.SkipTest(NO_COMPILER_REASON)
    return found


def compiler_description() -> str:
    found = find_compiler()
    if found is None:
        return "none"
    argv, kind = found
    return f"{kind}: {' '.join(argv)}"


def _base_flags(kind: str, shared: bool) -> List[str]:
    flags = [
        "-std=c++17", "-O1", "-g0",
        # RP2040 (Cortex-M0+) has no FMA; keep host float maths unfused to match
        "-ffp-contract=off",
        "-DDRIFTPAD_HOST_BUILD=1",
        "-Wall", "-Wno-unused-function", "-Wno-unused-variable",
    ]
    if kind in ("zig", "clang"):
        flags += ["-Wno-nullability-completeness", "-Wno-nullability-extension",
                  "-Wno-unknown-warning-option"]
    if kind == "zig" and os.name == "nt":
        flags += ["-target", "x86_64-windows-gnu"]
    if shared:
        flags += ["-shared"]
        if os.name != "nt":
            flags += ["-fPIC"]
        # Windows: MinGW exports every global symbol of the DLL (the C ABI test hooks) as long as
        # no object uses __declspec(dllexport); host fakes must not use it
    if kind == "gcc" and os.name == "nt":
        flags += ["-static-libgcc", "-static-libstdc++"]
    return flags


def _hash_inputs(sources: Sequence[Path], include_dirs: Sequence[Path], flags: Sequence[str]) -> str:
    h = hashlib.sha256()
    for f in flags:
        h.update(f.encode())
        h.update(b"\0")
    files = set(Path(s).resolve() for s in sources)
    for d in include_dirs:
        d = Path(d)
        if d.is_dir():
            for p in d.rglob("*"):
                if p.suffix in (".h", ".hpp", ".inc", ".cpp", ".c"):
                    files.add(p.resolve())
    for p in sorted(files):
        h.update(str(p).encode())
        h.update(b"\0")
        try:
            h.update(p.read_bytes())
        except OSError:
            h.update(b"<missing>")
    return h.hexdigest()[:20]


def build(name: str,
          sources: Iterable[Path],
          include_dirs: Iterable[Path] = (),
          defines: Iterable[str] = (),
          extra_flags: Iterable[str] = (),
          shared: bool = True) -> Path:
    """Compiles `sources` into a shared library (default) or executable and returns its path.

    Raises unittest.SkipTest when no compiler exists and AssertionError on a compile error
    (a compile failure is a real regression, not a missing tool).
    """
    argv, kind = require_compiler()
    sources = [Path(s) for s in sources]
    include_dirs = [Path(d) for d in include_dirs]
    for s in sources:
        if not s.is_file():
            raise AssertionError(f"host build {name}: source not found: {s}")

    flags = _base_flags(kind, shared)
    flags += [f"-D{d}" for d in defines]
    flags += list(extra_flags)
    for d in include_dirs:
        flags += ["-I", str(d)]

    digest = _hash_inputs(sources, include_dirs, flags + argv)
    if shared:
        suffix = ".dll" if os.name == "nt" else (".dylib" if sys.platform == "darwin" else ".so")
    else:
        suffix = ".exe" if os.name == "nt" else ""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    out = CACHE_DIR / f"{name}-{digest}{suffix}"
    if out.is_file():
        return out

    fd, tmp = tempfile.mkstemp(prefix=f"{name}-", suffix=suffix, dir=str(CACHE_DIR))
    os.close(fd)
    cmd = argv + flags + [str(s) for s in sources] + ["-o", tmp]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise AssertionError(
            f"Host build '{name}' failed ({compiler_description()}):\n{' '.join(cmd)}\n"
            f"{result.stdout}\n{result.stderr}"
        )
    try:
        os.replace(tmp, out)
    except OSError:
        # Another process produced the same artifact first; use it.
        try:
            os.remove(tmp)
        except OSError:
            pass
    # zig/clang on Windows may leave a .pdb/.lib next to the temp name; tidy up quietly
    for extra in (".lib", ".pdb", ".exp"):
        stale = Path(tmp).with_suffix(extra)
        if stale.exists():
            try:
                stale.unlink()
            except OSError:
                pass
    return out


# The last commit before the productisation work. Defect-reproduction tests compile its firmware
# files to show that each regression scenario fails on the pre-fix implementation.
PREFIX_REVISION = "e2031e2"


def revision_files(revision: str, paths: Sequence[str]) -> Path:
    """Writes `git show <revision>:<path>` for each repo-relative path under a cache directory and
    returns that directory (same relative layout). SkipTest when git or the revision is missing
    (e.g. a shallow clone)."""
    root = CACHE_DIR / f"rev-{revision}"
    for rel in paths:
        dest = root / rel
        if dest.is_file():
            continue
        try:
            result = subprocess.run(["git", "show", f"{revision}:{rel}"], cwd=str(PROJECT_ROOT),
                                    capture_output=True)
        except OSError as e:
            raise unittest.SkipTest(f"git not available ({e}); pre-fix revision {revision} not checked")
        if result.returncode != 0:
            raise unittest.SkipTest(
                f"revision {revision} not in this clone ({result.stderr.decode(errors='replace').strip()}); "
                "fetch full history to run the defect-reproduction tests")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(result.stdout)
    return root


def firmware_sources(*names: str) -> List[Path]:
    return [FIRMWARE_SRC / n for n in names]


def host_sources(*names: str) -> List[Path]:
    return [HOST_DIR / n for n in names]


def default_include_dirs() -> List[Path]:
    # Host stubs first so <Arduino.h>/<Keyboard.h> resolve to the fakes
    return [HOST_DIR, FIRMWARE_INCLUDE]


if __name__ == "__main__":
    print("Host C++ compiler:", compiler_description())
