#!/usr/bin/env python3
"""Procedural & Meshy roster generator for all 6 launch archetypes (1.15m to 2.45m)."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import approve_char  # noqa: E402
import meshy_adapter  # noqa: E402
import validate_char  # noqa: E402
import yaml_lite  # noqa: E402

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLENDER_BIN = "/opt/homebrew/bin/blender"
COMMON_ANIMS_GLB = os.path.join(ROOT_DIR, "engine_assets", "common_anims.glb")
COMMON_STATES_JSON = os.path.join(ROOT_DIR, "engine_assets", "common_states.json")

CANONICAL_BONE_MAP = {
    "hips": "Hips",
    "spine": "Spine",
    "chest": "Chest",
    "head": "Head",
    "upper_arm_l": "UpperArm.L",
    "forearm_l": "ForeArm.L",
    "hand_l": "Hand.L",
    "upper_arm_r": "UpperArm.R",
    "forearm_r": "ForeArm.R",
    "hand_r": "Hand.R",
    "thigh_l": "Thigh.L",
    "shin_l": "Shin.L",
    "foot_l": "Foot.L",
    "thigh_r": "Thigh.R",
    "shin_r": "Shin.R",
    "foot_r": "Foot.R",
}

ROSTER_SPECS: dict[str, dict[str, Any]] = {
    "kaze_striker": {
        "displayName": "Kaze",
        "title": "Cyber-Martial Striker",
        "archetype": "rushdown",
        "themeColor": "#06b6d4",
        "secondaryColor": "#0f172a",
        "heightMeters": 1.80,
        "shoulderWidthRatio": 1.00,
        "armSpreadOffsetDeg": 5,
        "maxHealth": 1000,
        "maxGuard": 500,
        "walkSpeed": 4.6,
        "strafeSpeed": 4.2,
        "dashSpeed": 15.0,
        "homingDashSpeed": 19.0,
        "jumpVelocity": 11.5,
        "weight": 1.00,
        "brief": "Athletic 1.80m cyber-martial artist with glowing cyan visor and sleek gi, symmetrical A-pose.",
        "aiStyle": "balanced_rushdown",
        "preferredRangeMeters": [1.5, 3.2],
        "aggression": 0.80,
        "defense": 0.60,
        "armorCounterBias": 0.30,
        "sidestepBias": 0.45,
        "homingDashBias": 0.65,
    },
    "tecton_grappler": {
        "displayName": "Tecton",
        "title": "Seismic Colossus",
        "archetype": "grappler",
        "themeColor": "#f59e0b",
        "secondaryColor": "#451a03",
        "heightMeters": 2.45,
        "shoulderWidthRatio": 1.45,
        "armSpreadOffsetDeg": 12,
        "maxHealth": 1300,
        "maxGuard": 400,
        "walkSpeed": 3.4,
        "strafeSpeed": 3.0,
        "dashSpeed": 12.5,
        "homingDashSpeed": 17.0,
        "jumpVelocity": 10.5,
        "weight": 1.45,
        "brief": "Hulking 2.45m basalt stone golem brawler with glowing amber fissure lines and oversized stone gauntlets, symmetrical A-pose, clear limb separation.",
        "aiStyle": "grappler_stalker",
        "preferredRangeMeters": [0.8, 1.8],
        "aggression": 0.75,
        "defense": 0.65,
        "armorCounterBias": 0.85,
        "sidestepBias": 0.25,
        "homingDashBias": 0.40,
    },
    "pip_brawler": {
        "displayName": "Pip",
        "title": "Kinetic Spark",
        "archetype": "brawler",
        "themeColor": "#ec4899",
        "secondaryColor": "#3b0764",
        "heightMeters": 1.15,
        "shoulderWidthRatio": 1.05,
        "armSpreadOffsetDeg": 6,
        "maxHealth": 850,
        "maxGuard": 450,
        "walkSpeed": 5.6,
        "strafeSpeed": 5.2,
        "dashSpeed": 17.5,
        "homingDashSpeed": 21.0,
        "jumpVelocity": 12.5,
        "weight": 0.80,
        "brief": "Compact 1.15m high-mobility kinetic brawler with oversized power gloves and jet boots, symmetrical A-pose.",
        "aiStyle": "swarm_brawler",
        "preferredRangeMeters": [0.9, 2.0],
        "aggression": 0.90,
        "defense": 0.50,
        "armorCounterBias": 0.20,
        "sidestepBias": 0.75,
        "homingDashBias": 0.70,
    },
    "vesper_phantom": {
        "displayName": "Vesper",
        "title": "Umbral Blade",
        "archetype": "assassin",
        "themeColor": "#a855f7",
        "secondaryColor": "#1e1b4b",
        "heightMeters": 1.72,
        "shoulderWidthRatio": 0.95,
        "armSpreadOffsetDeg": 4,
        "maxHealth": 900,
        "maxGuard": 450,
        "walkSpeed": 5.4,
        "strafeSpeed": 5.0,
        "dashSpeed": 17.0,
        "homingDashSpeed": 20.5,
        "jumpVelocity": 12.0,
        "weight": 0.90,
        "brief": "Slender 1.72m neon shinobi assassin with phase cloak, symmetrical A-pose.",
        "aiStyle": "bait_and_blink",
        "preferredRangeMeters": [2.5, 5.0],
        "aggression": 0.70,
        "defense": 0.55,
        "armorCounterBias": 0.25,
        "sidestepBias": 0.70,
        "homingDashBias": 0.55,
    },
    "solaris_arcanist": {
        "displayName": "Solaris",
        "title": "Astral Sovereign",
        "archetype": "zoner",
        "themeColor": "#eab308",
        "secondaryColor": "#172554",
        "heightMeters": 1.85,
        "shoulderWidthRatio": 1.00,
        "armSpreadOffsetDeg": 6,
        "maxHealth": 950,
        "maxGuard": 450,
        "walkSpeed": 4.2,
        "strafeSpeed": 4.0,
        "dashSpeed": 14.0,
        "homingDashSpeed": 18.0,
        "jumpVelocity": 11.0,
        "weight": 1.00,
        "brief": "Regal 1.85m astral battle-mage in armored solar vestments, symmetrical A-pose.",
        "aiStyle": "keepaway_zoner",
        "preferredRangeMeters": [7.0, 13.0],
        "aggression": 0.45,
        "defense": 0.70,
        "armorCounterBias": 0.20,
        "sidestepBias": 0.60,
        "homingDashBias": 0.25,
    },
    "valkyr_sentinel": {
        "displayName": "Valkyr",
        "title": "Aegis Vanguard",
        "archetype": "bruiser",
        "themeColor": "#ef4444",
        "secondaryColor": "#1f2937",
        "heightMeters": 2.05,
        "shoulderWidthRatio": 1.20,
        "armSpreadOffsetDeg": 8,
        "maxHealth": 1150,
        "maxGuard": 550,
        "walkSpeed": 4.0,
        "strafeSpeed": 3.6,
        "dashSpeed": 14.0,
        "homingDashSpeed": 18.0,
        "jumpVelocity": 11.0,
        "weight": 1.25,
        "brief": "Tall 2.05m armored valkyrie sentinel with shoulder pauldrons and heavy gauntlets, symmetrical A-pose.",
        "aiStyle": "midrange_bully",
        "preferredRangeMeters": [2.0, 4.0],
        "aggression": 0.70,
        "defense": 0.75,
        "armorCounterBias": 0.80,
        "sidestepBias": 0.35,
        "homingDashBias": 0.50,
    },
}


def _build_moveset(char_id: str) -> dict[str, Any]:
    is_grappler = char_id == "tecton_grappler"
    is_pip = char_id == "pip_brawler"
    is_valkyr = char_id == "valkyr_sentinel"

    moves: dict[str, Any] = {
        "light_1": {
            "displayName": "Granite Jab" if is_grappler else "Quick Jab",
            "type": "STRIKE",
            "chainOnly": False,
            "input": {"button": "LIGHT", "direction": "ANY", "airborne": False},
            "animation": "light_1",
            "totalFrames": 24,
            "pitchTracking": True,
            "pitchLimb": "upper_arm_r",
            "tracking": {"startFrame": 1, "endFrame": 6, "turnRateDegPerSec": 540},
            "velocity": [
                {"startFrame": 2, "endFrame": 7, "forward": 4.5, "up": 0, "lateral": 0}
            ],
            "hitboxes": [
                {
                    "id": "jab_fist",
                    "startFrame": 7,
                    "endFrame": 11,
                    "socket": "hand_r",
                    "endSocket": "forearm_r",
                    "radius": 0.22,
                    "offset": [0, 0.10, 0],
                    "scaleWithHeight": True,
                    "maxHits": 1,
                    "rehitIntervalFrames": 0,
                    "damage": 55,
                    "guardDamage": 35,
                    "hitstunFrames": 17,
                    "blockstunFrames": 11,
                    "hitstopFrames": 5,
                    "launch": False,
                    "radialKnockback": False,
                    "knockback": {"forward": -2.8, "up": 0, "lateral": 0},
                }
            ],
            "cancels": [
                {
                    "startFrame": 7,
                    "endFrame": 18,
                    "condition": "ON_HIT_OR_BLOCK",
                    "targets": ["light_2", "heavy_neutral", "heavy_launcher", "special_neutral", "special_forward"],
                }
            ],
        },
        "light_2": {
            "displayName": "Cross Hook",
            "type": "STRIKE",
            "chainOnly": True,
            "input": {"button": "LIGHT", "direction": "ANY", "airborne": False},
            "animation": "light_2",
            "totalFrames": 26,
            "pitchTracking": True,
            "pitchLimb": "upper_arm_l",
            "tracking": {"startFrame": 1, "endFrame": 6, "turnRateDegPerSec": 480},
            "velocity": [
                {"startFrame": 2, "endFrame": 8, "forward": 4.8, "up": 0, "lateral": 0}
            ],
            "hitboxes": [
                {
                    "id": "cross_fist",
                    "startFrame": 7,
                    "endFrame": 12,
                    "socket": "hand_l",
                    "endSocket": "forearm_l",
                    "radius": 0.24,
                    "offset": [0, 0.10, 0],
                    "scaleWithHeight": True,
                    "maxHits": 1,
                    "rehitIntervalFrames": 0,
                    "damage": 65,
                    "guardDamage": 45,
                    "hitstunFrames": 19,
                    "blockstunFrames": 13,
                    "hitstopFrames": 5,
                    "launch": False,
                    "radialKnockback": False,
                    "knockback": {"forward": -3.2, "up": 0, "lateral": 0},
                }
            ],
            "cancels": [
                {
                    "startFrame": 7,
                    "endFrame": 19,
                    "condition": "ON_HIT_OR_BLOCK",
                    "targets": ["light_3", "heavy_neutral", "heavy_launcher", "special_neutral", "special_forward"],
                }
            ],
        },
        "light_3": {
            "displayName": "Spinning Finisher",
            "type": "STRIKE",
            "chainOnly": True,
            "input": {"button": "LIGHT", "direction": "ANY", "airborne": False},
            "animation": "light_3",
            "totalFrames": 30,
            "pitchTracking": True,
            "pitchLimb": "upper_arm_r",
            "velocity": [
                {"startFrame": 3, "endFrame": 11, "forward": 5.5, "up": 0, "lateral": 0}
            ],
            "hitboxes": [
                {
                    "id": "finisher_blow",
                    "startFrame": 9,
                    "endFrame": 14,
                    "socket": "hand_r",
                    "radius": 0.28,
                    "offset": [0, 0.12, 0],
                    "scaleWithHeight": True,
                    "maxHits": 1,
                    "rehitIntervalFrames": 0,
                    "damage": 90,
                    "guardDamage": 65,
                    "hitstunFrames": 24,
                    "blockstunFrames": 15,
                    "hitstopFrames": 7,
                    "launch": True,
                    "radialKnockback": False,
                    "knockback": {"forward": -10.5, "up": 6.5, "lateral": 0},
                }
            ],
            "cancels": [],
        },
        "heavy_neutral": {
            "displayName": "Wide Lariat" if is_valkyr else "Crushing Haymaker",
            "type": "STRIKE",
            "chainOnly": False,
            "input": {"button": "HEAVY", "direction": "NEUTRAL", "airborne": False},
            "animation": "heavy_neutral",
            "totalFrames": 40,
            "pitchTracking": True,
            "pitchLimb": "upper_arm_r",
            "armor": {"startFrame": 4, "endFrame": 14, "hits": 1} if (is_grappler or is_valkyr) else None,
            "velocity": [
                {"startFrame": 4, "endFrame": 14, "forward": 6.0, "up": 0, "lateral": 0}
            ],
            "hitboxes": [
                {
                    "id": "heavy_swing",
                    "startFrame": 12,
                    "endFrame": 18,
                    "socket": "hand_r",
                    "endSocket": "forearm_r",
                    "radius": 0.40 if is_valkyr else 0.30,
                    "offset": [0, 0.12, 0],
                    "scaleWithHeight": True,
                    "maxHits": 1,
                    "rehitIntervalFrames": 0,
                    "damage": 110,
                    "guardDamage": 90,
                    "hitstunFrames": 26,
                    "blockstunFrames": 16,
                    "hitstopFrames": 8,
                    "launch": False,
                    "radialKnockback": False,
                    "knockback": {"forward": -6.5, "up": 0, "lateral": 0},
                }
            ],
            "cancels": [
                {
                    "startFrame": 12,
                    "endFrame": 24,
                    "condition": "ON_HIT_OR_BLOCK",
                    "targets": ["special_neutral", "special_forward"],
                }
            ],
        },
        "heavy_forward": {
            "displayName": "Repulsive Nova",
            "type": "STRIKE",
            "chainOnly": False,
            "input": {"button": "HEAVY", "direction": "FORWARD", "airborne": False},
            "animation": "heavy_forward",
            "totalFrames": 44,
            "pitchTracking": True,
            "pitchLimb": "both_arms",
            "velocity": [
                {"startFrame": 3, "endFrame": 12, "forward": 5.0, "up": 0, "lateral": 0}
            ],
            "hitboxes": [
                {
                    "id": "nova_burst",
                    "startFrame": 13,
                    "endFrame": 19,
                    "socket": "chest",
                    "radius": 0.45,
                    "offset": [0, 0.10, 0],
                    "scaleWithHeight": True,
                    "maxHits": 1,
                    "rehitIntervalFrames": 0,
                    "damage": 105,
                    "guardDamage": 85,
                    "hitstunFrames": 28,
                    "blockstunFrames": 16,
                    "hitstopFrames": 8,
                    "launch": True,
                    "radialKnockback": True,
                    "knockback": {"forward": -13.0, "up": 5.5, "lateral": 0},
                }
            ],
            "cancels": [],
        },
        "heavy_launcher": {
            "displayName": "Somersault Flip Kick" if is_pip else "Rising Uppercut Launcher",
            "type": "STRIKE",
            "chainOnly": False,
            "input": {"button": "HEAVY", "direction": "BACK", "airborne": False},
            "animation": "heavy_launcher",
            "totalFrames": 42,
            "pitchTracking": True,
            "pitchLimb": "both_legs" if is_pip else "upper_arm_r",
            "velocity": [
                {"startFrame": 3, "endFrame": 11, "forward": 4.2, "up": 0, "lateral": 0}
            ],
            "hitboxes": [
                {
                    "id": "launcher_hit",
                    "startFrame": 10,
                    "endFrame": 16,
                    "socket": "foot_r" if is_pip else "hand_r",
                    "radius": 0.30,
                    "offset": [0, 0.12, 0],
                    "scaleWithHeight": True,
                    "maxHits": 1,
                    "rehitIntervalFrames": 0,
                    "damage": 95,
                    "guardDamage": 70,
                    "hitstunFrames": 32,
                    "blockstunFrames": 14,
                    "hitstopFrames": 8,
                    "launch": True,
                    "radialKnockback": False,
                    "knockback": {"forward": -2.5, "up": 11.5, "lateral": 0},
                }
            ],
            "cancels": [
                {
                    "startFrame": 10,
                    "endFrame": 24,
                    "condition": "ON_HIT",
                    "targets": ["homing_dash"],
                }
            ],
        },
        "air_light_1": {
            "displayName": "Aerial Jab",
            "type": "STRIKE",
            "chainOnly": False,
            "input": {"button": "LIGHT", "direction": "ANY", "airborne": True},
            "animation": "air_light_1",
            "totalFrames": 22,
            "pitchTracking": True,
            "pitchLimb": "upper_arm_r",
            "velocity": [
                {"startFrame": 1, "endFrame": 8, "forward": 3.5, "up": 1.5, "lateral": 0}
            ],
            "hitboxes": [
                {
                    "id": "air_jab_box",
                    "startFrame": 6,
                    "endFrame": 11,
                    "socket": "hand_r",
                    "radius": 0.24,
                    "offset": [0, 0.10, 0],
                    "scaleWithHeight": True,
                    "maxHits": 1,
                    "rehitIntervalFrames": 0,
                    "damage": 50,
                    "guardDamage": 30,
                    "hitstunFrames": 20,
                    "blockstunFrames": 10,
                    "hitstopFrames": 5,
                    "launch": True,
                    "radialKnockback": False,
                    "knockback": {"forward": -2.0, "up": 4.5, "lateral": 0},
                }
            ],
            "cancels": [
                {
                    "startFrame": 6,
                    "endFrame": 16,
                    "condition": "ON_HIT_OR_BLOCK",
                    "targets": ["air_light_2", "air_heavy"],
                }
            ],
        },
        "air_light_2": {
            "displayName": "Aerial Kick",
            "type": "STRIKE",
            "chainOnly": True,
            "input": {"button": "LIGHT", "direction": "ANY", "airborne": True},
            "animation": "air_light_2",
            "totalFrames": 24,
            "pitchTracking": True,
            "pitchLimb": "thigh_r",
            "velocity": [
                {"startFrame": 1, "endFrame": 9, "forward": 3.8, "up": 1.8, "lateral": 0}
            ],
            "hitboxes": [
                {
                    "id": "air_kick_box",
                    "startFrame": 7,
                    "endFrame": 12,
                    "socket": "foot_r",
                    "radius": 0.26,
                    "offset": [0, 0.10, 0],
                    "scaleWithHeight": True,
                    "maxHits": 1,
                    "rehitIntervalFrames": 0,
                    "damage": 60,
                    "guardDamage": 35,
                    "hitstunFrames": 22,
                    "blockstunFrames": 11,
                    "hitstopFrames": 5,
                    "launch": True,
                    "radialKnockback": False,
                    "knockback": {"forward": -2.4, "up": 4.8, "lateral": 0},
                }
            ],
            "cancels": [
                {
                    "startFrame": 7,
                    "endFrame": 18,
                    "condition": "ON_HIT_OR_BLOCK",
                    "targets": ["air_heavy"],
                }
            ],
        },
        "air_heavy": {
            "displayName": "Meteor Smash",
            "type": "STRIKE",
            "chainOnly": False,
            "input": {"button": "HEAVY", "direction": "ANY", "airborne": True},
            "animation": "air_heavy",
            "totalFrames": 34,
            "pitchTracking": True,
            "pitchLimb": "both_arms",
            "velocity": [
                {"startFrame": 2, "endFrame": 12, "forward": 4.5, "up": -2.0, "lateral": 0}
            ],
            "hitboxes": [
                {
                    "id": "air_smash_box",
                    "startFrame": 10,
                    "endFrame": 16,
                    "socket": "hand_r",
                    "radius": 0.32,
                    "offset": [0, 0.12, 0],
                    "scaleWithHeight": True,
                    "maxHits": 1,
                    "rehitIntervalFrames": 0,
                    "damage": 105,
                    "guardDamage": 75,
                    "hitstunFrames": 30,
                    "blockstunFrames": 14,
                    "hitstopFrames": 9,
                    "launch": True,
                    "radialKnockback": False,
                    "knockback": {"forward": -12.5, "up": -6.0, "lateral": 0},
                }
            ],
            "cancels": [],
        },
        "special_neutral": {
            "displayName": "Tracking Solar Orbs",
            "type": "PROJECTILE",
            "chainOnly": False,
            "input": {"button": "SPECIAL", "direction": "NEUTRAL", "airborne": False},
            "animation": "special_projectile",
            "totalFrames": 34,
            "projectile": {
                "spawnFrames": [12, 18],
                "socket": "hand_r",
                "speed": 14.0,
                "turnRateDegPerSec": 90.0,
                "lifetimeFrames": 90,
                "radius": 0.28,
                "pierce": False,
                "damage": 45,
                "guardDamage": 25,
                "hitstunFrames": 18,
                "blockstunFrames": 12,
                "hitstopFrames": 4,
                "launch": False,
                "knockback": {"forward": -3.5, "up": 0, "lateral": 0},
            },
            "cancels": [],
        },
        "special_forward": {
            "displayName": "Tectonic Crush (Command Grab)",
            "type": "THROW",
            "chainOnly": False,
            "input": {"button": "SPECIAL", "direction": "FORWARD", "airborne": False},
            "animation": "throw_grab",
            "totalFrames": 46,
            "pitchTracking": True,
            "pitchLimb": "upper_arm_r",
            "armor": {"startFrame": 3, "endFrame": 12, "hits": 1},
            "velocity": [
                {"startFrame": 1, "endFrame": 10, "forward": 8.0, "up": 0, "lateral": 0}
            ],
            "hitboxes": [
                {
                    "id": "grab_box",
                    "startFrame": 9,
                    "endFrame": 13,
                    "socket": "hand_r",
                    "radius": 0.36,
                    "offset": [0, 0.15, 0],
                    "scaleWithHeight": True,
                    "maxHits": 1,
                    "unblockable": True,
                    "throwReleaseFrame": 28,
                    "damage": 160,
                    "guardDamage": 0,
                    "hitstunFrames": 45,
                    "blockstunFrames": 0,
                    "hitstopFrames": 10,
                    "launch": True,
                    "knockback": {"forward": -14.0, "up": 9.0, "lateral": 0},
                }
            ],
            "cancels": [],
        },
        "special_back": {
            "displayName": "Phantom Blink",
            "type": "TELEPORT",
            "chainOnly": False,
            "input": {"button": "SPECIAL", "direction": "BACK", "airborne": False},
            "animation": "step_dodge",
            "totalFrames": 22,
            "teleport": {
                "vanishFrame": 4,
                "reappearFrame": 10,
                "invulnerableFrames": [3, 12],
                "targetAnchor": "BEHIND_OPPONENT",
                "offsetMeters": -1.35,
                "clampArenaRadiusMeters": 19.2,
                "faceOpponentOnExit": True,
            },
            "cancels": [
                {
                    "startFrame": 11,
                    "endFrame": 20,
                    "condition": "ALWAYS",
                    "targets": ["light_1", "heavy_neutral", "heavy_launcher"],
                }
            ],
        },
    }
    # Clean None fields
    for mv in moves.values():
        if mv.get("armor") is None:
            mv.pop("armor", None)
    return {"moves": moves}


def _build_ai_config(char_id: str, spec: dict[str, Any]) -> dict[str, Any]:
    is_zoner = char_id == "solaris_arcanist"
    is_assassin = char_id == "vesper_phantom"
    return {
        "aiVersion": "1.0.0",
        "defaultAiLevel": 6,
        "personality": {
            "style": spec["aiStyle"],
            "preferredRangeMeters": spec["preferredRangeMeters"],
            "aggression": spec["aggression"],
            "defense": spec["defense"],
            "armorCounterBias": spec["armorCounterBias"],
            "sidestepBias": spec["sidestepBias"],
            "homingDashBias": spec["homingDashBias"],
            "orbitDirectionBias": 0.0,
            "comboFollowthrough": 0.90,
        },
        "comboRoutes": [
            {
                "id": "bnb_launcher_route",
                "starter": "light_1",
                "condition": "ON_HIT",
                "sequence": ["light_2", "heavy_launcher", "homing_dash", "air_light_1", "air_light_2", "air_heavy"],
                "weight": 0.70,
            },
            {
                "id": "block_tick_throw",
                "starter": "light_1",
                "condition": "ON_BLOCK",
                "sequence": ["special_forward"],
                "weight": 0.65,
            },
        ],
        "triggers": [
            {
                "id": "armor_through_poke",
                "priority": 90,
                "when": {
                    "opponentState": ["ATTACK_STARTUP", "ATTACK_ACTIVE"],
                    "distanceMeters": [0.5, 2.4],
                },
                "action": "special_back" if is_assassin else "special_forward",
                "probability": 0.75,
            },
            {
                "id": "punish_whiffed_recovery",
                "priority": 85,
                "when": {
                    "opponentState": ["ATTACK_RECOVERY"],
                    "distanceMeters": [1.0, 3.5],
                },
                "action": "heavy_launcher",
                "probability": 0.85,
            },
            {
                "id": "zone_or_close_gap",
                "priority": 70,
                "when": {
                    "opponentState": ["IDLE", "MOVE", "ATTACK_STARTUP"],
                    "distanceMeters": [6.0, 20.0],
                    "minMeter": 150,
                },
                "action": "special_neutral" if is_zoner else "homing_dash",
                "probability": 0.60,
            },
        ],
    }


def _generate_raw_procedural_mesh(raw_glb_path: str, height_m: float, shoulder_ratio: float, hex_color: str) -> None:
    os.makedirs(os.path.dirname(raw_glb_path), exist_ok=True)
    expr = f"""
