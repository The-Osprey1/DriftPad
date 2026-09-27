#!/usr/bin/env python3
"""
check_toolchain.py - Compare the installed PlatformIO toolchain with firmware/toolchain.lock.json

Checks, without downloading or changing anything:
  * PlatformIO Core version
  * the dev-platform (raspberrypi) git commit, repository and version, and that only one copy is
    installed (PlatformIO would otherwise pick between them)
  * the arduino-pico framework commit, `git describe` and package version
  * toolchain-rp2040-earlephilhower version and, for this host, the archive it was installed from
  * pioasm/picotool package versions (tool-scons is reported only)
  * registry libraries in firmware/.pio/libdeps/<env> (exact versions) and the framework's
    built-in libraries (versions from library.properties)
  * firmware/platformio.ini: every registry library pinned to the locked exact version, built-in
    library names that exist in the framework, platform line = locked repository (optionally
    with the locked commit)

Registry libraries are installed by the first `pio run`; before that they are reported as
PENDING (not a failure) unless --require-libs is given.

It can also write a copy of platformio.ini whose platform line carries the locked commit
(--write-pinned-conf PATH). CI builds with that copy (`pio run -c PATH`, DRIFTPAD_PIO_PROJECT_CONF)
because PlatformIO matches an installed VCS platform by its exact URL: the repository's own
platformio.ini keeps the unpinned URL so existing local installs are reused, and a platform
installed with `...git#<commit>` would not match it.

Usage (from the repo root):
    python tools/check_toolchain.py [--require-libs] [--json PATH]
    python tools/check_toolchain.py --write-pinned-conf build/platformio.pinned.ini

Exit code 0 when everything enforced matches, 1 on any MISMATCH/MISSING, 2 on usage errors.
Pure Python 3 standard library.
"""

import argparse
import configparser
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

REPO = Path(__file__).resolve().parent.parent
DEFAULT_LOCK = REPO / "firmware" / "toolchain.lock.json"

OK, MISMATCH, MISSING, PENDING, INFO, WARN = "OK", "MISMATCH", "MISSING", "PENDING", "INFO", "WARN"
FAILING = (MISMATCH, MISSING)


class Row:
    def __init__(self, component: str, expected: Any, found: Any, status: str, note: str = ""):
        self.component = component
        self.expected = "" if expected is None else str(expected)
        self.found = "" if found is None else str(found)
        self.status = status
        self.note = note

    def to_dict(self) -> Dict[str, str]:
        return {"component": self.component, "expected": self.expected, "found": self.found,
                "status": self.status, "note": self.note}


# ----------------------------------------------------------------------------
# Locations and small readers
# ----------------------------------------------------------------------------

def get_systype() -> str:
    """Same naming as PlatformIO's util.get_systype() (e.g. windows_amd64, linux_x86_64)."""
    system = platform.system().lower()
    arch = platform.machine().lower()
    if system == "windows":
        if not arch:
            arch = "x86_" + platform.architecture()[0]
        if "x86" in arch:
            arch = "amd64" if "64" in arch else "x86"
    if arch == "aarch64" and platform.architecture()[0] == "32bit":
        arch = "armv7l"
    return f"{system}_{arch}" if arch else system


def pio_dirs(env=os.environ) -> Dict[str, Path]:
    core = Path(env.get("PLATFORMIO_CORE_DIR") or (Path.home() / ".platformio"))
    return {
        "core": core,
        "platforms": Path(env.get("PLATFORMIO_PLATFORMS_DIR") or core / "platforms"),
        "packages": Path(env.get("PLATFORMIO_PACKAGES_DIR") or core / "packages"),
    }


def read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def read_piopm(pkg_dir: Path) -> Optional[Dict[str, Any]]:
    """PlatformIO package metadata; VCS packages keep it inside their .git directory."""
    for loc in (".git", ".hg", ".svn", ""):
        data = read_json(Path(pkg_dir) / loc / ".piopm")
        if data is not None:
            return data
    return None


