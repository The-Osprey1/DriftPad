#!/usr/bin/env python3
"""
qualify_release.py - Decide whether this checkout can be released, and assemble its files.

Nothing is tagged, pushed, uploaded or published. The result is a local directory
dist/driftpad-<version>-<build>/ and an exit status.

Steps (the first failure stops the run; every step is reported):
  1. git      a commit with a clean working tree (no modified or untracked files)
  2. version  DRIFTPAD_FW_VERSION (firmware/include/build_info.h) is x.y.z[-pre] and CHANGELOG.md has
              a "## <version>" section
  3. toolchain  tools/check_toolchain.py --require-libs: every locked input installed as locked
  4. tests    tests/run_all_tests.py --release --clean: a fresh build, every suite, no skips
  5. image    tools/firmware_image.py on that build: RP2040 UF2 outside the settings sectors, the
              manifest's files, built from this commit and not dirty
  6. bundle   firmware.uf2/.elf/.bin, build_manifest.json, the test and toolchain reports, the
              configurator (without its tests), RELEASE.md and SHA256SUMS

Software qualification is not hardware acceptance. RELEASE.md says "hardware acceptance pending"
unless --acceptance names a completed record for exactly this build (docs/hardware-acceptance.md,
tools/acceptance_record.py); only then is the bundle marked ready for external beta.

Usage (from the repository root):
    python tools/qualify_release.py [--acceptance PATH] [--dist DIR] [--keep-going]
Exit status: 0 qualified, 1 not qualified, 2 usage error.
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import firmware_image as fimg   # noqa: E402
import acceptance_record         # noqa: E402

BUILD_DIR = REPO / "firmware" / ".pio" / "build" / "pico"
SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$")


@dataclass
class Step:
    name: str
    ok: bool
    detail: str
    data: Dict[str, Any] = field(default_factory=dict)


def _run(cmd: List[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, encoding="utf-8", errors="replace")


class Qualifier:
    def __init__(self, repo: Path = REPO, run: Callable[..., Any] = _run, out: Callable[[str], None] = print,
                 python: str = sys.executable, build_dir: Path = BUILD_DIR):
        self.repo = Path(repo)
        self.build_dir = Path(build_dir)
        self.run = run
        self.out = out
        self.python = python
        self.steps: List[Step] = []
        self.work = self.repo / "dist" / ".qualify"

    def record(self, step: Step) -> bool:
        self.steps.append(step)
        self.out(f"[{'PASS' if step.ok else 'FAIL'}] {step.name}: {step.detail}")
        return step.ok

    # ---- steps
    def git(self) -> bool:
        head = self.run(["git", "rev-parse", "HEAD"], self.repo)
        if head.returncode != 0:
            return self.record(Step("git", False, "not a git checkout"))
        status = self.run(["git", "status", "--porcelain", "--untracked-files=all"], self.repo)
        dirty = [l for l in status.stdout.splitlines() if l.strip()]
        commit = head.stdout.strip()
        if dirty:
            return self.record(Step("git", False, f"{len(dirty)} uncommitted or untracked path(s), e.g. {dirty[0][3:]}",
                                    {"commit": commit, "dirty": dirty}))
        return self.record(Step("git", True, f"clean at {commit[:12]}", {"commit": commit}))

    def version(self) -> bool:
        header = (self.repo / "firmware" / "include" / "build_info.h").read_text(encoding="utf-8")
        m = re.search(r'^#define DRIFTPAD_FW_VERSION "([^"]+)"', header, re.M)
        version = m.group(1) if m else None
        if not version or not SEMVER.match(version):
            return self.record(Step("version", False, f"firmware version {version!r} is not x.y.z[-pre]"))
        changelog = self.repo / "CHANGELOG.md"
        text = changelog.read_text(encoding="utf-8") if changelog.is_file() else ""
        if not re.search(rf"^## \[?{re.escape(version)}\]?(\s|$)", text, re.M):
            return self.record(Step("version", False, f"CHANGELOG.md has no '## {version}' section", {"version": version}))
        return self.record(Step("version", True, version, {"version": version}))

    def toolchain(self) -> bool:
        report = self.work / "toolchain.json"
        r = self.run([self.python, "tools/check_toolchain.py", "--require-libs", "--json", str(report)], self.repo)
        data = json.loads(report.read_text(encoding="utf-8")) if report.is_file() else {}
        ok = r.returncode == 0 and data.get("ok") is True
        failing = [row["component"] for row in data.get("rows", []) if row.get("status") in ("MISMATCH", "MISSING")]
        return self.record(Step("toolchain", ok, "matches firmware/toolchain.lock.json" if ok
                                else f"does not match the lock ({', '.join(failing) or 'see output'})", {"report": str(report)}))

    def tests(self) -> bool:
        report = self.work / "test-results.json"
        r = self.run([self.python, "tests/run_all_tests.py", "--release", "--clean", "--json", str(report)], self.repo)
        data = json.loads(report.read_text(encoding="utf-8")) if report.is_file() else {}
        ok = r.returncode == 0 and data.get("verdict") == "RELEASE_CHECKS_PASSED"
        c = data.get("counts", {})
        detail = (f"{c.get('passed', 0)}/{c.get('planned', 0)} passed, {c.get('skipped', 0)} skipped" if data
                  else "no report written")
        if not ok and data.get("release_problems"):
            detail += "; " + "; ".join(data["release_problems"][:3])
        return self.record(Step("tests", ok, detail, {"report": str(report)}))

    def image(self, commit: str) -> bool:
        b = self.build_dir
        checked = fimg.check_image(b / "firmware.uf2", b / "firmware.elf", b / "build_manifest.json", allow_dirty=False)
        problems = list(checked.problems)
        if checked.manifest and checked.manifest.get("git_commit") != commit:
            problems.append(f"built from {checked.manifest.get('git_commit')}, HEAD is {commit}")
        return self.record(Step("image", not problems, "; ".join(problems) or
                                f"fw {checked.manifest.get('fw_version')} build {checked.manifest.get('build_id')}",
                                {"manifest": checked.manifest}))

    def bundle(self, dist: Path, manifest: Dict[str, Any], acceptance: Optional[Path]) -> bool:
        name = f"driftpad-{manifest['fw_version']}-{manifest['build_id']}"
        out = Path(dist) / name
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        for f in ("firmware.uf2", "firmware.elf", "firmware.bin", "build_manifest.json"):
            shutil.copy2(self.build_dir / f, out / f)
        for f in ("test-results.json", "toolchain.json"):
            shutil.copy2(self.work / f, out / f)
        shutil.copytree(self.repo / "configurator", out / "configurator", ignore=shutil.ignore_patterns("tests"))
        accepted, note = self.acceptance_status(acceptance, manifest)
        if acceptance is not None and accepted:
            shutil.copy2(acceptance, out / "hardware-acceptance.json")
        (out / "RELEASE.md").write_text(self.release_notes(manifest, accepted, note), encoding="utf-8")
        sums = []
        for p in sorted(out.rglob("*")):
            if p.is_file():
                sums.append(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(out).as_posix()}")
        (out / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")
        return self.record(Step("bundle", True, f"{out} ({'ready for external beta' if accepted else note})",
                                {"path": str(out), "beta_ready": accepted}))

    def acceptance_status(self, path: Optional[Path], manifest: Dict[str, Any]):
        """(accepted, note): accepted only for a complete, signed record of this build against the
        current procedure (acceptance_record.evaluate)."""
        if path is None:
            return False, "hardware acceptance pending"
        try:
            rec = json.loads(Path(path).read_text(encoding="utf-8"))
            items = acceptance_record.doc_items(self.repo / "docs" / "hardware-acceptance.md")
        except (OSError, ValueError) as e:
            return False, f"hardware acceptance record unreadable ({e})"
        ok, problems = acceptance_record.evaluate(rec, manifest, items)
        if not ok:
            return False, f"hardware acceptance incomplete ({len(problems)} open: {'; '.join(problems[:3])})"
        return True, "hardware acceptance complete"

    def release_notes(self, manifest: Dict[str, Any], accepted: bool, note: str) -> str:
        results = json.loads((self.work / "test-results.json").read_text(encoding="utf-8"))
        lines = [f"# DriftPad {manifest['fw_version']} (build {manifest['build_id']})", "",
                 f"Commit {manifest.get('git_commit')} ({manifest.get('commit_date')}), protocol {manifest.get('protocol')}.",
                 "", f"**Status: {'ready for external beta' if accepted else 'software-qualified; ' + note}.**", "",
                 "## Automated checks", ""]
        c = results.get("counts", {})
        lines.append(f"- {c.get('passed')}/{c.get('planned')} tests passed, {c.get('skipped')} skipped "
                     f"({results.get('verdict')}).")
        by_scope: Dict[str, List[int]] = {}
        for t in results.get("tests", []):
            s = by_scope.setdefault(t.get("scope", "?"), [0, 0])
            s[0] += t.get("status") == "PASS"
            s[1] += 1
        for scope, (p, n) in sorted(by_scope.items()):
            lines.append(f"  - {scope}: {p}/{n}")
        for mod, groups in (results.get("inner_results") or {}).items():
            for label, n in groups.items():
                lines.append(f"  - inside {mod}: {label}: {n.get('passed')} passed, {n.get('failed')} failed")
        lines += ["- No automated check exercises a physical DriftPad.", "",
                  "## Flashing", "", "`python tools/flash.py --uf2 firmware.uf2` (firmware.elf and build_manifest.json "
                  "must be next to it). It verifies the pad reports this build afterwards.", "",
                  "Check the files against SHA256SUMS before flashing.", ""]
        return "\n".join(lines)

    # ---- driver
    def qualify(self, dist: Path, acceptance: Optional[Path], keep_going: bool = False) -> int:
        self.work.mkdir(parents=True, exist_ok=True)
        ok = self.git()
        commit = (self.steps[-1].data or {}).get("commit", "")
        for step in (self.version, self.toolchain, self.tests):
            if not ok and not keep_going:
                break
            ok = step() and ok
        if ok or keep_going:
            ok = self.image(commit) and ok
        if ok:
            ok = self.bundle(dist, self.steps[-1].data["manifest"], acceptance)
        self.out("QUALIFIED" if ok else "NOT QUALIFIED")
        return 0 if ok else 1


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Qualify this checkout for release (nothing is published).")
    ap.add_argument("--acceptance", type=Path, help="completed hardware acceptance record for this build")
    ap.add_argument("--dist", type=Path, default=REPO / "dist")
    ap.add_argument("--keep-going", action="store_true", help="run every step even after a failure")
    args = ap.parse_args(argv)
    return Qualifier().qualify(args.dist, args.acceptance, args.keep_going)


if __name__ == "__main__":
    sys.exit(main())
