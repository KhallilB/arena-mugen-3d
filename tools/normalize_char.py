#!/usr/bin/env python3
"""Headless Blender 5.2.1 multi-height character normalizer & 27-clip NLA baker (<300 LOC)."""

from __future__ import annotations

import argparse
import json
import math
import os
import struct
import sys

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMMON_ANIMS_GLB = os.path.join(ROOT_DIR, "engine_assets", "common_anims.glb")
COMMON_STATES_JSON = os.path.join(ROOT_DIR, "engine_assets", "common_states.json")

CANONICAL_BONES = [
    ("Hips", None, (0.0, 0.0, 0.95), (0.0, 0.0, 1.08)),
    ("Spine", "Hips", (0.0, 0.0, 1.08), (0.0, 0.0, 1.26)),
    ("Chest", "Spine", (0.0, 0.0, 1.26), (0.0, 0.0, 1.48)),
    ("Head", "Chest", (0.0, 0.0, 1.48), (0.0, 0.0, 1.72)),
    ("UpperArm.L", "Chest", (0.20, 0.0, 1.46), (0.20, 0.0, 1.15)),
    ("ForeArm.L", "UpperArm.L", (0.20, 0.0, 1.15), (0.20, 0.0, 0.89)),
    ("Hand.L", "ForeArm.L", (0.20, 0.0, 0.89), (0.20, 0.0, 0.77)),
    ("UpperArm.R", "Chest", (-0.20, 0.0, 1.46), (-0.20, 0.0, 1.15)),
    ("ForeArm.R", "UpperArm.R", (-0.20, 0.0, 1.15), (-0.20, 0.0, 0.89)),
    ("Hand.R", "ForeArm.R", (-0.20, 0.0, 0.89), (-0.20, 0.0, 0.77)),
    ("Thigh.L", "Hips", (0.10, 0.0, 0.95), (0.10, 0.0, 0.50)),
    ("Shin.L", "Thigh.L", (0.10, 0.0, 0.50), (0.10, 0.0, 0.07)),
    ("Foot.L", "Shin.L", (0.10, 0.0, 0.07), (0.10, -0.13, 0.02)),
    ("Thigh.R", "Hips", (-0.10, 0.0, 0.95), (-0.10, 0.0, 0.50)),
    ("Shin.R", "Thigh.R", (-0.10, 0.0, 0.50), (-0.10, 0.0, 0.07)),
    ("Foot.R", "Shin.R", (-0.10, 0.0, 0.07), (-0.10, -0.13, 0.02)),
]

BONE_ALIASES = {
    "mixamorig:Hips": "Hips", "hips": "Hips",
    "mixamorig:Spine": "Spine", "spine": "Spine",
    "mixamorig:Spine1": "Chest", "mixamorig:Spine2": "Chest", "chest": "Chest",
    "mixamorig:Head": "Head", "head": "Head",
    "mixamorig:LeftArm": "UpperArm.L", "upper_arm_l": "UpperArm.L",
    "mixamorig:LeftForeArm": "ForeArm.L", "forearm_l": "ForeArm.L",
    "mixamorig:LeftHand": "Hand.L", "hand_l": "Hand.L",
    "mixamorig:RightArm": "UpperArm.R", "upper_arm_r": "UpperArm.R",
    "mixamorig:RightForeArm": "ForeArm.R", "forearm_r": "ForeArm.R",
    "mixamorig:RightHand": "Hand.R", "hand_r": "Hand.R",
    "mixamorig:LeftUpLeg": "Thigh.L", "thigh_l": "Thigh.L",
    "mixamorig:LeftLeg": "Shin.L", "shin_l": "Shin.L",
    "mixamorig:LeftFoot": "Foot.L", "foot_l": "Foot.L",
    "mixamorig:RightUpLeg": "Thigh.R", "thigh_r": "Thigh.R",
    "mixamorig:RightLeg": "Shin.R", "shin_r": "Shin.R",
    "mixamorig:RightFoot": "Foot.R", "foot_r": "Foot.R",
}


