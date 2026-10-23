# Adding a character

A character lives in `chars/<id>/` and requires no TypeScript edits to appear on the select screen or in Watch Mode. Follow the five steps below to create, normalize, validate, approve and tune a new fighter.

## 1. Create the folder and `asset-spec.yaml`

Pick a snake_case identifier matching `^[a-z0-9_]{1,48}$`, create `chars/<id>/`, and write `asset-spec.yaml`:

```yaml
asset_id: character.volt_monk.v1
kind: character
rights_status: original-design
engine:
  name: ArenaMugen3D
  version: 0.1.0
  import_format: glb
  scale: 1.0_unit_equals_1_meter
  forward_axis: +Z
  up_axis: +Y
geometry:
  triangle_budget: 12000
  watertight: false
rig:
  skeleton: canonical-16-bone-humanoid
  rest_pose: A-pose
  required_sockets:
    - hips
    - spine
    - chest
    - head
    - upper_arm_l
    - forearm_l
    - hand_l
    - upper_arm_r
    - forearm_r
    - hand_r
    - thigh_l
    - shin_l
    - foot_l
    - thigh_r
    - shin_r
    - foot_r
  required_clips:
    - idle
    - walk_forward
    - walk_back
    - strafe_left
    - strafe_right
    - dash_forward
    - step_dodge
    - jump_loop
    - guard
    - guard_crush
    - light_1
    - light_2
    - light_3
    - heavy_neutral
    - heavy_forward
    - heavy_launcher
    - air_light_1
    - air_light_2
    - air_heavy
    - special_projectile
    - special_rush
    - throw_grab
    - hitstun
    - launched
    - wall_bounce
    - knockdown
    - wakeup
art:
  style: stylized-arcade-cel
  original_brief: "Original cybernetic martial monk in symmetrical A-pose, clear limb separation"
```

Copy `character.json`, `moveset.json` and `ai.json` from `chars/kaze_striker/` as a starting template, then set `"id": "volt_monk"`, `"displayName"` and `model.heightMeters` (`1.0` to `3.0`).

## 2. Generate or supply the raw mesh

To generate a mesh from `asset-spec.yaml` through Meshy, set `MESHY_API_KEY` and run:

```bash
python3 tools/meshy_adapter.py chars/volt_monk
```

`meshy_adapter.py` validates `asset-spec.yaml` before making any network call (`exit 2` on invalid spec), writes `chars/volt_monk/generation-task.json` with a deterministic `idempotency_key`, polls existing tasks on retry instead of creating duplicate billable jobs, and downloads the raw `.glb` to `chars/volt_monk/.cache/raw_model.glb`.

If you have an existing `.glb` or procedural Blender mesh, place it at `chars/volt_monk/.cache/raw_model.glb` and write `generation-task.json` with `"status": "SUCCEEDED"`.

## 3. Normalize the rig and bake the 27 animations

Run `tools/normalize_char.py` inside headless Blender 5.2.1:

```bash
/opt/homebrew/bin/blender -b --factory-startup --python-exit-code 1 -P tools/normalize_char.py -- chars/volt_monk --clips all
```

`normalize_char.py` scales the mesh to `character.json#model.heightMeters`, snaps the lowest vertex to `Y = 0.0`, aligns all 16 canonical bone sockets to `< 5°` twist against `engine_assets/common_anims.glb`, scales `Hips` translations by the leg-span ratio $k_{\text{leg}}$, exports `chars/volt_monk/model.glb` at 60Hz, and writes `asset-manifest.yaml` and `asset-manifest.json` with `approval.status: "pending"`.

## 4. Validate and approve

Run the validator, then sign the approval block:

```bash
python3 tools/validate_char.py chars/volt_monk --require-approval false
python3 tools/approve_char.py chars/volt_monk --approver "Khallil" --note "Verified rig, height and 27 clips"
python3 tools/validate_char.py chars/volt_monk
```

`validate_char.py` exits `0` only when all geometry, skeleton, animation, frame-data, AI and `ApprovedAsset` checks pass.

## 5. Tune frame data live in Fighter Factory

Start the development server and press `F1` or `Tab` in the browser:

```bash
npm run dev
```

- Press `Space` to pause the 60Hz simulation and `[` / `]` to step backward or forward one tick at a time.
- Inspect wireframe hurtboxes (green), active hitboxes (red) and pushboxes (cyan), along with the live Layer 3 pitch angle $\theta$ and yaw angle $\psi$.
- Edit `moveset.json` or `ai.json` in the inspector and click **Save Move JSON** (`PUT /api/chars/volt_monk/moveset`). The Vite middleware validates the payload atomically before writing to disk.
