#!/usr/bin/env python3
"""Specification schema, referential integrity, and word-budget checker."""

from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import yaml_lite  # noqa: E402


def check_spec(path: str) -> list[str]:
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()

    failures: list[str] = []

    # 1. All JSON blocks parse cleanly
    json_blocks = re.findall(r"```json\n(.*?)```", text, flags=re.DOTALL)
    if len(json_blocks) < 4:
        failures.append(f"Expected >= 4 JSON blocks, found {len(json_blocks)}")
    parsed_jsons = []
    for idx, jb in enumerate(json_blocks):
        try:
            parsed_jsons.append(json.loads(jb))
        except Exception as exc:
            failures.append(f"JSON block {idx + 1} failed json.loads: {exc}")

    # 2. Check character.json boneMap has 16 canonical sockets
    char_json = next((j for j in parsed_jsons if isinstance(j, dict) and "boneMap" in j), None)
    if not char_json:
        failures.append("Could not find character.json block")
    else:
        bone_map = char_json["boneMap"]
        if len(bone_map) != 16:
            failures.append(f"Expected 16 canonical bone sockets in character.json#boneMap, got {len(bone_map)}")

    # 3. Check moveset.json frame windows
    moveset_json = next((j for j in parsed_jsons if isinstance(j, dict) and "moves" in j), None)
    if not moveset_json:
        failures.append("Could not find moveset.json block")
    else:
        clip_line_m = re.search(r"\*\*Canonical Clip Lengths.*?\*\*([^\n]+)", text)
        clip_pairs = dict(re.findall(r"`([a-z0-9_]+) (\d+)`", clip_line_m.group(1) if clip_line_m else ""))
        for move_id, mv in moveset_json["moves"].items():
            total = mv["totalFrames"]
            anim = mv["animation"]
            if anim in clip_pairs and int(clip_pairs[anim]) < total:
                failures.append(f"Move {move_id} totalFrames {total} > clip {anim} frames {clip_pairs[anim]}")
            for hb in mv.get("hitboxes", []):
                if not (1 <= hb["startFrame"] <= hb["endFrame"] < total):
                    failures.append(f"Move {move_id} hitbox {hb['id']} invalid window")
                if "throwReleaseFrame" in hb:
                    if not (hb["endFrame"] < hb["throwReleaseFrame"] < total):
                        failures.append(f"Move {move_id} throwReleaseFrame ordering invalid")

    # 4. Check 17 FSM states in table
    state_rows = re.findall(r"\|\s*\*\*\d+\*\*\s*\|\s*`([A-Z_]+)`\s*\|", text)
    if len(state_rows) != 17:
        failures.append(f"Expected 17 FSM states in §6.1.1 table, found {len(state_rows)}")

    # 5. Boundary and Precision word counts
    for sec in ("Boundary", "Precision"):
        m = re.search(rf"^## {sec}\s+(.+?)(?=\n###|\n## |\Z)", text, flags=re.MULTILINE | re.DOTALL)
        if not m:
            failures.append(f"Missing ## {sec}")
        else:
            wc = len(m.group(1).strip().split())
            if wc >= 60:
                failures.append(f"## {sec} word count {wc} >= 60")

    return failures


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: spec_check.py <spec.md>", file=sys.stderr)
        return 2
    path = sys.argv[1]
    failures = check_spec(path)
    if failures:
        for f in failures:
            print(f"FAIL: {f}", file=sys.stderr)
        return 1
    print(f"OK: spec_check passed on {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