def _load_ref_clips_from_glb(glb_path: str) -> dict[str, dict[str, dict[str, list[tuple[float, ...]]]]]:
    with open(glb_path, "rb") as fp:
        data = fp.read()
    json_len = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20 : 20 + json_len])
    bin_data = data[28 + json_len :]
    nodes = gltf["nodes"]
    clips: dict[str, dict[str, dict[str, list[tuple[float, ...]]]]] = {}
    for anim in gltf.get("animations", []):
        cname = anim["name"]
        clips[cname] = {}
        for ch in anim["channels"]:
            bname = nodes[ch["target"]["node"]].get("name", "")
            path = ch["target"]["path"]
            sampler = anim["samplers"][ch["sampler"]]
            acc = gltf["accessors"][sampler["output"]]
            bv = gltf["bufferViews"][acc["bufferView"]]
            off = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
            count = acc["count"]
            if path == "rotation":
                vals = [struct.unpack_from("<4f", bin_data, off + i * 16) for i in range(count)]
            elif path == "translation":
                vals = [struct.unpack_from("<3f", bin_data, off + i * 12) for i in range(count)]
            else:
                continue
            clips[cname].setdefault(bname, {})[path] = vals
    return clips


def _skin_meshes_to_armature(meshes: list[bpy.types.Object], arm_obj: bpy.types.Object, bone_heads_tails: dict[str, tuple[Vector, Vector]]) -> None:
    for m_obj in meshes:
        m_obj.parent = arm_obj
        m_obj.modifiers.clear()
        mod = m_obj.modifiers.new(name="Armature", type="ARMATURE")
        mod.object = arm_obj
        m_obj.vertex_groups.clear()
        vgroups = {bname: m_obj.vertex_groups.new(name=bname) for bname in bone_heads_tails}
        mw = m_obj.matrix_world
        for v in m_obj.data.vertices:
            wv = mw @ v.co
            best_bone = "Chest"
            best_dist = 1e9
            for bname, (h, t) in bone_heads_tails.items():
                seg = t - h
                seg_len_sq = seg.length_squared
                if seg_len_sq > 1e-8:
                    u = max(0.0, min(1.0, (wv - h).dot(seg) / seg_len_sq))
                    proj = h + u * seg
                else:
                    proj = h
                d = (wv - proj).length
                if d < best_dist:
                    best_dist = d
                    best_bone = bname
            vgroups[best_bone].add([v.index], 1.0, "REPLACE")


