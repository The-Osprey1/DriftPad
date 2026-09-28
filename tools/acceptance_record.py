#!/usr/bin/env python3
"""
acceptance_record.py - The record of a hardware acceptance run (docs/hardware-acceptance.md).

The items come from the tables in docs/hardware-acceptance.md (rows starting "| HW-nn |"), so the
procedure and the record cannot drift apart. A record belongs to exactly one build.

    new    --manifest <bundle>/build_manifest.json --tester NAME [--out acceptance.json]
    set    acceptance.json HW-07 pass|fail|n/a|not_run [--note TEXT]
    check  acceptance.json [--manifest PATH]       lists what is open; exit 0 only when complete
    sign   acceptance.json --by NAME               only when every required item passed

Results: every item starts "not_run". "n/a" is accepted only for items the procedure marks
*optional*. A signed record is frozen: `set` refuses to change it.
tools/qualify_release.py --acceptance uses evaluate() below. Pure Python standard library.
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO = Path(__file__).resolve().parent.parent
DOC = REPO / "docs" / "hardware-acceptance.md"
SCHEMA = "driftpad-hw-acceptance/1"
RESULTS = ("not_run", "pass", "fail", "n/a")
ROW = re.compile(r"^\|\s*(HW-\d{2})\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$")


def load_items(doc_text: str) -> List[Dict[str, Any]]:
    items, seen = [], set()
    for line in doc_text.splitlines():
        m = ROW.match(line)
        if not m:
            continue
        item_id, title, procedure, criterion = m.groups()
        if item_id in seen:
            raise ValueError(f"{item_id} appears twice in the procedure")
        seen.add(item_id)
        items.append({"id": item_id, "title": title, "required": "*optional*" not in procedure,
                      "criterion": criterion})
    if not items:
        raise ValueError("no HW-nn items found in the procedure")
    return items


def doc_items(doc: Path = DOC) -> List[Dict[str, Any]]:
    return load_items(Path(doc).read_text(encoding="utf-8"))


def new_record(manifest: Dict[str, Any], tester: str, items: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "schema": SCHEMA,
        "build_id": manifest.get("build_id"),
        "fw_version": manifest.get("fw_version"),
        "git_commit": manifest.get("git_commit"),
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tester": tester,
        "items": [{"id": i["id"], "title": i["title"], "required": i["required"], "result": "not_run",
                   "notes": []} for i in items],
        "signed_off_by": None,
        "signed_utc": None,
    }


def set_result(record: Dict[str, Any], item_id: str, result: str, note: Optional[str] = None) -> None:
    if record.get("signed_off_by"):
        raise ValueError("the record is signed off and frozen; start a new record for a new run")
    if result not in RESULTS:
        raise ValueError(f"result must be one of {', '.join(RESULTS)}")
    for item in record["items"]:
        if item["id"] == item_id:
            if result == "n/a" and item["required"]:
                raise ValueError(f"{item_id} is required; n/a is only for optional items")
            item["result"] = result
            if note:
                item["notes"].append({"utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                      "result": result, "text": note})
            return
    raise ValueError(f"no item {item_id} in this record")


def evaluate(record: Dict[str, Any], manifest: Optional[Dict[str, Any]] = None,
             items: Optional[List[Dict[str, Any]]] = None, require_signature: bool = True) -> Tuple[bool, List[str]]:
    """(complete, problems). Complete means: for this build, every item of the current procedure is
    in the record, every required item passed, no item failed, and (optionally) it is signed."""
    problems: List[str] = []
    if record.get("schema") != SCHEMA:
        problems.append(f"not an acceptance record ({record.get('schema')!r})")
        return False, problems
    if manifest is not None and record.get("build_id") != manifest.get("build_id"):
        problems.append(f"the record is for build {record.get('build_id')}, not {manifest.get('build_id')}")
    by_id = {i["id"]: i for i in record.get("items", [])}
    expected = items if items is not None else [{"id": k, "required": v.get("required", True)} for k, v in by_id.items()]
    for want in expected:
        got = by_id.get(want["id"])
        if got is None:
            problems.append(f"{want['id']} is missing from the record (the procedure changed; start a new record)")
            continue
        if got["result"] == "fail":
            problems.append(f"{want['id']} failed")
        elif got["result"] == "n/a" and want["required"]:
            problems.append(f"{want['id']} is required but marked n/a")
        elif got["result"] == "not_run":
            problems.append(f"{want['id']} not run" + ("" if want["required"] else " (optional: pass or n/a)"))
    if items is not None:
        unknown = set(by_id) - {i["id"] for i in items}
        for u in sorted(unknown):
            problems.append(f"{u} is not in the current procedure")
    if require_signature and not record.get("signed_off_by"):
        problems.append("not signed off")
    return not problems, problems


def sign(record: Dict[str, Any], by: str, items: List[Dict[str, Any]]) -> None:
    ok, problems = evaluate(record, items=items, require_signature=False)
    if not ok:
        raise ValueError("cannot sign: " + "; ".join(problems))
    record["signed_off_by"] = by
    record["signed_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _load(path: Path) -> Dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _save(path: Path, record: Dict[str, Any]) -> None:
    Path(path).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")


def main(argv: Optional[List[str]] = None, out=print, doc: Path = DOC) -> int:
    ap = argparse.ArgumentParser(description="Hardware acceptance record for one build.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("new")
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--tester", required=True)
    p.add_argument("--out", type=Path, default=Path("acceptance.json"))
    p = sub.add_parser("set")
    p.add_argument("record", type=Path)
    p.add_argument("item")
    p.add_argument("result", choices=RESULTS)
    p.add_argument("--note")
    p = sub.add_parser("check")
    p.add_argument("record", type=Path)
    p.add_argument("--manifest", type=Path)
    p = sub.add_parser("sign")
    p.add_argument("record", type=Path)
    p.add_argument("--by", required=True)
    args = ap.parse_args(argv)

    try:
        items = doc_items(doc)
        if args.cmd == "new":
            if args.out.exists():
                out(f"{args.out} exists; not overwriting a record")
                return 2
            manifest = _load(args.manifest)
            _save(args.out, new_record(manifest, args.tester, items))
            out(f"{args.out}: {len(items)} items for build {manifest.get('build_id')}")
            return 0
        record = _load(args.record)
        if args.cmd == "set":
            set_result(record, args.item, args.result, args.note)
            _save(args.record, record)
            out(f"{args.item}: {args.result}")
            return 0
        if args.cmd == "sign":
            sign(record, args.by, items)
            _save(args.record, record)
            out(f"signed off by {args.by}")
            return 0
        manifest = _load(args.manifest) if args.manifest else None
        ok, problems = evaluate(record, manifest, items)
        for p in problems:
            out(f"  - {p}")
        out("COMPLETE" if ok else f"INCOMPLETE ({len(problems)} open)")
        return 0 if ok else 1
    except (OSError, ValueError, KeyError) as e:
        out(f"error: {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
