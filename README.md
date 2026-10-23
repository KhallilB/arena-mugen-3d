# 3D Arena M.U.G.E.N (`arena-mugen-3d`)

A deterministic **60Hz 3D Arena Fighting Game Engine** (*Budokai Tenkaichi* / *Power Stone* style) built with **TypeScript + Three.js (`r186`) + Vite 8** and an offline **Headless Blender 5.2.1 + Python 3.11+ asset normalization & AI character generation pipeline**.

Full specification and evidence ledger: [`docs/3d_arena_mugen_spec.md`](docs/3d_arena_mugen_spec.md).

---

## Core Architecture

1. **Drop-In Moddability (`chars/<char_id>/`):**
   Every fighter is a self-contained directory containing:
   - `model.glb` — Rigged 3D character mesh with all 27 canonical 60Hz animations baked onto the 16-bone `ArenaHumanoid_v1` skeleton (`Hips` translations scaled by kinematic leg-span ratio $k_{\text{leg}}$).
   - `character.json` — Height (`1.0m`–`3.0m`), health, speeds, pushbox, and bone-attached hurtbox capsules.
   - `moveset.json` — Frame-accurate startup/active/recovery, bone-attached hitbox capsules, cancel graphs, projectiles, teleports, and Stage A/B socket-pinned throws.
   - `ai.json` — Delayed perception ring buffer (`max(2, 20 - 2 * aiLevel)`), immediate self-proprioception (`delay = 0`), single-shot weighted triggers, combo routes, and 180-tick anti-stalemate deadband escalator.
   - `asset-spec.yaml`, `generation-task.json`, `asset-manifest.yaml` — Cryptographically verified `ApprovedAsset` provenance ledger (`sha256:` over RFC 8785 canonical JSON).

2. **4-Layer Multi-Height Animation & Combat Solver (`1.15m` to `2.45m`):**
   - **Layer 1:** Canonical 16-bone humanoid rig (`ArenaHumanoid_v1`) with `< 5°` bone-axis twist tolerance.
   - **Layer 2:** Offline Headless Blender 5.2.1 NLA retargeting on integer frames `0..N` at `60Hz` (`scene.render.fps = 60`) with kinematic leg-span hip scaling $k_{\text{leg}} = L_{\text{char}} / L_{\text{ref}}$.
   - **Layer 3:** Runtime nearest-height-hurtbox upper-body pitch (`[-55°, +40°]`) & yaw (`[-25°, +25°]`) aiming in parent-bone local space (`bone.quaternion.premultiply`), with target-height latching on throw grab frame.
   - **Layer 4:** Sub-linear hurtbox radius scaling ($S_H = \text{clamp}((H/1.80)^{0.65}, 0.75, 1.35)$), monotonic hitbox radius scaling ($S_{\text{hit}} = \text{clamp}((H/1.80)^{0.50}, 1.00, 1.35)$), and clamped Stage A/B socket-pinned throws.

3. **Built-In "3D Fighter Factory" Live Inspector (`F1` / `Tab`):**
   Pause/scrub frame-by-frame (`Space`, `[` / `]`), inspect 3D hitbox/hurtbox capsules in wireframe, edit `moveset.json` and `ai.json` live, and save directly back to `chars/<id>/` via hardened local dev middleware.

---

## Launch Roster (6 Playable Archetypes)

| ID | Display Name | Height | Archetype | Signature Mechanics |
| :--- | :--- | :--- | :--- | :--- |
| `kaze_striker` | **Kaze** | `1.80m` | Balanced Rushdown | Fast step-cancels, balanced reach, `special_neutral` energy wave |
| `tecton_grappler` | **Tecton** | `2.45m` | Super-Heavy Grappler | Giant reach, command throw (`special_forward`), armored `heavy_neutral` |
| `pip_brawler` | **Pip** | `1.15m` | Pixie Acrobat | Low profile, rapid airborne Rushdown, steep upward pitch-aiming (`+31.8°`) |
| `vesper_phantom` | **Vesper** | `1.72m` | Hit-and-Run Assassin | Behind-back `TELEPORT` (`special_neutral`) with `[-10, 10]` cancel-depth cap |
| `solaris_arcanist` | **Solaris** | `1.85m` | Long-Range Zoner | 3D pitched projectiles (`special_neutral`, `special_forward`) that hit `1.15m` targets |
| `valkyr_sentinel` | **Valkyr** | `2.05m` | Mid-Range Bruiser | Sweeping spear-hand normals, anti-air launchers, high guard stability |

---

## Quickstart

### Prerequisites
- **Node.js `22.14.0`** (pinned in `.mise.toml` and `.nvmrc`) and **pnpm**
- **Python `>= 3.11`** (stdlib only)
- **Blender `5.2.1 LTS`** at `/opt/homebrew/bin/blender` (only required when re-baking `.glb` animations)

### Install & Run
```bash
pnpm install
pnpm dev
```

### Verification Suite
```bash
# 1. Validate all 6 characters against the ApprovedAsset & glTF contract
python3 tools/validate_char.py --all

# 2. Run all unit, determinism, multi-height combat, and AI Watch Mode matrix tests
pnpm test

# 3. Verify the specification document mechanically (structure, schema, Mermaid 11.17.2)
python3 -I evidence/structure_check.py docs/3d_arena_mugen_spec.md
python3 -I evidence/spec_check.py docs/3d_arena_mugen_spec.md
node evidence/mermaid_parse.mjs docs/3d_arena_mugen_spec.md
```
