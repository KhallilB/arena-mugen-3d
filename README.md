# arena-mugen-3d

3D arena fighting game engine with drop-in character folders. Each fighter lives in `chars/<id>/` with one normalized `.glb` model, JSON files for stats, frame data and CPU behavior, and an asset manifest verified at load time.

The runtime steps at a fixed 60Hz tick in TypeScript and Three.js `r186`, decoupled from display refresh rate. It never retargets arbitrary external rigs in the browser and never uses a rigid-body physics engine for combat hitboxes. Offline Python scripts and headless Blender 5.2.1 normalize every mesh to the canonical 16-bone humanoid skeleton and bake the 27 shared combat animations into `chars/<id>/model.glb`.

## Stack

| Layer | Choice |
|---|---|
| Runtime | TypeScript 5.8, Three.js `0.186.1`, fixed 60Hz integer-tick simulation |
| Dev server & I/O | Vite 8 with local `/api/chars` filesystem middleware for live character inspection and saving |
| Collision | Zero-allocation analytical segment-to-segment capsule solver on bone world matrices |
| Asset pipeline | Python 3.11+ (stdlib only) + headless Blender 5.2.1 LTS (`NLA_TRACKS` glTF 2.0 exporter) |
| Verification | Vitest 5 + Python `unittest` + `tools/validate_char.py` |

## Layout

```text
src/engine/       60Hz simulation, 17-state fighter FSM, capsule collision, camera, mod loader, CPU AI
src/editor/       Fighter Factory live overlay (frame scrubber, wireframe hitboxes, JSON save)
src/ui/           HUD bars, round timer, character select
chars/            Drop-in fighter directories (6 archetypes from 1.15m to 2.45m)
engine_assets/    common_anims.glb (1.80m reference rig, 27 clips) and common_states.json
tools/            Headless Blender normalizer, validator, approval signer, Meshy adapter
tests/            Vitest suites and headless glTF simulation harness
docs/             Architecture, character contract, guides, decision records, design spec
```

## Launch roster

| ID | Fighter | Height | Archetype |
|---|---|---|---|
| `kaze_striker` | Kaze | `1.80m` | Balanced rushdown with step-cancels and mid-range energy wave |
| `tecton_grappler` | Tecton | `2.45m` | Super-heavy grappler with command throw and armored heavy normal |
| `pip_brawler` | Pip | `1.15m` | Low-profile acrobat with upward pitch-aimed rushdown |
| `vesper_phantom` | Vesper | `1.72m` | Hit-and-run assassin with behind-back teleport and corner-flank fallback |
| `solaris_arcanist` | Solaris | `1.85m` | Zoner with 3D pitched projectiles that track target chest height |
| `valkyr_sentinel` | Valkyr | `2.05m` | Mid-range bruiser with sweeping normals and anti-air launchers |

## Develop

```bash
mise install && npm install
npm test
npm run validate-chars
npm run dev
```

`npm test` runs the seven Vitest suites (multi-height combat, 60Hz determinism, 15-pair AI watch mode matrix, validator fail-closed checks, Vite middleware hardening, Meshy idempotency and Fighter Factory UI) followed by the Python `unittest` suite. [CONTRIBUTING](CONTRIBUTING.md) lists every script and pre-push check.

## Documentation

| Document | Covers |
|---|---|
| [Architecture](docs/architecture.md) | Module boundaries, the 10-step 60Hz tick, the 4-layer multi-height solver and test enforcement |
| [Character contract](docs/character-contract.md) | Files in `chars/<id>/`, the 16 canonical bone sockets, the 27 animation clips and validator rules |
| [Adding a character](docs/guides/adding-a-character.md) | Generating, normalizing, validating, approving and tuning a fighter |
| [Decision records](docs/decisions/README.md) | Why the larger architectural choices were made and what would cause us to revisit them |
| [Design & validation spec](docs/3d_arena_mugen_spec.md) | The 2026-10-22 blueprint, mathematical derivations, acceptance criteria and empirical benchmark ledger |

## License

[MIT](LICENSE)
