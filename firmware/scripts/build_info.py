"""
build_info.py - PlatformIO post-script: stamps the build identity and writes build_manifest.json.

- DRIFTPAD_BUILD_ID   "<12-char git sha>[-dirty]" or "unknown"
- DRIFTPAD_BUILD_DATE git commit date (ISO 8601) or "unknown"
are passed to the firmware sources as -D flags (include/build_info.h has fallbacks). The firmware
version comes from include/build_info.h and nowhere else. No wall-clock time goes into the
firmware, so a commit always builds to the same identity.

After the program is built, $BUILD_DIR/build_manifest.json records the identity and the sha256 and
size of firmware.uf2/.elf/.bin. tools/flash.py compares INFO's "build" against it after an update.

The logic lives in plain functions so tests/test_build_info_script.py can exercise it without
PlatformIO.
"""

import datetime
import hashlib
import json
import os
import re
import subprocess

ARTIFACTS = ("firmware.uf2", "firmware.elf", "firmware.bin")


def _git(args, cwd):
    try:
        result = subprocess.run(["git"] + list(args), cwd=cwd, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def git_identity(repo_dir):
    """{"git_commit", "git_dirty", "commit_date", "build_id"}; unknown values when git is unavailable."""
    commit = _git(["rev-parse", "HEAD"], repo_dir)
    if not commit or not re.fullmatch(r"[0-9a-f]{40}", commit):
        return {"git_commit": None, "git_dirty": None, "commit_date": None, "build_id": "unknown"}
    status = _git(["status", "--porcelain"], repo_dir)
    dirty = bool(status) if status is not None else True
    date = _git(["show", "-s", "--format=%cI", "HEAD"], repo_dir)
    return {
        "git_commit": commit,
        "git_dirty": dirty,
        "commit_date": date or None,
        "build_id": commit[:12] + ("-dirty" if dirty else ""),
    }


def read_fw_version(header_path):
    with open(header_path, encoding="utf-8") as f:
        text = f.read()
    m = re.search(r'^#define\s+DRIFTPAD_FW_VERSION\s+"([^"]+)"', text, re.MULTILINE)
    if not m:
        raise ValueError(f"DRIFTPAD_FW_VERSION not found in {header_path}")
    return m.group(1)


def read_protocol_version(limits_header_path):
    with open(limits_header_path, encoding="utf-8") as f:
        text = f.read()
    m = re.search(r"PROTOCOL_VERSION\s*=\s*(\d+)", text)
    if not m:
        raise ValueError(f"PROTOCOL_VERSION not found in {limits_header_path}")
    return int(m.group(1))


def artifact_info(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return {"sha256": h.hexdigest(), "size": os.path.getsize(path)}


def build_manifest(build_dir, fw_version, protocol, identity, env_name, generated_utc):
    artifacts = {}
    for name in ARTIFACTS:
        p = os.path.join(build_dir, name)
        if os.path.isfile(p):
            artifacts[name] = artifact_info(p)
    return {
        "fw_version": fw_version,
        "protocol": protocol,
        "build_id": identity["build_id"],
        "git_commit": identity["git_commit"],
        "git_dirty": identity["git_dirty"],
        "commit_date": identity["commit_date"],
        "env": env_name,
        "generated_utc": generated_utc,
        "artifacts": artifacts,
    }


def write_manifest(path, manifest):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)


def _utc_now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---- PlatformIO glue ---------------------------------------------------------------------------

try:
    Import("env", "projenv")  # noqa: F821 - provided by SCons when PlatformIO runs this script
except NameError:
    env = projenv = None

if env is not None:
    _project_dir = env.subst("$PROJECT_DIR")
    _repo_dir = os.path.dirname(_project_dir)
    _identity = git_identity(_repo_dir)
    _fw_version = read_fw_version(os.path.join(_project_dir, "include", "build_info.h"))
    _protocol = read_protocol_version(os.path.join(_project_dir, "include", "settings_limits.h"))

    # Project sources only (not the framework), so the core is not rebuilt when the id changes
    projenv.Append(CPPDEFINES=[
        ("DRIFTPAD_BUILD_ID", env.StringifyMacro(_identity["build_id"])),
        ("DRIFTPAD_BUILD_DATE", env.StringifyMacro(_identity["commit_date"] or "unknown")),
    ])

    def _write_manifest_action(*_args, **_kwargs):
        build_dir = env.subst("$BUILD_DIR")
        manifest = build_manifest(build_dir, _fw_version, _protocol, _identity,
                                  env.subst("$PIOENV"), _utc_now())
        write_manifest(os.path.join(build_dir, "build_manifest.json"), manifest)
        print("DriftPad build %s (%s): manifest written" % (_fw_version, _identity["build_id"]))

    env.AddPostAction("buildprog", _write_manifest_action)