def git_head(repo_dir: Path, run: Callable[..., Any] = subprocess.run) -> Optional[str]:
    """HEAD commit of a checkout, read from .git directly (falls back to the git command)."""
    git_dir = Path(repo_dir) / ".git"
    if git_dir.is_file():  # worktree/submodule pointer
        m = re.match(r"gitdir:\s*(.+)", git_dir.read_text(encoding="utf-8", errors="ignore").strip())
        if m:
            git_dir = (Path(repo_dir) / m.group(1)).resolve()
    try:
        head = (git_dir / "HEAD").read_text(encoding="utf-8").strip()
    except OSError:
        head = ""
    if re.fullmatch(r"[0-9a-f]{40}", head):
        return head
    if head.startswith("ref:"):
        ref = head[4:].strip()
        try:
            value = (git_dir / ref).read_text(encoding="utf-8").strip()
            if re.fullmatch(r"[0-9a-f]{40}", value):
                return value
        except OSError:
            pass
        try:
            for line in (git_dir / "packed-refs").read_text(encoding="utf-8").splitlines():
                parts = line.split()
                if len(parts) == 2 and parts[1] == ref and re.fullmatch(r"[0-9a-f]{40}", parts[0]):
                    return parts[0]
        except OSError:
            pass
    return _git_cmd(["rev-parse", "HEAD"], repo_dir, run)


