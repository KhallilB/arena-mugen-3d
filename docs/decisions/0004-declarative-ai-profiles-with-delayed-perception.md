# 0004. Drive CPU and Watch Mode fighters from per-character `ai.json` profiles with delayed opponent perception and a 180-tick stalemate escalator

## Status

Accepted on 2026-10-22.

## Context

Watching two CPU characters fight each other (Watch Mode) is a core part of M.U.G.E.N. Three problems break AI vs. AI fights in a 3D arena if the CPU is hardcoded:

1. A single engine-wide AI makes rushdown, grappler, zoner and teleport archetypes play identically.
2. Zero-frame reaction to the opponent's state makes the CPU inhumanly parry every attack, while applying that same reaction delay (`14–18` frames at `AILevel 1–3`) to the AI's own hit-confirm state causes the AI to miss every `6–10` frame `ON_HIT` cancel window.
3. Two defensive or long-range AI profiles (`solaris_arcanist` vs. `valkyr_sentinel`) can circle each other indefinitely at their preferred ranges without engaging.

## Decision

Store each fighter's autonomous behavior in `chars/<id>/ai.json` and evaluate it in `src/engine/CpuAiController.ts` using four rules:

1. **Split perception latency:** Self proprioception (`self.state`, `self.moveFrame`, `self.moveHitConfirmed`, `self.meter`) is read at **zero delay (`0` frames)** so combo routes cancel on time at every `AILevel`. Opponent state (`opponent.position`, `opponent.state`, `opponent.stateInstanceId`, incoming projectiles) is read from a 20-frame ring buffer delayed by $\Delta T_{\text{react}} = \max(2, 20 - 2 \cdot \text{AILevel})$ ticks (`18` ticks at `AILevel 1` down to `4` ticks at `AILevel 8`).
2. **Single-shot trigger evaluation:** Declarative `triggers` in `ai.json` are keyed by `(trigger.id, opponentSnapshot.stateInstanceId)` so a `probability: 0.70` punish trigger rolls once when the opponent enters `ATTACK_RECOVERY` rather than rolling every tick ($1 - 0.30^{15} \approx 99.5\%$).
3. **Seeded deterministic PRNG:** All AI rolls use `mulberry32(hash32(matchSeed, fighterIndex, matchTick, rollCounter++))` and never call `Math.random()`.
4. **180-tick anti-stalemate escalator:** `ArenaSimulation` increments `ticksSinceLastEngagement` on every tick without a hit, block or `< 1.5m` near-miss. Past `180` ticks (`3.0s`), `aggressionBoost` ramps linearly at `+0.20/s` (capped at `1.0`), shrinking `preferredRangeMeters` toward `[0.8m, 1.4m]` and disabling retreat so passive standoffs cannot persist.

## Options considered

- Per-character `ai.json` + split self/opponent perception delay + single-shot triggers + 180-tick stalemate escalator: accepted. Produces distinct archetype behavior, reliable combo routing across `AILevel 1–8`, deterministic replays and zero standoffs across all 15 roster pairings.
- Delaying both self and opponent state by `max(2, 20 - 2 * AILevel)`: rejected. An `8`-frame cancel window (`frames 7..14`) expires before a `14`-tick reaction delay elapses at `AILevel 3`.
- Evaluating `preferredRangeMeters` occupancy during live AI-vs-AI combat: rejected. When two fighters with disjoint preferred rings (`[1.1, 1.9]` vs. `[5.0, 8.5]`) share one interpersonal distance $D(t)$, both cannot simultaneously stay inside their rings (`[1.1, 1.9] ∩ [5.0, 8.5] = ∅`). Ring occupancy is therefore verified against a passive training dummy while the 15-pair Watch Mode matrix verifies engagement cadence and zero stalls.

## Consequences

`ai.json` is part of the validated character contract (`tools/validate_char.py`) and can be edited live in the Fighter Factory inspector (`PUT /api/chars/:id/ai`).

When orbiting inside `[minEff, maxEff]`, `CpuAiController` applies a radial centering correction toward the ring midpoint $r_{\text{mid}} = \frac{1}{2}(\text{minEff} + \text{maxEff})$ so tangential strafing does not drift outward past `maxEff` via secant expansion.

## Soundness boundary

`CpuAiController` is a reactive utility/trigger controller authored via JSON weights and conditions; it is not a reinforcement-learning policy.

## Threat model

Prevents non-deterministic AI desyncs (`Math.random()`), per-tick probability compounding on multi-frame states, and infinite passive circling in Watch Mode.

## Non-goals

- Training neural network policies or shipping per-matchup lookup tables.

## Revisit if

- A new character archetype requires multi-condition boolean conjunctions (`AND`/`OR`/`NOT` trees) beyond the current `when` predicate object in `ai.json#triggers`.

## Adoption

Implemented in `src/engine/CpuAiController.ts`, `src/engine/ArenaSimulation.ts` and `chars/*/ai.json`.

## Validation

- Done: `tests/ai_watch_mode_matrix.test.ts` ran all `15` unique unordered roster pairs for `600` ticks at `AILevel = 6`; every pair landed `>= 1` hit within `240` ticks with zero `> 240`-tick engagement gaps.
- Done: `tests/ai_watch_mode_matrix.test.ts` ran each of the `6` archetypes for `600` ticks against a passive training dummy and verified `>= 60%` of `IDLE`/`MOVE` ticks remained inside `ai.json#preferredRangeMeters`.

## Links

- [Architecture](../architecture.md)
- [Character contract](../character-contract.md)
- [Design & validation spec: Section 6.5](../3d_arena_mugen_spec.md#65-autonomous-cpu-ai--mugen-watch-mode-architecture-srcenginecpuaicontrollerts)
