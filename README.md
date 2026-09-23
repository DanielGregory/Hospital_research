# ER Optimization Game

Run an emergency department: layout, staffing, and patient process, then watch a deterministic discrete-event simulation play out. The same engine runs headless for research.

See [CLAUDE.md](CLAUDE.md) for the full spec, principles, and build phases.

```sh
pnpm install
pnpm test          # unit + validation tests (determinism, Erlang C, Little's Law, monotonicity)
pnpm typecheck
pnpm headless run --config configs/examples/basic.json --seed 42 --out results.json
pnpm headless run --config configs/validation/mmc.json --seeds 1-8 --out results.csv
pnpm headless run --config configs/levels/level-02-monday-morning.json --seeds 1-40   # prints level pass rate
```

**Deploying the game:** it is a static site (the simulation runs in the browser). `vercel.json` builds it from the repo root: import the repo in Vercel and keep the root directory as `./`.

Layout: `packages/sim` (engine, no DOM), `packages/research` (policies, optimizer, stdio server), `apps/game` (browser game: `pnpm game`), `tools/headless` (CLI), `python/` (Gym-style wrapper, MIMIC-IV-ED calibration), `configs/` (JSON levels and scenarios). 