def _git_cmd(args: List[str], repo_dir: Path, run: Callable[..., Any] = subprocess.run) -> Optional[str]:
    git = shutil.which("git")
    if not git or not (Path(repo_dir) / ".git").exists():
        return None
    try:
        r = run([git, "-C", str(repo_dir)] + args, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


def git_remote_url(repo_dir: Path) -> Optional[str]:
    cfg = Path(repo_dir) / ".git" / "config"
    if not cfg.is_file():
        return None
    parser = configparser.RawConfigParser(strict=False)
    try:
        parser.read(cfg, encoding="utf-8")
    except configparser.Error:
        return None
    section = 'remote "origin"'
    return parser.get(section, "url", fallback=None) if parser.has_section(section) else None


def normalize_repo_url(url: Optional[str]) -> str:
    url = (url or "").strip()
    url = re.sub(r"^git\+", "", url).split("#", 1)[0]
    url = re.sub(r"\.git$", "", url.rstrip("/"))
    return url.lower()


def piopm_sha(meta: Optional[Dict[str, Any]]) -> Optional[str]:
    m = re.search(r"\+sha\.([0-9a-f]+)$", str((meta or {}).get("version", "")))
    return m.group(1) if m else None


def platformio_version(run: Callable[..., Any] = subprocess.run) -> Optional[str]:
    cmds = []
    for name in ("pio", "platformio"):
        path = shutil.which(name)
        if path:
            cmds.append([path, "--version"])
    cmds.append([sys.executable, "-m", "platformio", "--version"])
    for cmd in cmds:
        try:
            r = run(cmd, capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.SubprocessError):
            continue
        m = re.search(r"version\s+(\d+\.\d+\.\d+\S*)", (r.stdout or "") + (r.stderr or ""))
        if r.returncode == 0 and m:
            return m.group(1)
    return None


def library_properties(path: Path) -> Dict[str, str]:
    out = {}
    try:
        for line in Path(path).read_text(encoding="utf-8", errors="ignore").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    except OSError:
        pass
    return out


# ----------------------------------------------------------------------------
# platformio.ini
# ----------------------------------------------------------------------------

def read_ini(path: Path) -> configparser.RawConfigParser:
    parser = configparser.RawConfigParser(strict=False, inline_comment_prefixes=(";",))
    parser.read(path, encoding="utf-8")
    return parser


def ini_lib_deps(parser: configparser.RawConfigParser, env: str) -> List[str]:
    raw = parser.get(f"env:{env}", "lib_deps", fallback="")
    return [line.strip() for line in raw.splitlines() if line.strip()]


def parse_lib_dep(spec: str) -> Dict[str, Optional[str]]:
    """'owner/Name @ 1.2.3' -> {owner, name, requirement}; bare names are framework built-ins."""
    m = re.match(r"^(?:(?P<owner>[^/@\s]+)/)?(?P<name>[^@]+?)\s*(?:@\s*(?P<req>.+))?$", spec.strip())
    if not m:
        return {"owner": None, "name": spec.strip(), "requirement": None}
    return {"owner": m.group("owner"), "name": m.group("name").strip(),
            "requirement": m.group("req").strip() if m.group("req") else None}


def pinned_project_conf(ini_text: str, lock: Dict[str, Any]) -> str:
    """platformio.ini text with the env's platform line pinned to the locked commit."""
    repo, commit = lock["platform"]["repo"], lock["platform"]["commit"]
    section = f"[env:{lock.get('env', 'pico')}]"
    out, in_env, replaced = [], False, 0
    for line in ini_text.splitlines(keepends=True):
        stripped = line.strip()
        if stripped.startswith("["):
            in_env = stripped == section
        m = re.match(r"^(\s*platform\s*=\s*)(\S+)(\s*)$", line.rstrip("\r\n"))
        if in_env and m:
            value = m.group(2)
            if normalize_repo_url(value) != normalize_repo_url(repo):
                raise ValueError(f"platform line '{value}' is not the locked repository {repo}")
            if "#" in value and value.split("#", 1)[1] != commit:
                raise ValueError(f"platform line pins {value.split('#', 1)[1]}, lock says {commit}")
            eol = line[len(line.rstrip("\r\n")):]
            line = f"{m.group(1)}{repo}#{commit}{eol}"
            replaced += 1
        out.append(line)
    if replaced != 1:
        raise ValueError(f"expected exactly one platform line in {section}, found {replaced}")
    return "".join(out)


# ----------------------------------------------------------------------------
# Checks
# ----------------------------------------------------------------------------

def check(lock: Dict[str, Any], dirs: Dict[str, Path], firmware_dir: Path,
          pio_version: Optional[str], require_libs: bool = False, systype: Optional[str] = None,
          run: Callable[..., Any] = subprocess.run) -> List[Row]:
    rows: List[Row] = []
    systype = systype or get_systype()
    env = lock.get("env", "pico")

    # PlatformIO Core
    want = lock["platformio_core"]["version"]
    rows.append(Row("PlatformIO Core", want, pio_version or "not found",
                    OK if pio_version == want else (MISSING if pio_version is None else MISMATCH)))

    # Dev-platform
    plat = lock["platform"]
    pdirs = sorted(d for d in dirs["platforms"].glob(plat["name"] + "*")
                   if d.is_dir() and (d.name == plat["name"] or d.name.startswith(plat["name"] + "@")))
    if not pdirs:
        rows.append(Row(f"platform {plat['name']}", plat["commit"], "not installed", MISSING,
                        f"expected in {dirs['platforms']}"))
    else:
        if len(pdirs) > 1:
            rows.append(Row(f"platform {plat['name']} installs", 1, len(pdirs), MISMATCH,
                            "several copies installed: " + ", ".join(d.name for d in pdirs)))
        for d in pdirs:
            rows += _check_vcs_package(f"platform {d.name}", d, plat["repo"], plat["commit"], run)
            manifest = read_json(d / "platform.json") or {}
            rows.append(Row(f"platform {d.name} version", plat["version"], manifest.get("version"),
                            OK if manifest.get("version") == plat["version"] else MISMATCH))

    # Framework
    fw = lock["framework"]
    fdir = dirs["packages"] / fw["package"]
    if not fdir.is_dir():
        rows.append(Row(fw["package"], fw["commit"], "not installed", MISSING,
                        "installed by the first `pio run`"))
    else:
        rows += _check_vcs_package(fw["package"], fdir, fw["repo"], fw["commit"], run)
        pkg = read_json(fdir / "package.json") or {}
        rows.append(Row(f"{fw['package']} package version", fw["package_version"], pkg.get("version"),
                        OK if pkg.get("version") == fw["package_version"] else MISMATCH))
        describe = _git_cmd(["describe", "--tags", "--always"], fdir, run)
        if describe is None:
            rows.append(Row(f"{fw['package']} describe", fw["describe"], "unavailable", INFO,
                            "no git or no tags in the checkout; the commit check above is authoritative"))
        else:
            rows.append(Row(f"{fw['package']} describe", fw["describe"], describe,
                            OK if describe == fw["describe"] else MISMATCH))

    # Toolchain and tools
    tc = lock["toolchain"]
    rows += _check_tool_package(tc["package"], dirs["packages"] / tc["package"], tc["version"],
                                tc.get("archives", {}), systype, True)
    gcc = dirs["packages"] / tc["package"] / "bin" / ("arm-none-eabi-gcc" + (".exe" if os.name == "nt" else ""))
    if gcc.is_file() and tc.get("gcc"):
        try:
            r = run([str(gcc), "--version"], capture_output=True, text=True, timeout=60)
            first = (r.stdout or "").splitlines()[0] if r.stdout else ""
        except (OSError, subprocess.SubprocessError, IndexError):
            first = ""
        rows.append(Row("arm-none-eabi-gcc", tc["gcc"], first or "unreadable",
                        OK if tc["gcc"] in first else MISMATCH))
    for tool in lock.get("tools", []):
        rows += _check_tool_package(tool["package"], dirs["packages"] / tool["package"], tool["version"],
                                    tool.get("archives", {}), systype, tool.get("enforce", True))

    # Registry libraries
    libdeps = Path(firmware_dir) / ".pio" / "libdeps" / env
    installed = {}
    if libdeps.is_dir():
        for d in libdeps.iterdir():
            meta = read_json(d / ".piopm") if d.is_dir() else None
            if meta:
                installed[meta.get("name")] = (meta, d)
    for lib in lock.get("libraries", []):
        label = f"library {lib['owner']}/{lib['name']}"
        if lib["name"] not in installed:
            status = MISSING if require_libs else PENDING
            rows.append(Row(label, lib["version"], "not installed", status,
                            "installed by the first `pio run`" if status == PENDING else f"not in {libdeps}"))
            continue
        meta, _d = installed.pop(lib["name"])
        owner = ((meta.get("spec") or {}).get("owner") or "")
        ok = meta.get("version") == lib["version"] and owner.lower() == lib["owner"].lower()
        rows.append(Row(label, lib["version"], f"{owner}/{meta.get('version')}", OK if ok else MISMATCH))
    for name, (meta, d) in sorted(installed.items(), key=lambda kv: str(kv[0])):
        rows.append(Row(f"library {name}", "not locked", meta.get("version"), WARN,
                        f"extra library in {d}; the LDF may pick it up"))

    # Framework built-in libraries
    if fdir.is_dir():
        for lib in lock.get("framework_libraries", []):
            props = library_properties(fdir / "libraries" / lib["dir"] / "library.properties")
            found = props.get("version")
            rows.append(Row(f"framework library {lib['name']}", lib["version"], found or "missing",
                            OK if found == lib["version"] and props.get("name") == lib["name"] else MISMATCH))

    rows += check_project_ini(lock, Path(firmware_dir) / "platformio.ini", fdir)
    return rows


def _check_vcs_package(label: str, pkg_dir: Path, repo: str, commit: str,
                       run: Callable[..., Any]) -> List[Row]:
    rows = []
    meta = read_piopm(pkg_dir)
    head = git_head(pkg_dir, run) if (pkg_dir / ".git").exists() else None
    sha = piopm_sha(meta)
    if head:
        rows.append(Row(f"{label} commit", commit, head, OK if head == commit else MISMATCH, "git HEAD"))
    elif sha:
        rows.append(Row(f"{label} commit", commit, sha, OK if commit.startswith(sha) else MISMATCH,
                        "from .piopm (no .git checkout)"))
    else:
        rows.append(Row(f"{label} commit", commit, "unknown", MISMATCH, "no .git and no +sha in .piopm"))
    if head and sha and not head.startswith(sha):
        rows.append(Row(f"{label} metadata", head[:len(sha)], sha, MISMATCH,
                        ".piopm revision disagrees with the checkout"))
    remote = git_remote_url(pkg_dir) or ((meta or {}).get("spec") or {}).get("uri")
    if remote:
        rows.append(Row(f"{label} repository", repo, remote,
                        OK if normalize_repo_url(remote) == normalize_repo_url(repo) else MISMATCH))
    return rows


def _check_tool_package(name: str, pkg_dir: Path, version: str, archives: Dict[str, str],
                        systype: str, enforce: bool) -> List[Row]:
    if not pkg_dir.is_dir():
        return [Row(name, version, "not installed", MISSING if enforce else INFO,
                    "installed by the first `pio run`")]
    meta = read_piopm(pkg_dir) or {}
    found = meta.get("version") or (read_json(pkg_dir / "package.json") or {}).get("version")
    status = OK if found == version else (MISMATCH if enforce else INFO)
    rows = [Row(name, version, found, status, "" if enforce else "reported, not enforced")]
    uri = (meta.get("spec") or {}).get("uri")
    if archives:
        want = archives.get(systype)
        if want is None:
            rows.append(Row(f"{name} archive", f"(none locked for {systype})", uri, WARN))
        elif uri:
            rows.append(Row(f"{name} archive", want, uri, OK if uri == want else MISMATCH))
    return rows


def check_project_ini(lock: Dict[str, Any], ini_path: Path, framework_dir: Path) -> List[Row]:
    if not ini_path.is_file():
        return [Row("platformio.ini", str(ini_path), "missing", MISSING)]
    env = lock.get("env", "pico")
    parser = read_ini(ini_path)
    rows = []
    plat = parser.get(f"env:{env}", "platform", fallback="")
    repo, commit = lock["platform"]["repo"], lock["platform"]["commit"]
    if normalize_repo_url(plat) != normalize_repo_url(repo):
        rows.append(Row("platformio.ini platform", repo, plat, MISMATCH))
    elif "#" in plat and plat.split("#", 1)[1] != commit:
        rows.append(Row("platformio.ini platform", f"{repo}#{commit}", plat, MISMATCH))
    else:
        rows.append(Row("platformio.ini platform", repo, plat, OK,
                        "unpinned URL; CI pins the commit via --write-pinned-conf" if "#" not in plat else ""))

    locked = {lib["name"]: lib for lib in lock.get("libraries", [])}
    builtin_names = set()
    if Path(framework_dir).is_dir():
        for props in Path(framework_dir).glob("libraries/*/library.properties"):
            n = library_properties(props).get("name")
            if n:
                builtin_names.add(n)
    for spec in ini_lib_deps(parser, env):
        dep = parse_lib_dep(spec)
        if dep["owner"] or dep["requirement"]:
            lib = locked.get(dep["name"])
            if lib is None:
                rows.append(Row(f"lib_deps {spec}", "(not in lock)", spec, MISMATCH))
            elif dep["requirement"] != lib["version"]:
                rows.append(Row(f"lib_deps {dep['name']}", f"@ {lib['version']} (exact)", spec, MISMATCH,
                                "registry libraries must be pinned to the locked exact version"))
            else:
                rows.append(Row(f"lib_deps {dep['name']}", lib["version"], dep["requirement"], OK))
        elif not builtin_names:
            rows.append(Row(f"lib_deps {spec}", "framework library", "framework not installed", PENDING))
        elif dep["name"] in builtin_names:
            rows.append(Row(f"lib_deps {spec}", "framework library", "present", OK))
        else:
            rows.append(Row(f"lib_deps {spec}", "framework library", "no such library in the framework",
                            MISMATCH, "PlatformIO would look this name up in the registry"))
    return rows


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def print_table(rows: List[Row], out=sys.stdout) -> None:
    w1 = max([len(r.component) for r in rows] + [9])
    w2 = min(max([len(r.expected) for r in rows] + [8]), 48)
    print(f"{'Component':<{w1}}  {'Expected':<{w2}}  {'Status':<8}  Found", file=out)
    print("-" * (w1 + w2 + 30), file=out)
    for r in rows:
        exp = r.expected if len(r.expected) <= w2 else r.expected[:w2 - 3] + "..."
        note = f"  ({r.note})" if r.note else ""
        print(f"{r.component:<{w1}}  {exp:<{w2}}  {r.status:<8}  {r.found}{note}", file=out)


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Compare installed PlatformIO packages with the lock file.")
    ap.add_argument("--lock", default=str(DEFAULT_LOCK), help="lock file (default firmware/toolchain.lock.json)")
    ap.add_argument("--firmware-dir", default=os.environ.get("DRIFTPAD_FIRMWARE_DIR") or str(REPO / "firmware"))
    ap.add_argument("--require-libs", action="store_true",
                    help="treat registry libraries that are not installed yet as MISSING")
    ap.add_argument("--json", metavar="PATH", help="write the result as JSON")
    ap.add_argument("--write-pinned-conf", metavar="PATH",
                    help="write platformio.ini with the platform pinned to the locked commit, then exit")
    args = ap.parse_args(argv)

    lock = read_json(Path(args.lock))
    if lock is None:
        print(f"cannot read lock file {args.lock}", file=sys.stderr)
        return 2
    ini = Path(args.firmware_dir) / "platformio.ini"

    if args.write_pinned_conf:
        try:
            with open(ini, encoding="utf-8", newline="") as f:  # keep the file's line endings
                text = pinned_project_conf(f.read(), lock)
        except (OSError, ValueError) as e:
            print(f"cannot pin {ini}: {e}", file=sys.stderr)
            return 1
        out = Path(args.write_pinned_conf)
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        print(f"wrote {out} (platform pinned to {lock['platform']['commit']})")
        return 0

    dirs = pio_dirs()
    rows = check(lock, dirs, Path(args.firmware_dir), platformio_version(), args.require_libs)
    print(f"Lock file : {args.lock}")
    print(f"PIO home  : {dirs['core']}   host: {get_systype()}")
    print()
    print_table(rows)
    failing = [r for r in rows if r.status in FAILING]
    print()
    print(f"RESULT: {'MISMATCH' if failing else 'OK'} "
          f"({len(failing)} failing, {sum(r.status == PENDING for r in rows)} pending, "
          f"{sum(r.status == WARN for r in rows)} warnings)")
    if args.json:
        doc = {"schema": "driftpad-toolchain-check/1",
               "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "lock": str(args.lock), "systype": get_systype(), "pio_home": str(dirs["core"]),
               "ok": not failing, "rows": [r.to_dict() for r in rows]}
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json).write_text(json.dumps(doc, indent=2), encoding="utf-8")
    return 1 if failing else 0


if __name__ == "__main__":
    sys.exit(main())
