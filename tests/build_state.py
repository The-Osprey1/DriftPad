"""
build_state.py - Evidence that the firmware artifacts under test were built by THIS test process.

The build test (tests/test_build.py, TC-13) calls `run_build()`, which records when the build
started, how PlatformIO was invoked and what it produced (including the build_manifest.json
written by firmware/scripts/build_info.py when that post-build step exists). Every artifact check
(TC-B1..B4, CH2-01..04) calls `require_fresh_build()` first and then `check_artifact()`, so a
cached firmware.uf2 from an earlier build can never make an artifact test pass:

* no build ran in this process        -> the artifact test FAILS
* the build ran and failed            -> the artifact test FAILS
* the build was skipped (no PlatformIO) -> the artifact test is skipped with that reason
                                           (run_all_tests.py --release turns skips into failures)
* an artifact is older than the build start, or its sha256/size differs from the manifest
                                        -> the artifact test FAILS

Stale artifacts (firmware.elf/.bin/.uf2 and the manifest) are deleted before building, so even an
incremental build has to relink and regenerate them. DRIFTPAD_CLEAN_BUILD=1 additionally runs
`pio run -t clean` first (release qualification and CI use it).

Environment:
  DRIFTPAD_FIRMWARE_DIR      build a different copy of firmware/ (scratch copies while firmware is
                             being edited; release runs refuse it)
  DRIFTPAD_CLEAN_BUILD=1     `pio run -t clean` before building
  DRIFTPAD_RELEASE=1         release gating (set by run_all_tests.py --release): a missing manifest,
                             a dirty build or a build id that does not match git fails
  DRIFTPAD_PIO_PROJECT_CONF  pass `-c <file>` to PlatformIO (CI uses a copy of platformio.ini whose
                             platform line is pinned to the locked commit; see .github/workflows/ci.yml)

The record lives in a holder registered in sys.modules, so it is shared no matter whether this
module was imported as `build_state` or `tests.build_state`.

Pure Python 3 standard library.
"""

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
import types
import unittest
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = TESTS_DIR.parent
REPO_FIRMWARE_DIR = PROJECT_ROOT / "firmware"

ENV_FIRMWARE_DIR = "DRIFTPAD_FIRMWARE_DIR"
ENV_CLEAN = "DRIFTPAD_CLEAN_BUILD"
ENV_RELEASE = "DRIFTPAD_RELEASE"
ENV_PIO_CONF = "DRIFTPAD_PIO_PROJECT_CONF"

PIO_ENV = "pico"
ARTIFACTS = ("firmware.uf2", "firmware.elf", "firmware.bin")
MANIFEST_NAME = "build_manifest.json"
LOG_NAME = "driftpad_build.log"
# Stale artifacts are deleted before the build, so this only absorbs coarse filesystem timestamps
MTIME_TOLERANCE_S = 2.0
MANIFEST_REQUIRED_KEYS = ("fw_version", "protocol", "build_id", "git_commit", "git_dirty", "env", "artifacts")

_HOLDER_KEY = "_driftpad_build_state_holder"
_holder = sys.modules.get(_HOLDER_KEY)
if _holder is None:
    _holder = types.ModuleType(_HOLDER_KEY)
    _holder.record = None
    sys.modules[_HOLDER_KEY] = _holder


# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------

def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def release_mode() -> bool:
    return env_flag(ENV_RELEASE)


def clean_requested() -> bool:
    return env_flag(ENV_CLEAN)


def firmware_dir() -> Path:
    override = os.environ.get(ENV_FIRMWARE_DIR, "").strip()
    return Path(override).resolve() if override else REPO_FIRMWARE_DIR


def using_foreign_firmware_dir() -> bool:
    """True when DRIFTPAD_FIRMWARE_DIR points somewhere other than this repository's firmware/."""
    return firmware_dir() != REPO_FIRMWARE_DIR.resolve()


def build_dir(fw_dir: Optional[Path] = None) -> Path:
    return Path(fw_dir or firmware_dir()) / ".pio" / "build" / PIO_ENV


def project_conf() -> Optional[str]:
    conf = os.environ.get(ENV_PIO_CONF, "").strip()
    return conf or None


