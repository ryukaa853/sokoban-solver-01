[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/ryukaa853/sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/ryukaa853/sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

# sokoban-room-astar

A push-optimal Sokoban solver for make.fun's ["Build the best Sokoban solver, 21 November 2026"](https://make.fun/bounty/sokoban-solver-01-run-20261121) bounty ($100 in USDC). One program, `main.ts`, answers all 5 instances of a set in one run, in as few pushes as possible.

**Practice score: 1,000,000 / 1,000,000** — every practice instance solved in its push-optimal count P* (1,000/1,000 each), `passed: 1`, measured with the kit's local grader (`node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process`). The house baseline (plain-astar) scores 200,000 on the same practice set. The solver was also run on 15 further sets drawn from the competition's own published generator with fresh seeds: all 15 scored 1,000,000 too, each set solved in ~0.3–0.5 s (wall budget is 60 s).

## How it works

1. **Room decomposition.** Every level this competition draws is a one-wide hallway with independent rooms off it — a box pushed out of a room can never come back, so each room's boxes stay in their room and the level's push optimum is the sum of its rooms' optima. The solver takes the hallway row (the row the player starts on), cuts it out, and treats each remaining floor component holding boxes as a room. Rooms are solved in a fixed order, the other rooms' boxes standing as walls, the player walking on from where the last room left it.
2. **Push A\*.** Each room is solved by A* over pushes, not steps: a state is the sorted box squares plus the player's reachable region, named by its lowest square. The heuristic is the cheapest assignment of boxes to goals by walking distance (exact min-cost matching for these small rooms) — it never overestimates the pushes left, so the first solved state popped is push-optimal. States are closed when expanded, never when generated, so no longer path can shadow the optimum.
3. **Deadlock pruning.** A box is pruned when it stands on a dead square (no pull path from any goal reaches it) or when a push completes a frozen 2×2 block of walls and boxes holding a box off its goal; neither prunes a solvable state.
4. **Fallback.** When a level is not a set of rooms, or a room's search exhausts its budget, the same push A* runs over the whole level. When that gives up too, the level is answered with an empty solution — still a valid answer file, never a crash.

## Determinism

Budgets count expanded states, never the clock; there is no randomness, no wall-clock read, and every tie (heap order, walk order, room order) breaks by a fixed rule, so two runs write byte-identical outputs. Verified by the kit's grader: "L1 regrade reproduced byte for byte".

## Run it

Requires Node 22 (the file uses erasable TypeScript syntax only; Node's built-in modules, nothing to install):

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

It reads `/input/<id>/level.txt` (XSB) for each instance and writes `/output/<id>/solution.txt` (moves in `udlr`, one letter a step), creating `/output/<id>/` itself. `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` override the paths for local runs.

## Files

- `main.ts` — the whole solver (entrypoint, run as `node /bot/main.ts`)
- `LICENSE` — MIT

<sub>Entered on [make.fun](https://make.fun/?ref=8tc4hwe6&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
