#!/usr/bin/env python3
"""Fail-closed character validator enforcing §7.2 & §7.3 (stdlib only, Python >= 3.11)."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import struct
import sys
from datetime import datetime, timezone
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import approve_char  # noqa: E402
import yaml_lite  # noqa: E402

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMMON_STATES_PATH = os.path.join(ROOT_DIR, "engine_assets", "common_states.json")
COMMON_ANIMS_GLB = os.path.join(ROOT_DIR, "engine_assets", "common_anims.glb")

REQUIRED_FILES = (
    "asset-spec.yaml",
    "generation-task.json",
    "asset-manifest.yaml",
    "character.json",
    "moveset.json",
    "ai.json",
    "model.glb",
)

CANONICAL_SOCKETS = {
    "hips", "spine", "chest", "head",
    "upper_arm_l", "forearm_l", "hand_l",
    "upper_arm_r", "forearm_r", "hand_r",
    "thigh_l", "shin_l", "foot_l",
    "thigh_r", "shin_r", "foot_r",
}

ALLOWED_RIGHTS = {"original-design", "licensed", "owned-reference"}
UNIVERSAL_AI_ACTIONS = {"homing_dash", "guard", "step_dodge"}


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fp:
        while chunk := fp.read(65536):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def _parse_glb(path: str) -> tuple[dict[str, Any], bytes]:
    with open(path, "rb") as fp:
        data = fp.read()
    if len(data) < 28:
        raise ValueError("GLB file too short")
    magic, version, total_len = struct.unpack("<III", data[:12])
    if magic != 0x46546C67 or version != 2:
        raise ValueError(f"Invalid GLB header magic={hex(magic)} version={version}")
    json_len, json_type = struct.unpack("<II", data[12:20])
    if json_type != 0x4E4F534A:
        raise ValueError("First GLB chunk is not JSON")
    gltf = json.loads(data[20 : 20 + json_len].decode("utf-8"))
    bin_start = 20 + json_len
    if bin_start + 8 <= len(data):
        bin_len, bin_type = struct.unpack("<II", data[bin_start : bin_start + 8])
        bin_data = data[bin_start + 8 : bin_start + 8 + bin_len]
    else:
        bin_data = b""
    return gltf, bin_data


def _mat4_identity() -> list[float]:
    return [1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0]


def _mat4_from_trs(t: list[float], r: list[float], s: list[float]) -> list[float]:
    x, y, z, w = r
    x2, y2, z2 = x + x, y + y, z + z
    xx, xy, xz = x * x2, x * y2, x * z2
    yy, yz, zz = y * y2, y * z2, z * z2
    wx, wy, wz = w * x2, w * y2, w * z2
    sx, sy, sz = s
    # Column-major 4x4 matrix
    return [
        (1.0 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0.0,
        (xy - wz) * sy, (1.0 - (xx + zz)) * sy, (yz + wx) * sy, 0.0,
        (xz + wy) * sz, (yz - wx) * sz, (1.0 - (xx + yy)) * sz, 0.0,
        t[0], t[1], t[2], 1.0,
    ]


def _mat4_mul(a: list[float], b: list[float]) -> list[float]:
    out = [0.0] * 16
    for col in range(4):
        for row in range(4):
            out[col * 4 + row] = (
                a[0 * 4 + row] * b[col * 4 + 0]
                + a[1 * 4 + row] * b[col * 4 + 1]
                + a[2 * 4 + row] * b[col * 4 + 2]
                + a[3 * 4 + row] * b[col * 4 + 3]
            )
    return out


def _mat4_transform_point(m: list[float], v: tuple[float, float, float]) -> tuple[float, float, float]:
    vx, vy, vz = v
    return (
        m[0] * vx + m[4] * vy + m[8] * vz + m[12],
        m[1] * vx + m[5] * vy + m[9] * vz + m[13],
        m[2] * vx + m[6] * vy + m[10] * vz + m[14],
    )


def _compute_node_world_matrices(nodes: list[dict[str, Any]]) -> tuple[dict[int, list[float]], dict[int, int]]:
    parents: dict[int, int] = {}
    for idx, n in enumerate(nodes):
        for c in n.get("children", []):
            parents[c] = idx
    world: dict[int, list[float]] = {}

    def get_world(i: int) -> list[float]:
        if i in world:
            return world[i]
        n = nodes[i]
        if "matrix" in n:
            local = [float(x) for x in n["matrix"]]
        else:
            t = [float(x) for x in n.get("translation", [0.0, 0.0, 0.0])]
            r = [float(x) for x in n.get("rotation", [0.0, 0.0, 0.0, 1.0])]
            s = [float(x) for x in n.get("scale", [1.0, 1.0, 1.0])]
            local = _mat4_from_trs(t, r, s)
        if i in parents:
            w = _mat4_mul(get_world(parents[i]), local)
        else:
            w = local
        world[i] = w
        return w

    for idx in range(len(nodes)):
        get_world(idx)
    return world, parents


def _read_accessor_vec3f(gltf: dict[str, Any], bin_data: bytes, acc_idx: int) -> list[tuple[float, float, float]]:
    acc = gltf["accessors"][acc_idx]
    bv = gltf["bufferViews"][acc["bufferView"]]
    stride = bv.get("byteStride", 12)
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    return [struct.unpack_from("<3f", bin_data, base + i * stride) for i in range(acc["count"])]


def validate_character(char_dir: str, clip_subset: str = "all", require_approval: bool = True) -> list[str]:
    char_dir = os.path.abspath(char_dir)
    char_id = os.path.basename(char_dir)
    errors: list[str] = []

    # 1. Files Present
    for fname in REQUIRED_FILES:
        if not os.path.isfile(os.path.join(char_dir, fname)):
            errors.append(f"Missing required file: {fname}")
    if errors:
        return errors

    try:
        with open(os.path.join(char_dir, "asset-spec.yaml"), "r", encoding="utf-8") as fp:
            asset_spec = yaml_lite.load(fp.read())
        with open(os.path.join(char_dir, "asset-manifest.yaml"), "r", encoding="utf-8") as fp:
            manifest = yaml_lite.load(fp.read())
        with open(os.path.join(char_dir, "character.json"), "r", encoding="utf-8") as fp:
            char_cfg = json.load(fp)
        with open(os.path.join(char_dir, "moveset.json"), "r", encoding="utf-8") as fp:
            moveset_cfg = json.load(fp)
        with open(os.path.join(char_dir, "ai.json"), "r", encoding="utf-8") as fp:
            ai_cfg = json.load(fp)
        with open(COMMON_STATES_PATH, "r", encoding="utf-8") as fp:
            states_cfg = json.load(fp)
    except Exception as exc:
        return [f"Schema parse error: {exc}"]

    # Contract & Rights checks
    if char_cfg.get("id") != char_id:
        errors.append(f"character.json#id {char_cfg.get('id')!r} != directory name {char_id!r}")
    if char_cfg.get("model", {}).get("file") != "model.glb":
        errors.append("character.json#model.file must be 'model.glb'")
    if manifest.get("output", {}).get("uri") != f"chars/{char_id}/model.glb":
        errors.append(f"asset-manifest.yaml#output.uri must be 'chars/{char_id}/model.glb'")

    rights = asset_spec.get("rights_status")
    if rights not in ALLOWED_RIGHTS:
        errors.append(f"Unacceptable rights_status: {rights!r}")

    tri_budget = asset_spec.get("geometry", {}).get("triangle_budget", 0)
    if not isinstance(tri_budget, int) or tri_budget > 15000 or tri_budget <= 0:
        errors.append(f"Invalid triangle_budget: {tri_budget!r}")

    if asset_spec.get("rig", {}).get("skeleton") != "canonical-16-bone-humanoid":
        errors.append("asset-spec.yaml#rig.skeleton must be 'canonical-16-bone-humanoid'")

    # Cryptographic Hash Integrity
    spec_hash_disk = _sha256_file(os.path.join(char_dir, "asset-spec.yaml"))
    if manifest.get("spec_hash", "").lower() != spec_hash_disk.lower():
        errors.append(f"spec_hash mismatch: manifest={manifest.get('spec_hash')} disk={spec_hash_disk}")

    glb_path = os.path.join(char_dir, "model.glb")
    glb_hash_disk = _sha256_file(glb_path)
    if manifest.get("output", {}).get("hash", "").lower() != glb_hash_disk.lower():
        errors.append(f"output.hash mismatch: manifest={manifest.get('output', {}).get('hash')} disk={glb_hash_disk}")

    # Approval check
    if require_approval:
        approval = manifest.get("approval", {})
        if approval.get("status") != "approved":
            errors.append(f"Approval status is {approval.get('status')!r}, expected 'approved'")
        if not approval.get("approved_by") or not approval.get("approved_at"):
            errors.append("Approval missing approved_by or approved_at")
        expected_mhash = approve_char.compute_manifest_hash(manifest)
        if approval.get("manifest_hash", "").lower() != expected_mhash.lower():
            errors.append(f"approval.manifest_hash mismatch: got {approval.get('manifest_hash')} != {expected_mhash}")

    # 2. Binary glTF & Geometry Gate
    try:
        gltf, bin_data = _parse_glb(glb_path)
    except Exception as exc:
        errors.append(f"GLB parse failure: {exc}")
        return errors

    ext_req = gltf.get("extensionsRequired", [])
    if ext_req:
        errors.append(f"Forbidden extensionsRequired in model.glb: {ext_req}")

    nodes = gltf.get("nodes", [])
    world_mats, parents = _compute_node_world_matrices(nodes)

    total_tris = 0
    all_y: list[float] = []
    meshes = gltf.get("meshes", [])
    for node_idx, node in enumerate(nodes):
        if "mesh" not in node:
            continue
        mesh = meshes[node["mesh"]]
        nw = world_mats[node_idx]
        for prim in mesh.get("primitives", []):
            mode = prim.get("mode", 4)
            pos_idx = prim.get("attributes", {}).get("POSITION")
            if pos_idx is None:
                continue
            verts = _read_accessor_vec3f(gltf, bin_data, pos_idx)
            if "indices" in prim:
                idx_count = gltf["accessors"][prim["indices"]]["count"]
            else:
                idx_count = len(verts)
            if mode == 4:
                total_tris += idx_count // 3
            elif mode in (5, 6):
                total_tris += max(0, idx_count - 2)
            for v in verts:
                wy = _mat4_transform_point(nw, v)[1]
                all_y.append(wy)

    if total_tris > min(15000, int(tri_budget)):
        errors.append(f"Triangle count {total_tris} exceeds budget {min(15000, int(tri_budget))}")

    if not all_y:
        errors.append("No mesh vertices found in model.glb")
    else:
        min_y, max_y = min(all_y), max(all_y)
        measured_h = max_y - min_y
        target_h = float(char_cfg["model"]["heightMeters"])
        if abs(measured_h - target_h) / target_h > 0.03:
            errors.append(f"Bounding-box height {measured_h:.4f}m deviates >3% from target {target_h:.4f}m")
        if not (-0.02 <= min_y <= 0.02):
            errors.append(f"Lowest vertex minY={min_y:.4f}m outside [-0.02m, +0.02m]")

    # 3. Rig & Animation Gate
    bone_map = char_cfg.get("boneMap", {})
    if set(bone_map.keys()) != CANONICAL_SOCKETS:
        errors.append(f"boneMap keys do not match 16 canonical sockets: {set(bone_map.keys()) ^ CANONICAL_SOCKETS}")

    skins = gltf.get("skins", [])
    if not skins:
        errors.append("No skin found in model.glb")
    else:
        joint_indices = set(skins[0].get("joints", []))
        name_to_node = {nodes[j].get("name"): j for j in joint_indices if "name" in nodes[j]}
        for sock, bname in bone_map.items():
            if bname not in name_to_node:
                errors.append(f"Socket {sock!r} -> bone {bname!r} missing from skin joints")
                continue
            j_idx = name_to_node[bname]
            if sock != "hips" and j_idx in parents and parents[j_idx] in joint_indices:
                p_idx = parents[j_idx]
                jp = (world_mats[j_idx][12], world_mats[j_idx][13], world_mats[j_idx][14])
                pp = (world_mats[p_idx][12], world_mats[p_idx][13], world_mats[p_idx][14])
                dist = math.dist(jp, pp)
                if dist < 0.01:
                    errors.append(f"Degenerate bone {bname}: distance to parent {dist:.4f}m < 0.01m")

        # Check rest-axis twist vs reference rig (< 5 deg) if common_anims.glb exists
        if os.path.isfile(COMMON_ANIMS_GLB) and not errors:
            ref_gltf, _ = _parse_glb(COMMON_ANIMS_GLB)
            ref_nodes = ref_gltf.get("nodes", [])
            ref_world, _ = _compute_node_world_matrices(ref_nodes)
            ref_by_name = {n.get("name"): idx for idx, n in enumerate(ref_nodes) if "name" in n}
            for bname in bone_map.values():
                if bname in name_to_node and bname in ref_by_name:
                    m_c = world_mats[name_to_node[bname]]
                    m_r = ref_world[ref_by_name[bname]]
                    # Compare normalized +Y bone axis
                    yc = (m_c[4], m_c[5], m_c[6])
                    yr = (m_r[4], m_r[5], m_r[6])
                    lc = math.sqrt(sum(x * x for x in yc)) or 1.0
                    lr = math.sqrt(sum(x * x for x in yr)) or 1.0
                    dot = max(-1.0, min(1.0, sum(yc[i] * yr[i] for i in range(3)) / (lc * lr)))
                    deg = math.degrees(math.acos(dot))
                    if deg >= 5.0:
                        errors.append(f"Bone {bname} rest twist {deg:.2f} deg >= 5.0 deg vs reference rig")

        # Animation clip checks
        canonical_clips: dict[str, int] = states_cfg["canonicalClips"]
        req_clips = set(states_cfg["gate0Clips"]) if clip_subset == "gate0" else set(canonical_clips.keys())
        anims_by_name = {a["name"]: a for a in gltf.get("animations", []) if "name" in a}
        mapped_node_indices = {name_to_node[b] for b in bone_map.values() if b in name_to_node}

        for cname in sorted(req_clips):
            if cname not in anims_by_name:
                errors.append(f"Missing required animation clip: {cname}")
                continue
            anim = anims_by_name[cname]
            expected_n = canonical_clips[cname]
            rot_nodes = set()
            for ch in anim.get("channels", []):
                t_node = ch.get("target", {}).get("node")
                t_path = ch.get("target", {}).get("path")
                if t_path == "rotation" and t_node in mapped_node_indices:
                    rot_nodes.add(t_node)
                    sampler = anim["samplers"][ch["sampler"]]
                    inp_acc = gltf["accessors"][sampler["input"]]
                    bv = gltf["bufferViews"][inp_acc["bufferView"]]
                    off = bv.get("byteOffset", 0) + inp_acc.get("byteOffset", 0)
                    key_count = inp_acc["count"]
                    first_t = struct.unpack_from("<f", bin_data, off)[0]
                    last_t = struct.unpack_from("<f", bin_data, off + (key_count - 1) * 4)[0]
                    if abs(first_t) > 1e-5:
                        errors.append(f"Clip {cname} first key at t={first_t:.5f} != 0.0")
                    if key_count < expected_n + 1:
                        errors.append(f"Clip {cname} has {key_count} keys, expected >= {expected_n + 1}")
                    if round(last_t * 60.0) < expected_n:
                        errors.append(f"Clip {cname} round(duration*60)={round(last_t*60.0)} < {expected_n}")
            if len(rot_nodes) < 16:
                errors.append(f"Clip {cname} has rotation channels for {len(rot_nodes)}/16 canonical bones")

    # 4. Frame-Data & AI Integrity Gate
    moves = moveset_cfg.get("moves", {})
    if not moves:
        errors.append("moveset.json#moves is empty")

    canonical_clips = states_cfg["canonicalClips"]
    cancel_graph: dict[str, list[str]] = {}

    for move_id, mv in moves.items():
        mtype = mv.get("type")
        total_f = mv.get("totalFrames", 0)
        anim_name = mv.get("animation")
        if anim_name not in canonical_clips:
            errors.append(f"Move {move_id} references unknown animation {anim_name!r}")
        elif canonical_clips[anim_name] < total_f:
            errors.append(f"Move {move_id} totalFrames {total_f} > clip {anim_name} length {canonical_clips[anim_name]}")

        hbs = mv.get("hitboxes", [])
        if mtype in ("STRIKE", "THROW") and not hbs:
            errors.append(f"Move {move_id} of type {mtype} must define non-empty hitboxes")
        if mtype not in ("STRIKE", "THROW") and hbs:
            errors.append(f"Move {move_id} of type {mtype} must not define strike/throw hitboxes")

        for hb in hbs:
            sf, ef = hb.get("startFrame", 0), hb.get("endFrame", 0)
            if not (1 <= sf <= ef < total_f):
                errors.append(f"Move {move_id} hitbox {hb.get('id')} invalid window [{sf}, {ef}] vs totalFrames {total_f}")
            if hb.get("socket") not in bone_map:
                errors.append(f"Move {move_id} hitbox references unknown socket {hb.get('socket')!r}")
            if "endSocket" in hb and hb["endSocket"] not in bone_map:
                errors.append(f"Move {move_id} hitbox references unknown endSocket {hb.get('endSocket')!r}")
            if mtype == "THROW":
                rel_f = hb.get("throwReleaseFrame", 0)
                if not (ef < rel_f < total_f):
                    errors.append(f"Move {move_id} throwReleaseFrame {rel_f} must satisfy {ef} < rel < {total_f}")

        for vw in mv.get("velocity", []):
            if not (1 <= vw.get("startFrame", 0) <= vw.get("endFrame", 0) < total_f):
                errors.append(f"Move {move_id} invalid velocity window")

        if "armor" in mv and mv["armor"]:
            ar = mv["armor"]
            if not (1 <= ar.get("startFrame", 0) <= ar.get("endFrame", 0) < total_f):
                errors.append(f"Move {move_id} invalid armor window")

        if "tracking" in mv and mv["tracking"]:
            tr = mv["tracking"]
            if not (1 <= tr.get("startFrame", 0) <= tr.get("endFrame", 0) < total_f):
                errors.append(f"Move {move_id} invalid tracking window")

        if mtype == "PROJECTILE":
            proj = mv.get("projectile", {})
            for spf in proj.get("spawnFrames", []):
                if not (1 <= spf < total_f):
                    errors.append(f"Move {move_id} invalid projectile spawnFrame {spf}")
            if proj.get("socket") not in bone_map:
                errors.append(f"Move {move_id} projectile references unknown socket")

        if mtype == "TELEPORT":
            tp = mv.get("teleport", {})
            vf, rf = tp.get("vanishFrame", 0), tp.get("reappearFrame", 0)
            inv = tp.get("invulnerableFrames", [0, 0])
            if not (1 <= vf <= rf < total_f) or not (1 <= inv[0] <= inv[1] < total_f):
                errors.append(f"Move {move_id} invalid teleport frame window")

        cancel_targets: list[str] = []
        for cw in mv.get("cancels", []):
            if not (1 <= cw.get("startFrame", 0) <= cw.get("endFrame", 0) < total_f):
                errors.append(f"Move {move_id} invalid cancel window")
            for tgt in cw.get("targets", []):
                if tgt not in moves and tgt != "homing_dash":
                    errors.append(f"Move {move_id} cancel references unknown move {tgt!r}")
                elif tgt in moves and moves[tgt].get("type") in ("STRIKE", "PROJECTILE", "THROW") and mtype in ("STRIKE", "PROJECTILE", "THROW"):
                    cancel_targets.append(tgt)
        if mtype in ("STRIKE", "PROJECTILE", "THROW"):
            cancel_graph[move_id] = cancel_targets

    # DFS cycle detection on cancel_graph
    visited: dict[str, int] = {}

    def has_cycle(node: str) -> bool:
        visited[node] = 1
        for nxt in cancel_graph.get(node, []):
            st = visited.get(nxt, 0)
            if st == 1 or (st == 0 and has_cycle(nxt)):
                return True
        visited[node] = 2
        return False

    for m_node in cancel_graph:
        if visited.get(m_node, 0) == 0 and has_cycle(m_node):
            errors.append(f"Cycle detected in move cancel graph starting at {m_node!r}")
            break

    # AI referential integrity
    for route in ai_cfg.get("comboRoutes", []):
        if route.get("starter") not in moves:
            errors.append(f"AI comboRoute {route.get('id')} unknown starter {route.get('starter')!r}")
        for step in route.get("sequence", []):
            if step not in moves and step not in UNIVERSAL_AI_ACTIONS:
                errors.append(f"AI comboRoute {route.get('id')} unknown step {step!r}")
    for trig in ai_cfg.get("triggers", []):
        act = trig.get("action")
        if act not in moves and act not in UNIVERSAL_AI_ACTIONS:
            errors.append(f"AI trigger {trig.get('id')} unknown action {act!r}")

    if not errors:
        now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
        manifest["validation"] = {
            "automated": "pass",
            "checked_at": now_iso,
        }
        approve_char.write_manifest_files(char_dir, manifest)

    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("char_dirs", nargs="*")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--clips", choices=["gate0", "all"], default="all")
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

    any_failed = False
    for t in targets:
        errs = validate_character(t, clip_subset=args.clips)
        if errs:
            any_failed = True
            for e in errs:
                print(f"FAIL [{os.path.basename(t)}]: {e}", file=sys.stderr)
        else:
            print(f"OK: Validated {os.path.basename(t)} (--clips {args.clips})")
    return 1 if any_failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
