# Character contract

Every fighter is a self-contained directory at `chars/<char_id>/`. The directory name must match `^[a-z0-9_]{1,48}$` and equal `character.json#id` with exact case. Neither the engine nor the build requires code changes when a valid character folder is added.

## Directory layout

| File | Format | Role |
|---|---|---|
| `model.glb` | Binary glTF 2.0 | Normalized mesh (`minY = 0.0`, `heightMeters` within `±0.02m`) skinned to the 16-bone `ArenaHumanoid_v1` skeleton with all 27 canonical clips baked at 60Hz |
| `character.json` | JSON | Display metadata, `model.heightMeters`, movement/health stats, `boneMap` (`16` sockets) and bone-attached hurtbox capsules |
| `moveset.json` | JSON | Declarative move table: input binding, `totalFrames`, `pitchTracking`, `pitchLimb`, velocity windows, hitbox capsules, projectiles, teleports and cancel windows |
| `ai.json` | JSON | `defaultAiLevel` (`1..8`), `personality` weights (`preferredRangeMeters`, `aggression`, `defense`), `comboRoutes` and single-shot `triggers` |
| `asset-spec.yaml` | ArenaMugen YAML | Source specification: `asset_id`, `rights_status`, `geometry.triangle_budget` (`<= 15000`), `rig.skeleton` and `art.original_brief` |
| `generation-task.json` | JSON | Idempotent generation ledger (`idempotency_key`, `status`, `task_id`, `spec_hash`) written by `tools/meshy_adapter.py` or `tools/generate_roster.py` |
| `asset-manifest.yaml` / `.json` | YAML + JSON | Validated output metrics, `output.hash` (`sha256:` of `model.glb`), `approval` block and `manifest_hash` over RFC 8785 canonical JSON |

## The 16 canonical bone sockets

`character.json#boneMap` maps every canonical socket key below to its node name in `model.glb`:

| Socket key | Canonical node name | Parent | Role |
|---|---|---|---|
| `hips` | `Hips` | `Armature` | Root pelvis socket; translations scaled by $k_{\text{leg}}$ during normalization |
| `spine` | `Spine` | `Hips` | Lower torso; receives $0.4\theta$ (arms) or $0.2\theta$ (legs) in Layer 3 pitch aiming |
| `chest` | `Chest` | `Spine` | Upper torso; default `body_upper` hurtbox and victim pin socket during `THROWN` |
| `head` | `Head` | `Chest` | Head hurtbox socket |
| `upper_arm_l` | `UpperArm.L` | `Chest` | Left shoulder pivot (`pitchLimb: "upper_arm_l"` or `"both_arms"`) |
| `forearm_l` | `ForeArm.L` | `UpperArm.L` | Left elbow socket |
| `hand_l` | `Hand.L` | `ForeArm.L` | Left fist hitbox and projectile spawn socket |
| `upper_arm_r` | `UpperArm.R` | `Chest` | Right shoulder pivot (`pitchLimb: "upper_arm_r"` or `"both_arms"`) |
| `forearm_r` | `ForeArm.R` | `UpperArm.R` | Right elbow socket |
| `hand_r` | `Hand.R` | `ForeArm.R` | Right fist hitbox, projectile spawn and attacker throw-pin socket |
| `thigh_l` | `Thigh.L` | `Hips` | Left hip pivot (`pitchLimb: "thigh_l"` or `"both_legs"`) |
| `shin_l` | `Shin.L` | `Thigh.L` | Left knee socket |
| `foot_l` | `Foot.L` | `Shin.L` | Left foot hitbox socket |
| `thigh_r` | `Thigh.R` | `Hips` | Right hip pivot (`pitchLimb: "thigh_r"` or `"both_legs"`) |
| `shin_r` | `Shin.R` | `Thigh.R` | Right knee socket |
| `foot_r` | `Foot.R` | `Shin.R` | Right foot hitbox socket |

## The 27 canonical animation clips

`engine_assets/common_states.json` defines the 27 required clip names and their integer frame counts at 60Hz (`N + 1` keys on Blender frames `0..N`, duration `N / 60` seconds):

| Category | Clips (`name: frames`) |
|---|---|
| Locomotion & guard (`10`) | `idle: 60`, `walk_forward: 30`, `walk_back: 30`, `strafe_left: 30`, `strafe_right: 30`, `dash_forward: 20`, `step_dodge: 18`, `jump_loop: 30`, `guard: 20`, `guard_crush: 45` |
| Ground normals (`6`) | `light_1: 24`, `light_2: 26`, `light_3: 32`, `heavy_neutral: 36`, `heavy_forward: 40`, `heavy_launcher: 42` |
| Air normals (`3`) | `air_light_1: 22`, `air_light_2: 24`, `air_heavy: 32` |
| Specials & throw (`3`) | `special_projectile: 38`, `special_rush: 36`, `throw_grab: 46` |
| Reactions & knockdown (`5`) | `hitstun: 24`, `launched: 36`, `wall_bounce: 16`, `knockdown: 25`, `wakeup: 18` |

## Frame-data and cancel invariants

`tools/validate_char.py` and the `PUT /api/chars/:id/:file` middleware reject any `moveset.json` or `ai.json` that violates these bounds:

- Every move's `animation` exists in `engine_assets/common_states.json#canonicalClips`, and `totalFrames` (`1..180`) matches the baked clip length.
- When `pitchTracking` is `true`, `pitchLimb` must be one of `upper_arm_l`, `upper_arm_r`, `both_arms`, `thigh_l`, `thigh_r`, `both_legs` or `torso`.
- Every hitbox satisfies `1 <= startFrame <= endFrame < totalFrames` and references valid keys in `character.json#boneMap`.
- Moves with `type: "THROW"` must set `unblockable: true` and `endFrame < throwReleaseFrame < totalFrames`.
- Cancel windows satisfy `1 <= startFrame <= endFrame <= totalFrames`, reference existing target moves (or `"homing_dash"`), and contain no cycle among `condition: "ALWAYS"` edges.
- `ai.json#preferredRangeMeters` satisfies `0.5 <= min < max <= 15.0` with `max - min >= 0.6`, and every trigger or combo route action resolves to a move in `moveset.json` or a built-in action (`guard`, `step_dodge`, `homing_dash`).

## `ApprovedAsset` invariant

`ModLoader.ts` and `tools/validate_char.py` refuse to load a character unless all four conditions hold:

1. `asset-manifest.json#output.hash` equals the live `sha256:<hex>` digest of `chars/<id>/model.glb`.
2. `asset-manifest.json#validation.status` is `"PASS"`.
3. `asset-spec.yaml#rights_status` is `"original-design"` or `"licensed-commercial"`.
4. `asset-manifest.json#approval` has `status: "approved"`, a non-empty `approver`, an ISO-8601 UTC `approved_at` timestamp, and a `manifest_hash` matching the RFC 8785 canonical JSON digest of the manifest with `approval` omitted.