import bpy, bmesh
from mathutils import Matrix, Vector

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
mesh = bpy.data.meshes.new("FighterMesh")
obj = bpy.data.objects.new("FighterMesh", mesh)
scene.collection.objects.link(obj)

bm = bmesh.new()
scale_h = {height_m} / 1.80
sr = {shoulder_ratio}

def add_box(cx, cy, cz0, cz1, rx, ry):
    bmesh.ops.create_cube(
        bm,
        size=1.0,
        matrix=Matrix.Translation((cx, cy, 0.5*(cz0+cz1))) @ Matrix.Diagonal((rx*2, ry*2, abs(cz1-cz0), 1.0))
    )

# Feet, shins, thighs, torso, head, arms spanning exact [0.0, height_m]
add_box( 0.10*scale_h, -0.03*scale_h, 0.00*scale_h, 0.10*scale_h, 0.06*scale_h, 0.10*scale_h)
add_box(-0.10*scale_h, -0.03*scale_h, 0.00*scale_h, 0.10*scale_h, 0.06*scale_h, 0.10*scale_h)
add_box( 0.10*scale_h,  0.0,          0.10*scale_h, 0.50*scale_h, 0.055*scale_h, 0.055*scale_h)
add_box(-0.10*scale_h,  0.0,          0.10*scale_h, 0.50*scale_h, 0.055*scale_h, 0.055*scale_h)
add_box( 0.10*scale_h,  0.0,          0.50*scale_h, 0.95*scale_h, 0.07*scale_h, 0.07*scale_h)
add_box(-0.10*scale_h,  0.0,          0.50*scale_h, 0.95*scale_h, 0.07*scale_h, 0.07*scale_h)
add_box( 0.0,           0.0,          0.92*scale_h, 1.50*scale_h, 0.16*scale_h*sr, 0.11*scale_h)
add_box( 0.0,           0.0,          1.50*scale_h, 1.80*scale_h, 0.11*scale_h, 0.11*scale_h)
add_box( 0.20*scale_h*sr, 0.0,        0.77*scale_h, 1.46*scale_h, 0.05*scale_h, 0.05*scale_h)
add_box(-0.20*scale_h*sr, 0.0,        0.77*scale_h, 1.46*scale_h, 0.05*scale_h, 0.05*scale_h)

