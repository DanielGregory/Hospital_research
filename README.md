# ER Optimization Game

Run an emergency department: layout, staffing, and patient process, then watch a deterministic discrete-event simulation play out. The same engine runs headless for research.

See [CLAUDE.md](CLAUDE.md) for the full spec, principles, and build phases.

```sh
pnpm install
pnpm test          # unit + validation tests (determinism, Erlang C, Little's Law, monotonicity)
pnpm typecheck
pnpm headless run --config configs/examples/basic.json --seed 42 --out results.json
pnpm headless run --config configs/validation/mmc.json --seeds 1-8 --out results.csv
```

Layout: `packages/sim` (engine, no DOM), `tools/headless` (CLI), `configs/` (JSON scenarios). `apps/game` arrives in Phase 1.
