#!/usr/bin/env python3
"""Sole writer of the Approval block and manifest_hash in asset-manifest.yaml / asset-manifest.json."""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
from datetime import datetime, timezone
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import yaml_lite  # noqa: E402

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def compute_manifest_hash(manifest: dict[str, Any]) -> str:
    stripped = {k: v for k, v in manifest.items() if k not in ("approval", "validation")}
    canon = yaml_lite.canonical_json_bytes(stripped)
    return "sha256:" + hashlib.sha256(canon).hexdigest()


def write_manifest_files(char_dir: str, manifest: dict[str, Any]) -> None:
    yaml_path = os.path.join(char_dir, "asset-manifest.yaml")
    json_path = os.path.join(char_dir, "asset-manifest.json")
    with open(yaml_path, "w", encoding="utf-8") as fp:
        fp.write(yaml_lite.dump(manifest))
    with open(json_path, "wb") as fp:
        fp.write(yaml_lite.canonical_json_bytes(manifest))


def approve_char(char_dir: str, approved_by: str, notes: str = "Approved via approve_char.py") -> str:
    char_dir = os.path.abspath(char_dir)
    yaml_path = os.path.join(char_dir, "asset-manifest.yaml")
    with open(yaml_path, "r", encoding="utf-8") as fp:
        manifest = yaml_lite.load(fp.read())

    m_hash = compute_manifest_hash(manifest)
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    manifest["approval"] = {
        "status": "approved",
        "approved_by": approved_by,
        "approved_at": now_iso,
        "manifest_hash": m_hash,
        "notes": notes,
    }
    write_manifest_files(char_dir, manifest)
    return m_hash


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("char_dirs", nargs="*")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--by", required=True)
    parser.add_argument("--notes", default="Approved via approve_char.py")
    args = parser.parse_args()

    targets = list(args.char_dirs)
    if args.all:
        chars_root = os.path.join(ROOT_DIR, "chars")
        targets = [
            os.path.join(chars_root, d)
            for d in sorted(os.listdir(chars_root))
            if os.path.isdir(os.path.join(chars_root, d)) and not d.startswith(".")
        ]
    if not targets:
        print("No character directories specified", file=sys.stderr)
        return 2

    for t in targets:
        h = approve_char(t, args.by, args.notes)
        print(f"OK: Approved {os.path.basename(t)} ({h})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
