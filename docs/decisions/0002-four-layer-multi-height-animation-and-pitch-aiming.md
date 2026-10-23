# 0002. Solve `1.15m`–`2.45m` combat reach with offline leg-ratio hip scaling and runtime parent-local pitch aiming

## Status

Accepted on 2026-10-22.

## Context

The launch roster spans `1.15m` (`pip_brawler`) to `2.45m` (`tecton_grappler`). When characters of different heights share one horizontal punch or grab animation:

1. Unscaled `Hips` translations cause short characters to over-stride and tall characters to shuffle.
2. A `2.45m` fighter's horizontal jab (`Y ≈ 2.0m`) passes `>= 0.46m` above a `1.15m` fighter's highest hurtbox (`head` at `Y ≈ 1.0m`), whiffing at point-blank range.
3. Scaling hitbox radii and offsets down proportionally with height ($S_H = 0.75$) leaves a `1.15m` fighter unable to reach a `2.45m` opponent from a `1.40m` start.
4. Pinning a `2.45m` victim's `chest` (`Y ≈ 1.72m`) to a `1.15m` attacker's `hand_r` (`Y ≈ 0.92m`) without floor clamping drives the victim's feet `0.80m` below `Y = 0`.

## Decision

Implement a four-layer multi-height animation and combat solver across `tools/normalize_char.py` and `src/engine/FighterController.ts`:

1. **Layer 1 (16-bone canonical rig):** Align all 16 sockets to `< 5°` bone-axis twist against the `1.80m` reference rig.
2. **Layer 2 (leg-span hip scaling):** Scale animated `Hips` translation offsets from rest pose by the kinematic leg-span ratio $k_{\text{leg}} = L_{\text{char}} / L_{\text{ref}}$.
3. **Layer 3 (nearest-height-hurtbox pitch & yaw aiming):** On moves with `pitchTracking: true`, select the opponent hurtbox from the Pass-1 snapshot whose height $Y_h$ is closest to the limb pivot height $Y_{\text{piv}}$. Compute pitch $\theta = \operatorname{clamp}(\operatorname{atan2}(\Delta y, \max(D_{\text{XZ}}, 0.6)), -55^\circ, +40^\circ)$ and yaw $\psi = \operatorname{clamp}(\operatorname{atan2}(\Delta_{\text{lat}}, \max(D_{\text{XZ}}, 0.01)), -25^\circ, +25^\circ)$, transform $\hat{\mathbf{R}}_{\text{world}}$ and $\hat{\mathbf{Y}}_{\text{world}}$ into parent-bone local space via $Q_{\text{parent,world}}^{-1}$, and premultiply `spine` and the active limb.
4. **Layer 4 (asymmetric capsule scaling & clamped throw pinning):** Scale hurtboxes by $S_H = \operatorname{clamp}(H / 1.80, 0.75, 1.35)$ and floor hitbox scaling at `1.0` ($S_{\text{hit}} = \operatorname{clamp}(H / 1.80, 1.00, 1.35)$). On throw connect, latch $(\theta_{\text{grab}}, \psi_{\text{grab}})$, align `victim.chest` to `attacker.hand_r` in Pass 3, and clamp `victim.position.y >= 0.0`.

## Options considered

- Four-layer offline + runtime solver (`[-55°, +40°]` nearest-hurtbox pitch, `±25°` yaw, $S_{\text{hit}} \ge 1.0$, latched throw pin with floor clamp): accepted. Connects `light_1` on frame 7 in both directions between `2.45m` and `1.15m` with `> +0.10m` margin.
- Chest-to-chest pitch aiming clamped to `±35°` without limb yaw: rejected. Numeric geometry modeling (`docs/3d_arena_mugen_spec.md#22-master-claim--risk-ledger`) proved a wide jab still misses a `1.15m` opponent by `-0.12m` at `±35°`.
- Two-bone analytical IK on arms and legs for every strike: rejected. IK pulls the hand toward the target even when the move should whiff at range, distorting authored punch silhouettes and reach boundaries.
- Authoring separate animations per height class: rejected. Multiplies animation authoring and maintenance by $N$ height classes and breaks drop-in moddability.

## Consequences

Every pitched move in `moveset.json` must declare both `"pitchTracking": true` and `"pitchLimb"` (`upper_arm_l`, `upper_arm_r`, `both_arms`, `thigh_l`, `thigh_r`, `both_legs` or `torso`).

During a `1.15m -> 2.45m` throw, clamping `victim.position.y >= 0.0` leaves a vertical offset between `pip.hand_r` and `tecton.chest` (`lastThrowFloorClampResidual > 0`) so the tall victim stays grounded instead of sinking through the floor.

## Soundness boundary

Hurtbox scaling $S_H$ saturates below `1.35m` ($0.75\times$) and above `2.43m` ($1.35\times$). Characters outside `1.0m`–`3.0m` are rejected by `tools/validate_char.py`.

## Threat model

Without latching $(\theta, \psi)$ on the grab frame, pitching `attacker.hand_r` down moves `victim.chest` down in Pass 3, which would cause the next tick's Pass-2 aim to pitch even further down into a positive-feedback ratchet. `FighterController` latches `latchedAimTheta` and `latchedAimPsi` on throw connect and holds them fixed until `throwReleaseFrame`.

## Non-goals

- Full-body ragdoll or finger-joint IK during throws.
- Supporting quadruped or non-humanoid skeletons.

## Revisit if

- A new move animation has shoulder width or stance geometry where `[-55°, +40°]` pitch and `±25°` yaw fail to connect between `1.15m` and `2.45m` from `1.20m`.

## Adoption

Enforced across all 6 launch characters and tested in `tests/multi_height_combat.test.ts`.

## Validation

- Done: `tests/multi_height_combat.test.ts` verified `Tecton (2.45m) <-> Pip (1.15m)` `light_1` connects on frame 7 in both directions from `1.20m` (`margin > +0.10m`) when `pitchTracking = true`, and whiffs (`margin < -0.25m`) when `pitchTracking = false`.
- Done: `tests/multi_height_combat.test.ts` verified `Tecton -> Pip` `special_forward` pins `pip.chest` to `tecton.hand_r` with `< 0.02m` error and `< 0.05m` vertical root drift across frames `9..28`.

## Links

- [Architecture: Multi-height animation and combat solver](../architecture.md#multi-height-animation-and-combat-solver)
- [Design & validation spec: Section 4](../3d_arena_mugen_spec.md#4-the-multi-height-animation--skeletal-retargeting-architecture-10m-to-30m)
- Related: [0001](0001-threejs-fixed-tick-runtime-and-blender-normalizer.md)
