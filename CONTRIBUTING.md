# Contributing

## Setup

```bash
mise install          # node 22.14.0 and python 3.11.13, from .mise.toml
npm install
```

If `mise` reports that `.mise.toml` is not trusted, run `mise trust` once and retry. Re-baking `.glb` animations requires Blender 5.2.1 LTS at `/opt/homebrew/bin/blender`.

## Commands

Run the development server while you work. Press `F1` or `Tab` in the browser to open the Fighter Factory inspector.

```bash
npm run dev
```

| Command | What it does |
|---|---|
| `npm test` | Runs all Vitest suites and the Python `unittest` suite under `tools/tests/`. |
| `npm run validate-chars` | Audits all character folders under `chars/` against the `.glb`, JSON and `ApprovedAsset` contracts. |
| `npm run normalize-chars` | Runs `tools/normalize_char.py` in headless Blender 5.2.1 across every character folder. |
| `npm run approve-chars` | Recomputes canonical manifest hashes and writes the `approved` status block for validated characters. |
| `npm run generate-chars` | Rebuilds `engine_assets/common_anims.glb`, generates the 6 launch characters, normalizes, approves and validates them. |
| `npm run build` | Typechecks with `tsc --noEmit` and builds the production bundle with Vite. |

## Before you push

Run the full verification suite before pushing:

```bash
npm test && npm run validate-chars && npm run build
```

If you edit [`docs/3d_arena_mugen_spec.md`](docs/3d_arena_mugen_spec.md), also run the specification checks:

```bash
python3 -I evidence/structure_check.py docs/3d_arena_mugen_spec.md
python3 -I evidence/spec_check.py docs/3d_arena_mugen_spec.md
node evidence/mermaid_parse.mjs docs/3d_arena_mugen_spec.md
```

Behavior changes are test-first: write the failing test, see it fail, then write the minimal code that makes it pass.

## Code conventions

- Simulation code under `src/engine/` steps strictly on integer ticks (`dt = 1 / 60`). Never pass variable `requestAnimationFrame` deltas to `AnimationMixer.update` or physics integration.
- Collision and vector math on the 60Hz hot path reuse module-scoped scratch vectors and quaternions. Do not allocate per-pair objects inside `CollisionSolver.ts`.
- Python CLI tools under `tools/` use the Python 3.11+ standard library only so they run identically under system Python, Homebrew Python, `mise` Python and Blender's bundled Python.
- `tools/validate_char.py` is read-only and fail-closed. It must never mutate or repair files when a check fails.

## Code comments

Comments are one line (docstrings at most three lines). Write one only when the code cannot say it: a constraint, an invariant, or why a surprising choice is correct.

## Writing documentation

- Start each section with what the reader needs to do or know.
- Use plain, professional language. Avoid contractions, filler ("simply", "just", "really") and promotional words ("powerful", "seamless", "robust").
- State facts directly. Avoid rhetorical setups such as "Here's the thing", "The gap:" or slogans of the form "X, not Y".
- Use tables for reference material and prose for reasoning. Use bold sparingly.
- Put commands, file paths and identifiers in backticks, and make every command copyable as written.
- Date any claim that can go stale, such as test counts, versions or external projects.
- Give each topic one home and link to it instead of repeating it.

## Commits

Sign every commit with `git commit -S`; the repository uses SSH signing. Subjects follow Conventional Commits, for example `feat(engine): clamp victim root to floor during throws` or `fix(tools): reject NaN floats in yaml_lite`. Each commit must pass `npm test` on its own. Do not add AI attribution lines or `Co-authored-by:` trailers.

## Decision records

Larger architectural choices get a decision record. [docs/decisions](docs/decisions/README.md) explains when a change needs one.
