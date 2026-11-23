# MazeBench Voxel Test Lab

A local visual unit-test editor for 3D, turn-based Sokoban-like mechanics. It uses MazeBenchEngine's perspective Three.js polycube renderer for authoring sparse 3D start frames and expected end frames, and executes turn physics in a C++ engine compiled to WebAssembly.

While the local development server is running, every project edit is atomically saved to the compact split store rooted at `project-data/project.json`. Each authored test has its own delta-compressed file under `project-data/tests/`; that tracked data is loaded before the browser fallback and is directly available to Git and native C++ tooling.

New projects begin with a 16 × 16 × ∞ test world. Existing tests retain their individually saved dimensions.

## Run locally

```bash
npm install
npm start
```

Run these commands from the MazeBenchBenchmarking repository. Open
[http://localhost:8080/unit-tests/](http://localhost:8080/unit-tests/).
This is the same editor source used by the optional `npm run dev:lab` development
server. Run `npm run build:unit-tests` to rebuild its main-site bundle after UI edits.

## Editor controls

- Click a cube face to paint; drag stays locked to the first logical layer.
- Select the eraser or press `E` to remove visible cubes.
- Press `←` / `→` to move through the toolbar. On a selected generic block, the arrows decrement or increment its object ID instead; pressing `←` at ID 0 moves to the toolbar item on its left.
- Press `G` once (or click the Select group toolbar tile), then click a cube to select every face-touching cube of the exact same block type and generic ID. Press `G` again to clear all highlighted groups without leaving Group mode. Click a selected group again to deselect it. Hold Shift and drag a visible rectangle to add every group touched by the rectangle. Arrow keys move all selected 3D groups together by one screen-relative cell, adjusted to the camera's nearest quarter-turn; collisions and room edges block the complete move. Press `Shift+↑` to raise selected groups one Z layer or `Shift+↓` to lower them one layer. Press `Delete` or `Backspace` to erase all selected groups as one undoable edit.
- Hold `W` / `S` to tilt smoothly through top, side, and underside views.
- Press `A` / `D` for eased quarter-turn rotation.
- Press `N` or click the center compass button to point the camera north.
- Shift-drag to orbit and scroll to zoom.
- Press `Cmd/Ctrl+Z` to undo a paint stroke and `Cmd/Ctrl+Shift+Z` to redo it.
- Reset room restores the active frame to row-0 floor tiles and is undoable.
- Tests are authored as Up and automatically checked in all four level rotations.
- Organize tests in persistent, renameable suite folders such as Push boxes and Ice.
- Use the Suite folder field to move a test, or a folder's `+` button to create one there.
- Collapse a suite folder with its disclosure triangle.
- Lock an individual test to protect its name, folder assignment, and both frames; lock a suite folder to protect every test inside it.
- Give every test a description of its intended transition and invariants so debugging agents have explicit behavioral context.
- Reorder tests within a suite folder, duplicate a test with its description and both authored frames, or delete an unlocked test after confirmation. The final remaining test is retained so the editor always has an active room.
- Expected frames can be replaced with an undoable copy of their start frame.
- Every test owns its width and depth. Start and Expected share that test-local size and resize together; shrinking permanently crops out-of-bounds voxels only from that test. Duplicated and newly derived tests inherit the source test's dimensions.
- Test World dimensions are drafts: typing never changes the room. Save dimensions validates and applies both fields together; Cancel restores the saved values. Valid dimensions are whole numbers from 3 through 32.

Logical Z is stored sparsely and is unbounded in both directions. Empty-hole painting starts at row 0.

## Physics roles and engine

Physics roles are project data with a stable internal key plus an editable display name and description. Blocks reference a role key, so renaming a role does not disconnect existing blocks. New roles can be created in the editor; their behavior is added explicitly in the focused C++ modules under `engine/src/physics/`.

All movement, collision, room-boundary, pushing, and Ice rules live in the C++ engine. `apps/web/app/physicsEngine.ts` only transfers frame and role data into the compiled WebAssembly module and reads the resulting coordinates back.

Ice follows MazeBenchEngine3 command semantics: a player entering Ice continues in the same direction until reaching normal floor or an obstacle, and a pushed object slides while supported by Ice.

Roles may be marked as a **generic numbered family**. Blocks using that role carry a non-negative object ID (`0`, `1`, `2`, and beyond), providing the data model needed for distinct weightless polycubes.

Generic IDs belong to painted voxels, not block definitions. Generic tools show `N` in the bottom toolbar; select one, type the desired ID in the prompt, and press Enter. Its toolbar cube shows that number while selected and returns to `N` when another tool is chosen. Every exposed face of the painted polycube displays its ID.

Dynamic entities cannot begin a command in midair. The tick engine first settles unsupported players and pushable cubes or polycubes one row per tick, then applies the requested horizontal input. A body above the bottomless void continues through the normal visible-fall and disappearance rules.

The built-in `goal` role is a literal non-rigid collectible gem. It occupies the same voxel space as moving bodies, does not support or block them, and is removed only when the player finishes an entire command on its exact coordinate. A box may overlap the gem without collecting it, and sliding across it mid-command leaves it in place.

The built-in `player-lift` role uses one numbered family for both mounting and state: `0/1` are Up lowered/raised, `2/3` are Front lowered/raised, `4/5` are Right lowered/raised, `6/7` are Back lowered/raised, and `8/9` are Left lowered/raised. Even IDs are lowered and odd IDs are raised. The downward/upside-down mounting is deliberately not exposed yet. Automatic test rotations remap the four wall-mounted ID pairs while preserving lowered/raised state; Up remains Up. Current C++ behavior remains the upward lift: a player entering it toggles `0 ↔ 1` and rides one Z unit; occupied headroom refuses a raise. The full lift ID is emitted in every generated tick frame and preserved through exact-search reconstruction.

## Evolutionary search

The Search workspace runs a deterministic, entity-first evolutionary loop in a Web Worker. The default **MazeBench 16×16×2** preset ports MazeBenchEngine3's useful evolutionary distribution: a closed perimeter with sparse internal walls, at most 18 initial Row-0 Ice cells, at most eight initial holes, compact 2–5-cube numbered pushboxes, 24 elites, reverse-pull-scrambled seeds, and its 50/100-generation stagnation schedule. Planar mode constrains Ice to Row 0 and generated box shapes to Row 1; unrestricted 3D mode retains vertical Ice, walls, structures, and polycubes. Floor remains restricted to Row 0. When Floor is disabled but Ice is enabled, Ice fills Row 0 before holes are carved. Minimum and maximum weightless-box values count distinct numeric IDs, not cubes; evolved polycubes still have no upper size cap.

The comparison also exposed and fixed several important deviations. Endpoints are connected through static terrain without requiring a box-free route, so boxes can actually create the puzzle. Mixed Ice populations now reverse-scramble their boxes before sparse Ice and holes are added. All Ice receives one mutation lottery entry rather than one entry per disconnected cluster, preserving equal opportunity with every individual box. Mutations are rejected cheaply when they break static objective connectivity, terrain limits, support, overlap, or the selected height ceiling. The default endpoint mutation rate is zero like MazeBenchEngine3, but it remains adjustable for experiments. Existing saved or current-best levels can seed 75% of a new population through **Evolve selected**, which is the fastest way to continue a 400-command lineage toward 500+ instead of rediscovering it.

Each generation uses two fidelity levels. Every candidate first receives a small C++ state budget; the strongest provisional and exact routes are promoted and rerun at the larger proof budget. A route found after any state was pruned is explicitly marked **provisional** and is never called optimal. The generalized solver's maximum stored-state capacity is 180,000 for ordinary low-entity scenes (and is automatically reduced for scenes approaching the 64-moving-entity limit), up from 50,000. The solver workspace keeps a fixed coordinate pool so this increase does not impose the worst-case 64-entity stride on every state. Up to eight WASM evaluators are selected automatically from available hardware, or 1–16 can be chosen manually. Evaluators receive configuration once, exact-result caching is bounded, and expensive solution interaction replay is opt-in.

Advanced controls expose the screening/proof budgets, proof promotions, workers, elites, reverse-seed rate and minimum pulls, endpoint mutation rate, Ice/hole seed caps, stagnation thresholds, terrain geometry, interaction scoring, and incumbent-seeded population share. Dimensions are not arbitrarily capped at 16: any horizontal shape and vertical range fitting the 4,096-voxel scene capacity and nonnegative 16-bit coordinates is accepted. “Rows above floor: N” permits Row 0 through Row N, inclusive, and empty vertical space is never enumerated.

MazeBenchEngine3's headline 2D speed is not an apples-to-apples physics result: its ≤16×16 engine packs occupancy into four 64-bit words, precomputes a finite polyomino pose library, and uses a separate push-macro A* for non-Ice rooms. This project intentionally does not reintroduce role-specific solver branches; its one generalized transition path supports arbitrary 3D polycubes, falling, riders, holes, and Ice together. The transferable evolution recipe is now present, while remaining solver work should focus on generalized event-frontier generation, compact state storage, and admissible relaxed-physics heuristics.

The live Search dashboard reports proven solution length and clearly labels provisional routes, plots the incumbent once per generation, shows the active clock, and records each generation's wall time. It reports attempted command simulations per second with global dynamic-body states alongside it. The C++ rate measures WASM solver time; the end-to-end rate also includes mutation, cloning, hashing, bounded cache lookup, serialization, candidate construction, promotion, and worker scheduling. Exact solve latency and time-to-target remain more meaningful than a raw state counter when comparing algorithm changes.

Each candidate is evaluated by one generalized C++ exact shortest-command solver. It runs uniform-cost Dijkstra (equivalently A* with a zero heuristic) over dynamic-body configurations while collapsing ordinary player reachability locally, so footsteps do not become global states. Every command uses the same arbitrary-3D physics semantics for Ice, holes, falling, walls, collectibles, riders, and polycubes. A shared prepared-scene accelerator handles exact player-only commands without creating a separate solver path; pushes and other body interactions fall through to the full tick kernel. A branch is pruned immediately when its player falls into the void and disappears. Solved candidates are ranked by the length of their proven optimum. Search records can be saved into the repo-backed project JSON, inspected in 3D, expanded into the engine's per-tick animation, and played with the arrow keys.

## Repository layout

- `engine/`: shared platform-independent C++ library, tests, WebAssembly API, and benchmarks
- `apps/web/`: browser editor, renderer integration, and web tests
- `apps/apple/`: reserved home for the future iOS/macOS client
- `scripts/`: repository-level build, test, and benchmark commands

## Verification

```bash
npm test
npm run lint
npm run typecheck
```

Every physics change must finish with a clean `npm test`. Record a performance baseline with:

```bash
npm run benchmark:physics
npm run benchmark:search
npm run benchmark:search:wasm
```

`benchmark:physics` reports both a prepared eight-voxel Ice push and the shared passive player-command accelerator. The native and WASM search benchmarks solve the same frozen 110-voxel, arbitrary-3D fixture at its proven 435-command optimum, replay the returned solution, and report exact solve latency plus clearly separated global-state, local-state, successor, and command-simulation rates. Native uses the host CPU instruction set while WASM is a generic browser target, so each is a platform baseline rather than a direct native-versus-WASM contest.

### Shared rendering geometry

`apps/web/public/mazebench-runtime/joined-voxel-surface.mjs` is the canonical
cube/slope surface and mounted-number visibility kernel shared by this lab and
the main MazeBench site in this repository. Matching material/body families join without internal
faces or coplanar outlines; different body IDs and selected materials stay
separate. Mounted lifts, gates, buttons, and punchers suppress the supporting
face's number. The Test Lab keeps its scene adapter, camera, and editor picking.

After kernel changes, run `node --test apps/web/tests/joined-voxel-surface.test.mjs`.
Run `npm run test:parity` for shared renderer identity and engine adapter
equivalence. Both applications import the same implementation, so no renderer
copy or external engine sync is needed. Historical signed benchmark snapshots
remain separate, frozen release artifacts.
