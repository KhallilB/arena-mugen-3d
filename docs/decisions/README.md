# Decision records

Each record explains one of `arena-mugen-3d`'s larger architectural choices: what was chosen, what was rejected, what it costs, and what would cause us to reconsider it. Write a new record when a change affects boundaries between the offline Blender pipeline and the 60Hz runtime, alters the `chars/<id>/` folder contract, or adds a significant dependency. Routine work does not need one.

Number a new record after the highest existing number. Never renumber existing records.

Every record uses the same sections: Status, Context, Decision, Options considered, Consequences, Soundness boundary, Threat model, Non-goals, Revisit if, Adoption, Validation and Links.

| # | Decision | Status |
|---|---|---|
| [0001](0001-threejs-fixed-tick-runtime-and-blender-normalizer.md) | Use a fixed-60Hz Three.js runtime paired with offline headless Blender 5.2.1 normalization | Accepted 2026-10-22 |
| [0002](0002-four-layer-multi-height-animation-and-pitch-aiming.md) | Solve `1.15m`–`2.45m` combat reach with offline leg-ratio hip scaling and runtime parent-local pitch aiming | Accepted 2026-10-22 |
| [0003](0003-approved-asset-provenance-and-meshy-idempotency.md) | Require `ApprovedAsset` SHA-256 manifests at load time and idempotent task ledgers for Meshy generation | Accepted 2026-10-22 |
| [0004](0004-declarative-ai-profiles-with-delayed-perception.md) | Drive CPU and Watch Mode fighters from per-character `ai.json` profiles with delayed opponent perception and a 180-tick stalemate escalator | Accepted 2026-10-22 |