def find_platformio(which: Callable[[str], Optional[str]] = shutil.which,
                    has_module: Optional[Callable[[str], bool]] = None) -> Optional[Tuple[List[str], str]]:
    """Returns (argv prefix, description): `pio` from PATH, else `<python> -m platformio`."""
    for name in ("pio", "platformio"):
        path = which(name)
        if path:
            return [path], f"{name} from PATH ({path})"
    if has_module is None:
        def has_module(mod: str) -> bool:
            try:
                return importlib.util.find_spec(mod) is not None
            except (ImportError, ValueError):
                return False
    if has_module("platformio"):
        return [sys.executable, "-m", "platformio"], f"{sys.executable} -m platformio"
    return None


# ----------------------------------------------------------------------------
# git (read-only queries)
# ----------------------------------------------------------------------------

def _git(args: List[str], cwd: Path) -> Optional[str]:
    git = shutil.which("git")
    if git is None or not Path(cwd).is_dir():
        return None
    try:
        r = subprocess.run([git] + args, cwd=str(cwd), capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout if r.returncode == 0 else None


def git_state(path: Path) -> Dict[str, Any]:
    """{'commit': 40-hex or None, 'dirty': bool or None, 'dirty_files': [...]} for the repo holding path."""
    head = _git(["rev-parse", "HEAD"], path)
    if head is None:
        return {"commit": None, "dirty": None, "dirty_files": []}
    status = _git(["status", "--porcelain", "--untracked-files=normal"], path) or ""
    files = [line[3:] for line in status.splitlines() if line.strip()]
    return {"commit": head.strip(), "dirty": bool(files), "dirty_files": files}


# ----------------------------------------------------------------------------
# Record
# ----------------------------------------------------------------------------

@dataclass
class BuildRecord:
    firmware_dir: str
    build_dir: str
    started_at: float
    started_utc: str
    pio_argv: List[str] = field(default_factory=list)
    pio_how: str = ""
    project_conf: Optional[str] = None
    clean: bool = False
    clean_returncode: Optional[int] = None
    removed_stale: List[str] = field(default_factory=list)
    returncode: Optional[int] = None
    success_marker: bool = False
    ok: bool = False
    skipped_reason: Optional[str] = None
    finished_at: Optional[float] = None
    duration_s: Optional[float] = None
    log_path: Optional[str] = None
    output_tail: str = ""
    manifest_path: str = ""
    manifest: Optional[Dict[str, Any]] = None
    manifest_error: Optional[str] = None
    artifacts: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    git: Dict[str, Any] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
    # Issues that block a release (always also listed in warnings in diagnostic runs)
    release_problems: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def current() -> Optional[BuildRecord]:
    return _holder.record


def set_current(record: Optional[BuildRecord]) -> None:
    """Replaces the process-wide record (used by the build test and by tooling unit tests)."""
    _holder.record = record


def _utc(ts: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


# ----------------------------------------------------------------------------
# Build
# ----------------------------------------------------------------------------

def run_build(clean: Optional[bool] = None,
              runner: Callable[..., Any] = subprocess.run,
              pio: Optional[Tuple[List[str], str]] = None,
              fw_dir: Optional[Path] = None,
              clock: Callable[[], float] = time.time) -> BuildRecord:
    """Builds the firmware with PlatformIO and stores the evidence as the current record."""
    fw = Path(fw_dir) if fw_dir else firmware_dir()
    bdir = build_dir(fw)
    clean = clean_requested() if clean is None else clean
    started = clock()
    rec = BuildRecord(firmware_dir=str(fw), build_dir=str(bdir), started_at=started,
                      started_utc=_utc(started), clean=clean,
                      manifest_path=str(bdir / MANIFEST_NAME), project_conf=project_conf())
    set_current(rec)

    found = pio if pio is not None else find_platformio()
    if found is None:
        rec.skipped_reason = ("PlatformIO not found (neither `pio` on PATH nor the `platformio` module "
                              "for this Python); firmware not built")
        return rec
    rec.pio_argv, rec.pio_how = list(found[0]), found[1]
    if not (fw / "platformio.ini").is_file():
        rec.returncode = -1
        rec.output_tail = f"missing {fw / 'platformio.ini'}"
        return rec

    env = dict(os.environ)
    env.setdefault("PLATFORMIO_DISABLE_COLOR", "true")
    conf_args = ["-c", rec.project_conf] if rec.project_conf else []
    log: List[str] = []

    if clean:
        r = runner(rec.pio_argv + ["run", "-e", PIO_ENV, "-t", "clean"] + conf_args, cwd=str(fw),
                   capture_output=True, text=True, env=env)
        rec.clean_returncode = r.returncode
        log += ["$ " + " ".join(rec.pio_argv + ["run", "-t", "clean"] + conf_args),
                r.stdout or "", r.stderr or ""]
        if r.returncode != 0:
            rec.returncode = r.returncode
            rec.output_tail = _tail("\n".join(log))
            return rec

    # Remove whatever an earlier build left so this build must regenerate every artifact
    for name in ARTIFACTS + (MANIFEST_NAME,):
        p = bdir / name
        if p.exists():
            try:
                p.unlink()
                rec.removed_stale.append(name)
            except OSError as e:
                rec.warnings.append(f"could not remove stale {p}: {e}")

    cmd = rec.pio_argv + ["run", "-e", PIO_ENV] + conf_args
    r = runner(cmd, cwd=str(fw), capture_output=True, text=True, env=env)
    rec.finished_at = clock()
    rec.duration_s = round(rec.finished_at - started, 2)
    rec.returncode = r.returncode
    out = (r.stdout or "") + ("\n" + r.stderr if r.stderr else "")
    log += ["$ " + " ".join(cmd), out]
    rec.success_marker = "[SUCCESS]" in out
    rec.ok = r.returncode == 0 and rec.success_marker
    rec.output_tail = _tail(out)
    if bdir.is_dir():
        try:
            (bdir / LOG_NAME).write_text("\n".join(log), encoding="utf-8")
            rec.log_path = str(bdir / LOG_NAME)
        except OSError:
            pass

    rec.git = git_state(fw)
    if rec.ok:
        inspect_artifacts(rec)
        evaluate_manifest(rec)
    return rec


def _tail(text: str, lines: int = 60) -> str:
    return "\n".join(text.splitlines()[-lines:])


def inspect_artifacts(rec: BuildRecord) -> None:
    bdir = Path(rec.build_dir)
    for name in ARTIFACTS:
        p = bdir / name
        if not p.is_file():
            rec.artifacts[name] = {"exists": False}
            continue
        st = p.stat()
        rec.artifacts[name] = {
            "exists": True, "size": st.st_size, "sha256": sha256_file(p), "mtime": st.st_mtime,
            "fresh": st.st_mtime >= rec.started_at - MTIME_TOLERANCE_S,
        }


def load_manifest(path: Path) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    if not Path(path).is_file():
        return None, None
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return None, f"unreadable {MANIFEST_NAME}: {e}"
    if not isinstance(data, dict):
        return None, f"{MANIFEST_NAME} is not a JSON object"
    return data, None


def manifest_consistency_errors(manifest: Dict[str, Any], artifacts: Dict[str, Dict[str, Any]]) -> List[str]:
    """Problems that make a manifest wrong regardless of mode (it must describe these exact files)."""
    errors: List[str] = []
    for key in MANIFEST_REQUIRED_KEYS:
        if key not in manifest:
            errors.append(f"manifest lacks '{key}'")
    listed = manifest.get("artifacts") if isinstance(manifest.get("artifacts"), dict) else {}
    for name in ARTIFACTS:
        entry = listed.get(name)
        info = artifacts.get(name, {})
        if not isinstance(entry, dict):
            errors.append(f"manifest has no entry for {name}")
            continue
        if not info.get("exists"):
            errors.append(f"{name} listed in the manifest but not on disk")
            continue
        if str(entry.get("sha256", "")).lower() != info["sha256"]:
            errors.append(f"{name}: sha256 {info['sha256'][:16]}... does not match manifest "
                          f"{str(entry.get('sha256'))[:16]}...")
        if entry.get("size") != info["size"]:
            errors.append(f"{name}: size {info['size']} does not match manifest {entry.get('size')}")
    commit = manifest.get("git_commit")
    build_id = manifest.get("build_id")
    if isinstance(commit, str) and isinstance(build_id, str) and build_id != "unknown":
        expected = commit[:12] + ("-dirty" if manifest.get("git_dirty") else "")
        if build_id != expected:
            errors.append(f"build_id '{build_id}' inconsistent with git_commit/git_dirty (expected '{expected}')")
    return errors


def evaluate_manifest(rec: BuildRecord) -> None:
    """Loads the manifest and records warnings and release-blocking problems on the record.

    Callers decide what to do with them: diagnostic runs print the warnings, release runs fail on
    any entry in release_problems.
    """
    path = Path(rec.manifest_path)
    manifest, error = load_manifest(path)
    rec.manifest, rec.manifest_error = manifest, error
    if error:
        rec.release_problems.append(error)
        rec.warnings.append(error)
        return
    if manifest is None:
        msg = (f"no {MANIFEST_NAME} after the build (the build_info.py post-build step did not run); "
               "artifact hashes cannot be tied to a build id")
        rec.warnings.append(msg)
        rec.release_problems.append(msg)
        return

    if path.stat().st_mtime < rec.started_at - MTIME_TOLERANCE_S:
        rec.release_problems.append(f"{MANIFEST_NAME} predates this build")
    for e in manifest_consistency_errors(manifest, rec.artifacts):
        rec.release_problems.append(e)

    if manifest.get("git_dirty"):
        rec.warnings.append(f"dirty build: build_id {manifest.get('build_id')} (uncommitted changes)")
        rec.release_problems.append("dirty build (git_dirty=true); a dirty build is never release-qualified")
    if manifest.get("build_id") in (None, "", "unknown"):
        rec.warnings.append("build_id is 'unknown' (no git metadata at build time)")
        rec.release_problems.append("build_id is unknown")
    head = (rec.git or {}).get("commit")
    if head is None:
        rec.warnings.append("firmware directory is not in a git checkout; build_id not compared with git")
        rec.release_problems.append("build_id cannot be verified against git (no git checkout)")
    elif manifest.get("git_commit") != head:
        msg = f"manifest git_commit {manifest.get('git_commit')} != checkout HEAD {head}"
        rec.warnings.append(msg)
        rec.release_problems.append(msg)


# ----------------------------------------------------------------------------
# Assertions used by the artifact tests
# ----------------------------------------------------------------------------

def require_fresh_build(testcase: unittest.TestCase) -> BuildRecord:
    rec = current()
    if rec is None:
        testcase.fail("The firmware build test (TC-13, tests/test_build.py) did not run in this process, "
                      "so these artifacts cannot be shown to come from this run. Run the build suite first "
                      "(tests/run_all_tests.py does), e.g. `python -m unittest tests.test_build`.")
    if rec.skipped_reason:
        raise unittest.SkipTest(f"firmware build skipped in this run: {rec.skipped_reason}")
    if not rec.ok:
        testcase.fail(f"The firmware build in this run failed (exit {rec.returncode}); artifacts not checked.\n"
                      f"{rec.output_tail}")
    if Path(rec.firmware_dir) != firmware_dir():
        testcase.fail(f"The recorded build is of {rec.firmware_dir}, but tests now point at {firmware_dir()}")
    return rec


def check_artifact(testcase: unittest.TestCase, rec: BuildRecord, name: str) -> Path:
    """Asserts `name` exists, was written by this run's build, and matches the manifest (if any)."""
    path = Path(rec.build_dir) / name
    testcase.assertTrue(path.is_file(), f"{name} missing at {path} after this run's build")
    mtime = path.stat().st_mtime
    testcase.assertGreaterEqual(
        mtime, rec.started_at - MTIME_TOLERANCE_S,
        f"{name} (modified {_utc(mtime)}) predates this run's build start ({rec.started_utc}); stale artifact")
    if rec.manifest is not None:
        entry = (rec.manifest.get("artifacts") or {}).get(name)
        testcase.assertIsInstance(entry, dict, f"{MANIFEST_NAME} has no entry for {name}")
        testcase.assertEqual(sha256_file(path), str(entry.get("sha256", "")).lower(),
                             f"{name} sha256 differs from {MANIFEST_NAME}")
    elif release_mode():
        testcase.fail(f"no {MANIFEST_NAME}: {name} cannot be tied to a build id (required for --release)")
    return path


if __name__ == "__main__":
    found = find_platformio()
    print("PlatformIO:", found[1] if found else "not found")
    print("Firmware dir:", firmware_dir())