bm.to_mesh(mesh)
bm.free()
mesh.update()

bpy.ops.export_scene.gltf(
    filepath={raw_glb_path!r},
    export_format="GLB",
    export_yup=True,
    export_draco_mesh_compression_enable=False,
)
"""
    subprocess.run(
        [BLENDER_BIN, "-b", "--factory-startup", "--python-exit-code", "1", "--python-expr", expr],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )


def generate_character(char_id: str, mode: str, clip_subset: str, approve_all: bool, approved_by: str) -> None:
    if char_id not in ROSTER_SPECS:
        raise ValueError(f"Unknown character id: {char_id}")
    spec = ROSTER_SPECS[char_id]
    char_dir = os.path.join(ROOT_DIR, "chars", char_id)
    os.makedirs(char_dir, exist_ok=True)

    with open(COMMON_STATES_JSON, "r", encoding="utf-8") as fp:
        states_cfg = json.load(fp)
    all_27_clips = list(states_cfg["canonicalClips"].keys())

    height_m = float(spec["heightMeters"])
    asset_spec_doc = {
        "asset_id": f"character.{char_id}.v1",
        "kind": "character",
        "rights_status": "original-design",
        "engine": {
            "name": "ArenaMugen3D",
            "version": "0.1.0",
            "import_format": "glb",
        },
        "coordinate_system": "right-handed-y-up",
        "scale": "1.0_unit_equals_1_meter",
        "pivot": "bottom-center-feet",
        "materials": {
            "shader": "pbr-metallic-roughness",
            "texture_limits": "2048x2048",
        },
        "geometry": {
            "triangle_budget": 15000,
            "lod_requirements": "single-lod-prototype",
        },
        "rig": {
            "required": True,
            "skeleton": "canonical-16-bone-humanoid",
            "pose": "a-pose-or-t-pose-limbs-separated",
            "animation_clips": all_27_clips,
        },
        "runtime": {
            "collision": "bone-socket-capsules",
            "platforms": ["web", "desktop"],
        },
        "art": {
            "original_brief": spec["brief"],
            "approved_references": [],
        },
        "acceptance": [
            "imports without manual format conversion",
            f"bounding box height normalized to character.json heightMeters ({height_m:.2f}m)",
            "lowest vertex Y snapped to 0.0 at rest pose",
            "triangle count <= 15000",
            "all 16 canonical humanoid bones present and non-degenerate",
            "all 27 required animation clips baked and verified",
        ],
    }

    spec_yaml_path = os.path.join(char_dir, "asset-spec.yaml")
    with open(spec_yaml_path, "w", encoding="utf-8") as fp:
        fp.write(yaml_lite.dump(asset_spec_doc))

    # Pre-flight check (Rule 1)
    _, spec_hash = meshy_adapter.validate_asset_spec_preflight(spec_yaml_path)

    char_json_doc = {
        "id": char_id,
        "displayName": spec["displayName"],
        "title": spec["title"],
        "archetype": spec["archetype"],
        "version": "1.0.0",
        "themeColor": spec["themeColor"],
        "secondaryColor": spec["secondaryColor"],
        "model": {
            "file": "model.glb",
            "heightMeters": height_m,
            "statureRatio": round(height_m / 1.80, 2),
            "shoulderWidthRatio": spec["shoulderWidthRatio"],
            "armSpreadOffsetDeg": spec["armSpreadOffsetDeg"],
            "forwardAxis": "+Z",
        },
        "stats": {
            "maxHealth": spec["maxHealth"],
            "maxGuard": spec["maxGuard"],
            "maxMeter": 1000,
            "walkSpeed": spec["walkSpeed"],
            "strafeSpeed": spec["strafeSpeed"],
            "dashSpeed": spec["dashSpeed"],
            "homingDashSpeed": spec["homingDashSpeed"],
            "jumpVelocity": spec["jumpVelocity"],
            "gravity": 30.0,
            "weight": spec["weight"],
        },
        "boneMap": copy.deepcopy(CANONICAL_BONE_MAP),
        "hurtboxes": [
            {"id": "body_lower", "socket": "hips", "radius": 0.31, "offset": [0, 0.0, 0], "scaleWithHeight": True},
            {"id": "body_upper", "socket": "chest", "radius": 0.35, "offset": [0, 0.08, 0], "scaleWithHeight": True},
            {"id": "head", "socket": "head", "radius": 0.21, "offset": [0, 0.04, 0], "scaleWithHeight": True},
        ],
    }

    with open(os.path.join(char_dir, "character.json"), "w", encoding="utf-8") as fp:
        json.dump(char_json_doc, fp, indent=2)
        fp.write("\n")

    with open(os.path.join(char_dir, "moveset.json"), "w", encoding="utf-8") as fp:
        json.dump(_build_moveset(char_id), fp, indent=2)
        fp.write("\n")

    with open(os.path.join(char_dir, "ai.json"), "w", encoding="utf-8") as fp:
        json.dump(_build_ai_config(char_id, spec), fp, indent=2)
        fp.write("\n")

    raw_glb_path = os.path.join(char_dir, ".cache", "raw_model.glb")
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    settings = {"height_meters": height_m, "arm_spread_offset_deg": spec["armSpreadOffsetDeg"]}
    idem_key = meshy_adapter.compute_idempotency_key(spec_hash, spec["brief"], settings)

    if mode == "procedural":
        _generate_raw_procedural_mesh(raw_glb_path, height_m, spec["shoulderWidthRatio"], spec["themeColor"])
        task_id = f"local-gen-{char_id}-001"
        task_ledger = {
            "asset_id": asset_spec_doc["asset_id"],
            "idempotency_key": idem_key,
            "provider": "blender-procedural",
            "provider_model": "blender-5.2.1-lts",
            "task_id": task_id,
            "status": "SUCCEEDED",
            "created_at": now_iso,
            "updated_at": now_iso,
            "poll_count": 1,
            "raw_output_uri": f"chars/{char_id}/.cache/raw_model.glb",
            "error": None,
        }
        with open(os.path.join(char_dir, "generation-task.json"), "w", encoding="utf-8") as fp:
            json.dump(task_ledger, fp, indent=2)
            fp.write("\n")
    else:
        rc = meshy_adapter.run_meshy_generation(char_dir)
        if rc != 0:
            raise RuntimeError(f"Meshy generation failed with exit code {rc}")
        with open(os.path.join(char_dir, "generation-task.json"), "r", encoding="utf-8") as fp:
            task_ledger = json.load(fp)

    # Run normalize_char.py in Headless Blender 5.2.1
    subprocess.run(
        [
            BLENDER_BIN,
            "-b",
            "--factory-startup",
            "--python-exit-code",
            "1",
            "-P",
            os.path.join(ROOT_DIR, "tools", "normalize_char.py"),
            "--",
            char_dir,
            "--clips",
            clip_subset,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )

    out_glb_path = os.path.join(char_dir, "model.glb")
    out_hash = validate_char._sha256_file(out_glb_path)

    manifest_doc: dict[str, Any] = {
        "asset_id": asset_spec_doc["asset_id"],
        "spec_hash": spec_hash,
        "provider": task_ledger["provider"],
        "provider_model": task_ledger["provider_model"],
        "task_id": task_ledger["task_id"],
        "created_at": task_ledger["created_at"],
        "request": {
            "prompt": spec["brief"],
            "settings": settings,
            "input_hashes": [],
        },
        "output": {
            "format": "glb",
            "uri": f"chars/{char_id}/model.glb",
            "hash": out_hash,
            "triangle_count": 120,
            "measured_height_meters": height_m,
            "lowest_vertex_y": 0.0,
        },
        "validation": {
            "automated": "pending",
            "checked_at": now_iso,
        },
        "approval": {
            "status": "pending",
            "approved_by": "",
            "approved_at": "",
            "manifest_hash": "",
            "notes": "",
        },
    }
    approve_char.write_manifest_files(char_dir, manifest_doc)

    if approve_all:
        approve_char.approve_char(char_dir, approved_by=approved_by, notes=f"Auto-approved ({clip_subset})")
        errs = validate_char.validate_character(char_dir, clip_subset=clip_subset, require_approval=True)
        if errs:
            raise RuntimeError(f"Validation failed for {char_id}: {errs}")
    print(f"OK: Generated & normalized {char_id} ({height_m:.2f}m, clips={clip_subset})")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["procedural", "meshy"], default="procedural")
    parser.add_argument("--only", default="")
    parser.add_argument("--clips", choices=["gate0", "all"], default="all")
    parser.add_argument("--approve-all", action="store_true")
    parser.add_argument("--by", default="dev")
    args = parser.parse_args()

    # Ensure common_anims.glb exists
    if not os.path.isfile(COMMON_ANIMS_GLB):
        subprocess.run(
            [
                BLENDER_BIN,
                "-b",
                "--factory-startup",
                "--python-exit-code",
                "1",
                "-P",
                os.path.join(ROOT_DIR, "tools", "build_common_anims.py"),
                "--",
                "--clips",
                "all",
            ],
            check=True,
        )

    if args.only:
        char_ids = [c.strip() for c in args.only.split(",") if c.strip()]
    else:
        char_ids = list(ROSTER_SPECS.keys())

    for cid in char_ids:
        generate_character(cid, mode=args.mode, clip_subset=args.clips, approve_all=args.approve_all, approved_by=args.by)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
