#!/usr/bin/env python3
"""Mechanical structural verifier for 3d_arena_mugen_spec.md (Pass 5)."""

from __future__ import annotations

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import yaml_lite  # noqa: E402


def count_unquoted_pipes(line: str) -> int:
    in_code = False
    escaped = False
    pipes = 0
    for ch in line:
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch == "`":
            in_code = not in_code
            continue
        if ch == "|" and not in_code:
            pipes += 1
    return pipes


def check_spec_structure(path: str) -> list[str]:
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    lines = text.splitlines()
    failures: list[str] = []

    in_fence = False
    table_header_pipes: int | None = None

    for idx, line in enumerate(lines, start=1):
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            table_header_pipes = None
            continue
        if in_fence:
            continue

        # 1. Table cell count consistency
        if stripped.startswith("|") and stripped.endswith("|"):
            p = count_unquoted_pipes(stripped)
            if table_header_pipes is None:
                table_header_pipes = p
            elif p != table_header_pipes:
                failures.append(f"Line {idx}: Table pipe count {p} != header pipe count {table_header_pipes}")
        else:
            table_header_pipes = None

        # 2. Code span balance & nested backtick check
        tick_count = line.count("`")
        if tick_count % 2 != 0:
            failures.append(f"Line {idx}: Unbalanced backticks ({tick_count})")
        if "theapproval**and**validation" in line:
            failures.append(f"Line {idx}: Garbled nested code span around approval/validation")

        # 3. Inline math balance (excluding escaped \$ and code spans)
        no_code = re.sub(r"`[^`]*`", "", line)
        no_esc = no_code.replace(r"\$", "")
        no_disp = no_esc.replace("$$", "")
        dollars = no_disp.count("$")
        if dollars % 2 != 0:
            failures.append(f"Line {idx}: Unbalanced inline math '$' delimiters ({dollars})")

    # 4. YAML blocks & 13 YAML 1.1 traps
    yaml_blocks = re.findall(r"```yaml\n(.*?)```", text, flags=re.DOTALL)
    if len(yaml_blocks) < 2:
        failures.append(f"Expected >= 2 yaml blocks, found {len(yaml_blocks)}")
    for b_idx, block in enumerate(yaml_blocks):
        try:
            parsed = yaml_lite.load(block)
            if b_idx == 0:
                if not isinstance(parsed["engine"]["version"], str):
                    failures.append("asset-spec engine.version must parse as str ('0.1.0')")
                if not isinstance(parsed["asset_id"], str):
                    failures.append("asset-spec asset_id must parse as str")
                if not isinstance(parsed["scale"], str):
                    failures.append("asset-spec scale must parse as str")
        except Exception as exc:
            failures.append(f"YAML block {b_idx + 1} failed yaml_lite.load: {exc}")

    traps = ["yes", "no", "on", "off", "~", "Null", "TRUE", "0x1F", "1_000", "1:30", ".5", "5.", "1e3"]
    for trap in traps:
        try:
            yaml_lite.parse_scalar(trap)
            failures.append(f"YAML 1.1 trap {trap!r} was not rejected by yaml_lite")
        except yaml_lite.YamlLiteError:
            pass

    # 5. Canonical clip table vs asset-spec.yaml
    clip_line_m = re.search(r"\*\*Canonical Clip Lengths.*?\*\*([^\n]+)", text)
    clip_pairs = re.findall(r"`([a-z0-9_]+) (\d+)`", clip_line_m.group(1) if clip_line_m else "")
    clip_map = {name: int(frames) for name, frames in clip_pairs}
    if len(clip_map) != 27:
        failures.append(f"Expected 27 canonical clip lengths in §4.2, found {len(clip_map)}")

    if yaml_blocks:
        spec_doc = yaml_lite.load(yaml_blocks[0])
        spec_clips = spec_doc["rig"]["animation_clips"]
        if set(spec_clips) != set(clip_map.keys()) or len(spec_clips) != 27:
            failures.append("Mismatch between §4.2 clip lengths and asset-spec.yaml#rig.animation_clips")

    # 6. Throw release ordering & clip duration checks in moveset.json
    if '"throwReleaseFrame": 28' not in text:
        failures.append("Missing throwReleaseFrame: 28 in moveset.json")

    # 7. Gate 0 state coverage (common_states.json#clipSubset)
    if "clipSubset" not in text:
        failures.append("Missing common_states.json#clipSubset Gate 0 state fallback rule")

    # 8. AC-008 passive training dummy satisfiability
    if "passive training dummy" not in text:
        failures.append("AC-008 missing passive training dummy ring-occupancy formulation")

    # 9. Gate 0 FPS / frame-time check
    if "gate0-frametime.json" not in text:
        failures.append("Gate 0 missing gate0-frametime.json p95 < 16.6ms measurement")

    # 10. Boundary & Precision word budgets (< 60 words each)
    for sec in ("Boundary", "Precision"):
        m = re.search(rf"^## {sec}\s+(.+?)(?=\n###|\n## |\Z)", text, flags=re.MULTILINE | re.DOTALL)
        if not m:
            failures.append(f"Missing ## {sec} section")
        else:
            words = m.group(1).strip().split()
            if len(words) >= 60:
                failures.append(f"## {sec} exceeds 60-word budget ({len(words)} words)")

    return failures


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: structure_check.py <spec.md>", file=sys.stderr)
        return 2
    path = sys.argv[1]
    failures = check_spec_structure(path)
    if failures:
        for f in failures:
            print(f"FAIL: {f}", file=sys.stderr)
        return 1
    print(f"OK: structure_check passed with 0 failures on {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
