#!/usr/bin/env python3
"""Isolated Meshy REST/MCP provider adapter with pre-flight validation and cost idempotency (§7.3.2)."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import yaml_lite  # noqa: E402

ALLOWED_RIGHTS = {"original-design", "licensed", "owned-reference"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _sha256_bytes(b: bytes) -> str:
    return "sha256:" + hashlib.sha256(b).hexdigest()


def validate_asset_spec_preflight(spec_path: str) -> tuple[dict[str, Any], str]:
    if not os.path.isfile(spec_path):
        raise ValueError(f"Missing asset-spec.yaml at {spec_path}")
    with open(spec_path, "rb") as fp:
        raw = fp.read()
    spec_hash = _sha256_bytes(raw)
    spec = yaml_lite.load(raw.decode("utf-8"))
    if not isinstance(spec, dict):
        raise ValueError("asset-spec.yaml root must be a mapping")
    for req_key in ("asset_id", "kind", "rights_status", "engine", "geometry", "rig", "art"):
        if req_key not in spec:
            raise ValueError(f"Missing required key {req_key!r} in asset-spec.yaml")
    if spec.get("rights_status") not in ALLOWED_RIGHTS:
        raise ValueError(f"Invalid rights_status: {spec.get('rights_status')!r}")
    tri_budget = spec.get("geometry", {}).get("triangle_budget", 0)
    if not isinstance(tri_budget, int) or tri_budget <= 0 or tri_budget > 15000:
        raise ValueError(f"Invalid triangle_budget {tri_budget!r} (must be 1..15000)")
    rig = spec.get("rig", {})
    if rig.get("skeleton") != "canonical-16-bone-humanoid":
        raise ValueError(f"Invalid rig.skeleton: {rig.get('skeleton')!r}")
    return spec, spec_hash


def compute_idempotency_key(spec_hash: str, prompt: str, settings: dict[str, Any]) -> str:
    payload = yaml_lite.canonical_json_bytes({"prompt": prompt, "settings": settings}).decode("utf-8")
    return _sha256_bytes((spec_hash + "\n" + payload).encode("utf-8"))


def _http_json(method: str, url: str, api_key: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {api_key}", "Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _download_binary(url: str, dest_path: str) -> None:
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    with urllib.request.urlopen(url, timeout=30) as resp:
        content = resp.read()
    with open(dest_path, "wb") as fp:
        fp.write(content)


def _write_task_ledger(path: str, ledger: dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as fp:
        json.dump(ledger, fp, indent=2)
        fp.write("\n")


def run_meshy_generation(char_dir: str, force_new_task: bool = False) -> int:
    char_dir = os.path.abspath(char_dir)
    spec_path = os.path.join(char_dir, "asset-spec.yaml")
    char_json_path = os.path.join(char_dir, "character.json")
    task_json_path = os.path.join(char_dir, "generation-task.json")

    # Rule 1: Pre-flight validation before any network/API call -> exit 2 on failure
    try:
        spec, spec_hash = validate_asset_spec_preflight(spec_path)
    except Exception as exc:
        print(f"PREFLIGHT_ERROR: {exc}", file=sys.stderr)
        return 2

    prompt = str(spec.get("art", {}).get("original_brief", ""))
    height_m = 1.80
    spread_deg = 0
    if os.path.isfile(char_json_path):
        with open(char_json_path, "r", encoding="utf-8") as fp:
            cc = json.load(fp)
            height_m = float(cc.get("model", {}).get("heightMeters", 1.80))
            spread_deg = int(cc.get("model", {}).get("armSpreadOffsetDeg", 0))

    settings = {"height_meters": height_m, "arm_spread_offset_deg": spread_deg}
    idem_key = compute_idempotency_key(spec_hash, prompt, settings)
    base_url = os.environ.get("MESHY_API_BASE_URL", "https://api.meshy.ai").rstrip("/")
    api_key = os.environ.get("MESHY_API_KEY", "test-key")

    existing: dict[str, Any] | None = None
    if os.path.isfile(task_json_path):
        with open(task_json_path, "r", encoding="utf-8") as fp:
            existing = json.load(fp)

    # Rule 3: Idempotency check before re-charging
    if existing and existing.get("idempotency_key") == idem_key:
        st = existing.get("status")
        task_id = existing.get("task_id")
        if st == "SUCCEEDED":
            print(f"OK: Reusing SUCCEEDED task {task_id} -> {existing.get('raw_output_uri')}")
            return 0
        if st == "SUBMITTING" and not task_id and not force_new_task:
            print("ERROR: Task in SUBMITTING state without task_id; pass --force-new-task to create a new billable task", file=sys.stderr)
            return 1
        if st in ("FAILED", "CANCELED", "EXPIRED") and not force_new_task:
            print(f"ERROR: Existing task is {st}; pass --force-new-task to retry", file=sys.stderr)
            return 1
        if st in ("PENDING", "IN_PROGRESS", "TIMED_OUT") and task_id and not force_new_task:
            # Poll existing task via getGeneration(task_id)
            resp = _http_json("GET", f"{base_url}/v2/text-to-3d/{task_id}", api_key)
            remote_status = resp.get("status", "IN_PROGRESS")
            existing["poll_count"] = int(existing.get("poll_count", 0)) + 1
            existing["updated_at"] = _now_iso()
            if remote_status in ("FAILED", "CANCELED", "EXPIRED"):
                existing["status"] = "FAILED" if remote_status == "FAILED" else remote_status
                existing["error"] = resp.get("task_error") or resp.get("error") or {"message": f"Provider returned {remote_status}"}
                _write_task_ledger(task_json_path, existing)
                return 1
            if remote_status == "SUCCEEDED":
                raw_rel = f"chars/{os.path.basename(char_dir)}/.cache/raw_model.glb"
                raw_abs = os.path.join(char_dir, ".cache", "raw_model.glb")
                model_url = resp.get("model_urls", {}).get("glb")
                if model_url:
                    _download_binary(model_url, raw_abs)
                existing["status"] = "SUCCEEDED"
                existing["raw_output_uri"] = raw_rel
                existing["error"] = None
                _write_task_ledger(task_json_path, existing)
                return 0
            existing["status"] = remote_status
            _write_task_ledger(task_json_path, existing)
            return 0

    # Write SUBMITTING record BEFORE issuing billable createGeneration call
    created_at = _now_iso()
    ledger: dict[str, Any] = {
        "asset_id": spec["asset_id"],
        "idempotency_key": idem_key,
        "provider": "meshy",
        "provider_model": "meshy-4",
        "task_id": None,
        "status": "SUBMITTING",
        "created_at": created_at,
        "updated_at": created_at,
        "poll_count": 0,
        "raw_output_uri": f"chars/{os.path.basename(char_dir)}/.cache/raw_model.glb",
        "error": None,
    }
    _write_task_ledger(task_json_path, ledger)

    create_resp = _http_json(
        "POST",
        f"{base_url}/v2/text-to-3d",
        api_key,
        {"mode": "preview", "prompt": prompt, "art_style": "realistic", "should_remesh": True},
    )
    task_id = create_resp.get("result") or create_resp.get("task_id") or create_resp.get("id")
    remote_status = create_resp.get("status", "PENDING")
    ledger["task_id"] = task_id
    ledger["updated_at"] = _now_iso()
    if remote_status in ("FAILED", "CANCELED"):
        ledger["status"] = "FAILED"
        ledger["error"] = create_resp.get("error") or {"message": f"Task {remote_status}"}
        _write_task_ledger(task_json_path, ledger)
        return 1

    ledger["status"] = remote_status
    _write_task_ledger(task_json_path, ledger)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("char_dir")
    parser.add_argument("--force-new-task", action="store_true")
    args = parser.parse_args()
    return run_meshy_generation(args.char_dir, force_new_task=args.force_new_task)


if __name__ == "__main__":
    raise SystemExit(main())
