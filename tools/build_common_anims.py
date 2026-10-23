#!/usr/bin/env python3
"""Headless Blender 5.2.1 generator for engine_assets/common_anims.glb (1.80m reference rig + 27 NLA clips)."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Euler, Quaternion, Vector

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMMON_STATES_PATH = os.path.join(ROOT_DIR, "engine_assets", "common_states.json")
OUTPUT_GLB_PATH = os.path.join(ROOT_DIR, "engine_assets", "common_anims.glb")

# Canonical 1.80m reference bone layout in Blender Z-up space (-Y = glTF +Z forward, +Z = glTF +Y up).
# All arms/legs hang vertically along -Z in rest pose with roll = 0 so pitch about +X rotates limbs in the YZ sagittal plane.
REF_BONES = [
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


def _quat_from_deg(rx: float = 0.0, ry: float = 0.0, rz: float = 0.0) -> Quaternion:
    return Euler((math.radians(rx), math.radians(ry), math.radians(rz)), "XYZ").to_quaternion()


def _reset_pose(arm_obj: bpy.types.Object) -> None:
    for pb in arm_obj.pose.bones:
        pb.rotation_mode = "QUATERNION"
        pb.location = (0.0, 0.0, 0.0)
        pb.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
        pb.scale = (1.0, 1.0, 1.0)


def _key_all_bones(arm_obj: bpy.types.Object, frame: int) -> None:
    for pb in arm_obj.pose.bones:
        pb.keyframe_insert(data_path="rotation_quaternion", frame=frame)
        if pb.name == "Hips":
            pb.keyframe_insert(data_path="location", frame=frame)


def _pose_clip_frame(arm_obj: bpy.types.Object, clip_name: str, f: int, total_n: int) -> None:
    _reset_pose(arm_obj)
    pbs = arm_obj.pose.bones
    u = f / float(max(1, total_n))
    s = math.sin(2.0 * math.pi * u)

    # Note on bone-local axes for downward (-Z_blender) rest bones (Arms, Legs):
    # In Edit Mode, bone Y points from head to tail (0, 0, -1).
    # Rotating UpperArm.R by rx = -90 deg in bone-local X swings the arm forward to -Y_blender (+Z_gltf)!
    if clip_name == "idle":
        pbs["Hips"].location = (0.0, 0.0, -0.015 * abs(s))
        pbs["Spine"].rotation_quaternion = _quat_from_deg(rx=3.0 * s)
        pbs["UpperArm.L"].rotation_quaternion = _quat_from_deg(rx=-25.0, rz=-10.0)
        pbs["ForeArm.L"].rotation_quaternion = _quat_from_deg(rx=-45.0)
        pbs["UpperArm.R"].rotation_quaternion = _quat_from_deg(rx=-25.0, rz=10.0)
        pbs["ForeArm.R"].rotation_quaternion = _quat_from_deg(rx=-45.0)

    elif clip_name in ("walk_forward", "walk_back", "strafe_left", "strafe_right", "dash_forward"):
        amp = 28.0 if clip_name != "dash_forward" else 42.0
        pbs["Hips"].location = (0.0, 0.0, -0.02 * abs(s))
        pbs["Thigh.L"].rotation_quaternion = _quat_from_deg(rx=-amp * s)
        pbs["Thigh.R"].rotation_quaternion = _quat_from_deg(rx=amp * s)
        pbs["UpperArm.L"].rotation_quaternion = _quat_from_deg(rx=amp * 0.7 * s)
        pbs["UpperArm.R"].rotation_quaternion = _quat_from_deg(rx=-amp * 0.7 * s)

    elif clip_name == "light_1":
        # 24f jab: active on fighting frames 7..11 -> Blender frames 6..10.
        if f < 5:
            t = f / 5.0
            pbs["Spine"].rotation_quaternion = _quat_from_deg(rx=20.0 * t)
            pbs["UpperArm.R"].rotation_quaternion = _quat_from_deg(rx=-35.0 * t)
            pbs["ForeArm.R"].rotation_quaternion = _quat_from_deg(rx=-50.0 * t)
        elif 5 <= f <= 11:
            # Spine leans 20 deg forward; UpperArm.R rotates -110 deg so arm extends horizontally along +Z_gltf
            pbs["Spine"].rotation_quaternion = _quat_from_deg(rx=20.0)
            pbs["UpperArm.R"].rotation_quaternion = _quat_from_deg(rx=-110.0)
            pbs["ForeArm.R"].rotation_quaternion = _quat_from_deg(rx=0.0)
            pbs["Hand.R"].rotation_quaternion = _quat_from_deg(rx=0.0)
        else:
            t = max(0.0, 1.0 - (f - 11) / float(max(1, total_n - 11)))
            pbs["Spine"].rotation_quaternion = _quat_from_deg(rx=20.0 * t)
            pbs["UpperArm.R"].rotation_quaternion = _quat_from_deg(rx=-110.0 * t)

    elif clip_name in ("light_2", "light_3", "heavy_neutral", "heavy_forward", "special_rush"):
        active = 0.20 <= u <= 0.55
        ang = -90.0 if active else -35.0 * math.sin(math.pi * u)
        target_arm = "UpperArm.L" if clip_name == "light_2" else "UpperArm.R"
        pbs[target_arm].rotation_quaternion = _quat_from_deg(rx=ang)

    elif clip_name in ("heavy_launcher", "air_light_1", "air_light_2", "air_heavy"):
        active = 0.22 <= u <= 0.55
        ang = -105.0 if active else -30.0
        pbs["UpperArm.R"].rotation_quaternion = _quat_from_deg(rx=ang)
        pbs["Thigh.R"].rotation_quaternion = _quat_from_deg(rx=-45.0 if active else -15.0)

    elif clip_name == "throw_grab":
        # 46f command grab: active frames 9..13 (Blender 8..12), release frame 28 (Blender 27).
        # Hold steady forward reach across Blender frames 7..28 so latched aim has zero vertical drift.
        if f < 7:
            t = f / 7.0
            pbs["Spine"].rotation_quaternion = _quat_from_deg(rx=20.0 * t)
            pbs["UpperArm.R"].rotation_quaternion = _quat_from_deg(rx=-110.0 * t)
            pbs["UpperArm.L"].rotation_quaternion = _quat_from_deg(rx=-70.0 * t)
        elif 7 <= f <= 28:
            pbs["Spine"].rotation_quaternion = _quat_from_deg(rx=20.0)
            pbs["UpperArm.R"].rotation_quaternion = _quat_from_deg(rx=-110.0)
            pbs["ForeArm.R"].rotation_quaternion = _quat_from_deg(rx=0.0)
            pbs["Hand.R"].rotation_quaternion = _quat_from_deg(rx=0.0)
            pbs["UpperArm.L"].rotation_quaternion = _quat_from_deg(rx=-75.0)
        else:
            t = max(0.0, 1.0 - (f - 28) / float(max(1, total_n - 28)))
            pbs["Spine"].rotation_quaternion = _quat_from_deg(rx=20.0 * t)
            pbs["UpperArm.R"].rotation_quaternion = _quat_from_deg(rx=-110.0 * t)
            pbs["UpperArm.L"].rotation_quaternion = _quat_from_deg(rx=-75.0 * t)

    elif clip_name == "special_projectile":
        active = 0.25 <= u <= 0.65
        pbs["UpperArm.R"].rotation_quaternion = _quat_from_deg(rx=-90.0 if active else -30.0)

    elif clip_name in ("guard", "guard_crush"):
        lean = -18.0 if clip_name == "guard_crush" else 5.0
        pbs["Spine"].rotation_quaternion = _quat_from_deg(rx=lean)
        pbs["UpperArm.L"].rotation_quaternion = _quat_from_deg(rx=-65.0)
        pbs["ForeArm.L"].rotation_quaternion = _quat_from_deg(rx=-75.0)
        pbs["UpperArm.R"].rotation_quaternion = _quat_from_deg(rx=-65.0)
        pbs["ForeArm.R"].rotation_quaternion = _quat_from_deg(rx=-75.0)

    elif clip_name == "hitstun":
        # Keep chest steady during hitstun/thrown pin while tilting head slightly
        pbs["Head"].rotation_quaternion = _quat_from_deg(rx=-12.0 * math.sin(math.pi * u))

    elif clip_name in ("launched", "wall_bounce"):
        pbs["Spine"].rotation_quaternion = _quat_from_deg(rx=-25.0)
        pbs["UpperArm.L"].rotation_quaternion = _quat_from_deg(rx=-40.0)
        pbs["UpperArm.R"].rotation_quaternion = _quat_from_deg(rx=-40.0)

    elif clip_name == "knockdown":
        pbs["Hips"].location = (0.0, 0.0, -0.45 * min(1.0, u * 1.5))
        pbs["Spine"].rotation_quaternion = _quat_from_deg(rx=-55.0 * min(1.0, u * 1.5))

    elif clip_name in ("wakeup", "step_dodge", "jump_loop"):
        pbs["Hips"].location = (0.0, 0.0, -0.10 * math.sin(math.pi * u))
        pbs["Spine"].rotation_quaternion = _quat_from_deg(rx=10.0 * math.sin(math.pi * u))


def build_common_anims(clip_subset: str = "all") -> None:
    with open(COMMON_STATES_PATH, "r", encoding="utf-8") as fp:
        states_cfg = json.load(fp)

    canonical_clips: dict[str, int] = states_cfg["canonicalClips"]
    if clip_subset == "gate0":
        selected_names = states_cfg["gate0Clips"]
    else:
        selected_names = list(canonical_clips.keys())

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = 60
    scene.render.fps_base = 1.0

    arm_data = bpy.data.armatures.new("CanonicalRefRig")
    arm_obj = bpy.data.objects.new("CanonicalRefRig", arm_data)
    scene.collection.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj

    bpy.ops.object.mode_set(mode="EDIT")
    edit_bones = arm_data.edit_bones
    created: dict[str, bpy.types.EditBone] = {}
    for name, parent_name, head, tail in REF_BONES:
        eb = edit_bones.new(name)
        eb.head = Vector(head)
        eb.tail = Vector(tail)
        eb.roll = 0.0
        if parent_name:
            eb.parent = created[parent_name]
            eb.use_connect = False
        created[name] = eb
    bpy.ops.object.mode_set(mode="OBJECT")

    # Determine exact bone-local rotation that points UpperArm.R straight forward along -Y_blender (+Z_gltf)
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
            _pose_clip_frame(arm_obj, clip_name, f, total_n)
            _key_all_bones(arm_obj, f)

        track = arm_obj.animation_data.nla_tracks.new()
        track.name = clip_name
        strip = track.strips.new(clip_name, 0, act)
        strip.name = clip_name
        strip.action_slot = slot
        strip.frame_start = 0
        strip.frame_end = total_n
        arm_obj.animation_data.action = None

    os.makedirs(os.path.dirname(OUTPUT_GLB_PATH), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUTPUT_GLB_PATH,
        export_format="GLB",
        export_yup=True,
        export_animation_mode="NLA_TRACKS",
        export_force_sampling=True,
        export_optimize_animation_size=False,
        export_optimize_animation_keep_anim_armature=True,
        export_draco_mesh_compression_enable=False,
    )
    print(f"OK: Exported {len(selected_names)} clips to {OUTPUT_GLB_PATH}")


def main() -> None:
    argv = sys.argv
    extra = argv[argv.index("--") + 1 :] if "--" in argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--clips", choices=["gate0", "all"], default="all")
    args = parser.parse_args(extra)
    build_common_anims(args.clips)


if __name__ == "__main__":
    main()