def normalize_character(char_dir: str, clip_subset: str = "all") -> None:
    char_dir = os.path.abspath(char_dir)
    char_json_path = os.path.join(char_dir, "character.json")
    with open(char_json_path, "r", encoding="utf-8") as fp:
        char_cfg = json.load(fp)
    with open(COMMON_STATES_JSON, "r", encoding="utf-8") as fp:
        states_cfg = json.load(fp)

    target_height = float(char_cfg["model"]["heightMeters"])
    shoulder_ratio = float(char_cfg["model"].get("shoulderWidthRatio", 1.0))
    spread_deg = float(char_cfg["model"].get("armSpreadOffsetDeg", 0.0))
    scale_h = target_height / 1.80

    raw_glb = os.path.join(char_dir, ".cache", "raw_model.glb")
    out_glb = os.path.join(char_dir, "model.glb")
    src_glb = raw_glb if os.path.exists(raw_glb) else out_glb
    if not os.path.exists(src_glb):
        raise FileNotFoundError(f"Missing input model at {raw_glb} or {out_glb}")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = 60
    scene.render.fps_base = 1.0

    bpy.ops.import_scene.gltf(filepath=src_glb)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"No mesh objects found in {src_glb}")

    # Clear parents and bake world transforms onto mesh vertices
    for m_obj in meshes:
        mw = m_obj.matrix_world.copy()
        m_obj.parent = None
        m_obj.matrix_world = Matrix.Identity(4)
        m_obj.data.transform(mw)
        m_obj.data.update()

    for o in list(bpy.data.objects):
        if o.type != "MESH":
            bpy.data.objects.remove(o, do_unlink=True)

    # Measure current Z-up bounding box and normalize height to target_height with minZ = 0.0
    all_z = [v.co.z for m in meshes for v in m.data.vertices]
    min_z, max_z = min(all_z), max(all_z)
    cur_h = max_z - min_z
    if cur_h < 1e-4:
        raise RuntimeError("Degenerate mesh with near-zero height")
    ratio = target_height / cur_h
    for m_obj in meshes:
        for v in m_obj.data.vertices:
            v.co.x *= ratio
            v.co.y *= ratio
            v.co.z = (v.co.z - min_z) * ratio
        m_obj.data.update()

    # Create canonical 16-bone armature scaled to target_height & shoulder_ratio
    arm_data = bpy.data.armatures.new("Armature")
    arm_obj = bpy.data.objects.new("Armature", arm_data)
    scene.collection.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj

    bpy.ops.object.mode_set(mode="EDIT")
    edit_bones = arm_data.edit_bones
    created: dict[str, bpy.types.EditBone] = {}
    bone_heads_tails: dict[str, tuple[Vector, Vector]] = {}
    for bname, parent_name, h_ref, t_ref in CANONICAL_BONES:
        eb = edit_bones.new(bname)
        sx = scale_h * (shoulder_ratio if "Arm" in bname or "Hand" in bname else 1.0)
        h_vec = Vector((h_ref[0] * sx, h_ref[1] * scale_h, h_ref[2] * scale_h))
        t_vec = Vector((t_ref[0] * sx, t_ref[1] * scale_h, t_ref[2] * scale_h))
        eb.head = h_vec
        eb.tail = t_vec
        eb.roll = 0.0
        if parent_name:
            eb.parent = created[parent_name]
            eb.use_connect = False
        created[bname] = eb
        bone_heads_tails[bname] = (h_vec, t_vec)
    bpy.ops.object.mode_set(mode="OBJECT")

    _skin_meshes_to_armature(meshes, arm_obj, bone_heads_tails)

    # Layer 2: Kinematic leg-span ratio k_leg = (Y_hips_target - Y_foot_target) / (Y_hips_ref - Y_foot_ref)
    y_hips_ref, y_foot_ref = 0.95, 0.07
    y_hips_tgt = bone_heads_tails["Hips"][0].z
    y_foot_tgt = bone_heads_tails["Foot.L"][0].z
    k_leg = (y_hips_tgt - y_foot_tgt) / (y_hips_ref - y_foot_ref)

    canonical_clips: dict[str, int] = states_cfg["canonicalClips"]
    selected_names = states_cfg["gate0Clips"] if clip_subset == "gate0" else list(canonical_clips.keys())

    # Regenerate poses directly using the canonical pose generator scaled by k_leg
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import build_common_anims as bca  # noqa: E402

    arm_obj.animation_data_create()
    for clip_name in selected_names:
        total_n = int(canonical_clips[clip_name])
        scene.frame_start = 0
        scene.frame_end = total_n

        act = bpy.data.actions.new(name=clip_name)
        slot = act.slots.new("OBJECT", arm_obj.name)
        arm_obj.animation_data.action = act
        arm_obj.animation_data.action_slot = slot

        for f in range(0, total_n + 1):
            scene.frame_set(f)
            bca._pose_clip_frame(arm_obj, clip_name, f, total_n)
            # Scale Hips displacement by k_leg
            hips_pb = arm_obj.pose.bones["Hips"]
            hips_pb.location = (
                hips_pb.location.x * k_leg,
                hips_pb.location.y * k_leg,
                hips_pb.location.z * k_leg,
            )
            # Apply optional armSpreadOffsetDeg on idle/locomotion clips
            if spread_deg != 0.0 and clip_name in ("idle", "walk_forward", "walk_back", "strafe_left", "strafe_right"):
                q_spread_l = Euler((0.0, 0.0, math.radians(-spread_deg)), "XYZ").to_quaternion()
                q_spread_r = Euler((0.0, 0.0, math.radians(spread_deg)), "XYZ").to_quaternion()
                arm_obj.pose.bones["UpperArm.L"].rotation_quaternion = q_spread_l @ arm_obj.pose.bones["UpperArm.L"].rotation_quaternion
                arm_obj.pose.bones["UpperArm.R"].rotation_quaternion = q_spread_r @ arm_obj.pose.bones["UpperArm.R"].rotation_quaternion
            bca._key_all_bones(arm_obj, f)

        track = arm_obj.animation_data.nla_tracks.new()
        track.name = clip_name
        strip = track.strips.new(clip_name, 0, act)
        strip.name = clip_name
        strip.action_slot = slot
        strip.frame_start = 0
        strip.frame_end = total_n
        arm_obj.animation_data.action = None

    bpy.ops.export_scene.gltf(
        filepath=out_glb,
        export_format="GLB",
        export_yup=True,
        export_animation_mode="NLA_TRACKS",
        export_force_sampling=True,
        export_optimize_animation_size=False,
        export_optimize_animation_keep_anim_armature=True,
        export_draco_mesh_compression_enable=False,
    )
    print(f"OK: Normalized {char_cfg['id']} ({target_height:.2f}m, k_leg={k_leg:.3f}) with {len(selected_names)} clips -> {out_glb}")


def main() -> None:
    argv = sys.argv
    extra = argv[argv.index("--") + 1 :] if "--" in argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("char_dir")
    parser.add_argument("--clips", choices=["gate0", "all"], default="all")
    args = parser.parse_args(extra)
    normalize_character(args.char_dir, args.clips)


if __name__ == "__main__":
    main()
