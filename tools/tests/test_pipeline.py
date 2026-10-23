"""Unit tests for yaml_lite, validate_char, approve_char, meshy_adapter, and spec checks."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from typing import Any
from unittest import mock

import sys

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT_DIR, "tools"))
sys.path.insert(0, os.path.join(ROOT_DIR, "evidence"))

import approve_char  # noqa: E402
import meshy_adapter  # noqa: E402
import spec_check  # noqa: E402
import structure_check  # noqa: E402
import validate_char  # noqa: E402
import yaml_lite  # noqa: E402


def _read_bytes(path: str) -> bytes:
    with open(path, "rb") as fp:
        return fp.read()


class TestYamlLiteAndSpec(unittest.TestCase):
    def test_yaml_lite_scalars_and_traps(self) -> None:
        self.assertEqual(yaml_lite.parse_scalar("0.1.0"), "0.1.0")
        self.assertEqual(yaml_lite.parse_scalar("character.tecton_grappler.v1"), "character.tecton_grappler.v1")
        self.assertEqual(yaml_lite.parse_scalar("1.0_unit_equals_1_meter"), "1.0_unit_equals_1_meter")
        self.assertEqual(yaml_lite.parse_scalar("15000"), 15000)
        self.assertEqual(yaml_lite.parse_scalar("-2.45"), -2.45)
        self.assertIs(yaml_lite.parse_scalar("true"), True)
        self.assertIs(yaml_lite.parse_scalar("false"), False)
        self.assertIsNone(yaml_lite.parse_scalar("null"))

        traps = ["yes", "no", "on", "off", "~", "Null", "TRUE", "0x1F", "1_000", "1:30", ".5", "5.", "1e3"]
        for trap in traps:
            with self.assertRaises(yaml_lite.YamlLiteError, msg=f"Trap {trap!r} should raise"):
                yaml_lite.parse_scalar(trap)

    def test_spec_mechanical_checks(self) -> None:
        spec_path = os.path.join(ROOT_DIR, "docs", "3d_arena_mugen_spec.md")
        self.assertEqual(structure_check.check_spec_structure(spec_path), [])
        self.assertEqual(spec_check.check_spec(spec_path), [])


class TestValidateCharAndMeshyAdapter(unittest.TestCase):
    def test_validate_char_fail_closed_preserves_contracts(self) -> None:
        src_char = os.path.join(ROOT_DIR, "chars", "tecton_grappler")
        if not os.path.isdir(src_char):
            self.skipTest("tecton_grappler not generated yet")

        with tempfile.TemporaryDirectory() as tmp:
            char_copy = os.path.join(tmp, "tecton_grappler")
            shutil.copytree(src_char, char_copy)

            # Valid copy passes
            self.assertEqual(validate_char.validate_character(char_copy, clip_subset="all"), [])

            spec_bytes_before = _read_bytes(os.path.join(char_copy, "asset-spec.yaml"))
            char_bytes_before = _read_bytes(os.path.join(char_copy, "character.json"))

            # 1. Unapproved manifest rejected
            manifest_path = os.path.join(char_copy, "asset-manifest.yaml")
            with open(manifest_path, "r", encoding="utf-8") as fp:
                manifest = yaml_lite.load(fp.read())
            manifest["approval"]["status"] = "pending"
            approve_char.write_manifest_files(char_copy, manifest)

            errs = validate_char.validate_character(char_copy, clip_subset="all")
            self.assertTrue(any("Approval status" in e for e in errs))
            self.assertEqual(_read_bytes(os.path.join(char_copy, "asset-spec.yaml")), spec_bytes_before)
            self.assertEqual(_read_bytes(os.path.join(char_copy, "character.json")), char_bytes_before)

            # 2. Cycle in cancel graph rejected
            approve_char.approve_char(char_copy, approved_by="test")
            moveset_path = os.path.join(char_copy, "moveset.json")
            with open(moveset_path, "r", encoding="utf-8") as fp:
                ms = json.load(fp)
            ms["moves"]["light_2"]["cancels"][0]["targets"].append("light_1")
            with open(moveset_path, "w", encoding="utf-8") as fp:
                json.dump(ms, fp)
            errs_cycle = validate_char.validate_character(char_copy, clip_subset="all")
            self.assertTrue(any("Cycle detected" in e for e in errs_cycle))

    def test_meshy_adapter_preflight_and_idempotency(self) -> None:
        requests_log: list[tuple[str, str]] = []

        def fake_http_json(method: str, url: str, api_key: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
            path = "/" + url.split("://", 1)[1].split("/", 1)[1]
            requests_log.append((method, path))
            if method == "GET":
                return {"id": "task-123", "status": "IN_PROGRESS"}
            return {"result": "task-new-999", "status": "PENDING"}

        with mock.patch.object(meshy_adapter, "_http_json", side_effect=fake_http_json):
            with tempfile.TemporaryDirectory() as tmp:
                cdir = os.path.join(tmp, "test_char")
                os.makedirs(cdir)
                # 1. Invalid asset-spec.yaml (triangle_budget > 15000) -> exit 2 with 0 HTTP requests
                bad_spec = {
                    "asset_id": "character.test.v1",
                    "kind": "character",
                    "rights_status": "original-design",
                    "engine": {"name": "ArenaMugen3D", "version": "0.1.0", "import_format": "glb"},
                    "geometry": {"triangle_budget": 25000},
                    "rig": {"skeleton": "canonical-16-bone-humanoid"},
                    "art": {"original_brief": "test prompt"},
                }
                with open(os.path.join(cdir, "asset-spec.yaml"), "w", encoding="utf-8") as fp:
                    fp.write(yaml_lite.dump(bad_spec))
                rc = meshy_adapter.run_meshy_generation(cdir)
                self.assertEqual(rc, 2)
                self.assertEqual(len(requests_log), 0)

                # Fix spec
                bad_spec["geometry"]["triangle_budget"] = 12000
                spec_path = os.path.join(cdir, "asset-spec.yaml")
                with open(spec_path, "w", encoding="utf-8") as fp:
                    fp.write(yaml_lite.dump(bad_spec))
                _, spec_hash = meshy_adapter.validate_asset_spec_preflight(spec_path)
                idem = meshy_adapter.compute_idempotency_key(
                    spec_hash, "test prompt", {"height_meters": 1.8, "arm_spread_offset_deg": 0}
                )

                # 2. Existing PENDING task -> calls GET, not POST
                with open(os.path.join(cdir, "generation-task.json"), "w", encoding="utf-8") as fp:
                    json.dump(
                        {
                            "asset_id": "character.test.v1",
                            "idempotency_key": idem,
                            "provider": "meshy",
                            "provider_model": "meshy-4",
                            "task_id": "task-123",
                            "status": "PENDING",
                            "created_at": "2026-10-22T00:00:00Z",
                            "updated_at": "2026-10-22T00:00:00Z",
                            "poll_count": 1,
                            "raw_output_uri": "chars/test_char/.cache/raw_model.glb",
                            "error": None,
                        },
                        fp,
                    )
                rc = meshy_adapter.run_meshy_generation(cdir)
                self.assertEqual(rc, 0)
                self.assertEqual(requests_log, [("GET", "/v2/text-to-3d/task-123")])

                # 3. Existing SUCCEEDED task -> 0 new calls
                requests_log.clear()
                with open(os.path.join(cdir, "generation-task.json"), "r+", encoding="utf-8") as fp:
                    doc = json.load(fp)
                    doc["status"] = "SUCCEEDED"
                    fp.seek(0)
                    fp.truncate()
                    json.dump(doc, fp)
                rc = meshy_adapter.run_meshy_generation(cdir)
                self.assertEqual(rc, 0)
                self.assertEqual(requests_log, [])

                # 4. Existing SUBMITTING without task_id -> stops (exit 1) with 0 calls
                with open(os.path.join(cdir, "generation-task.json"), "r+", encoding="utf-8") as fp:
                    doc = json.load(fp)
                    doc["status"] = "SUBMITTING"
                    doc["task_id"] = None
                    fp.seek(0)
                    fp.truncate()
                    json.dump(doc, fp)
                rc = meshy_adapter.run_meshy_generation(cdir)
                self.assertEqual(rc, 1)
                self.assertEqual(requests_log, [])


if __name__ == "__main__":
    unittest.main()
