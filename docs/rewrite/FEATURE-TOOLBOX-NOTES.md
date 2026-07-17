# Toolbox / hotbar map — for "Box N" / "Clone N" / colored-slope prompt buttons

Scope: editor toolbox UI (public/author.js), catalog delivery (server), token→play-data flow, and the tests that pin current behavior. All paths repo-relative; line numbers as of HEAD (465a474).

## 1. Client: toolbox + hotbar in public/author.js

### Data in
- `authorData` = `window.__AUTHOR_DATA__` (embedded by server, see §2). Toolbox catalog read at `public/author.js:164-169` (`toolboxToolConfigs = authorData.toolboxCatalog?.tools`). Used ONLY for the two meta tools' name/description (`noopToolConfig`/`eraserToolConfig`, 168-189); everything else's name/description/demo already arrives merged into `authorData.palette` by the server.
- Tool lookup maps come from the play-data adapter: `author.js:95-110` destructures `toolByName`, `toolByToken`, `buildPlayData`, `appendCellToken`, `normalizeAuthoringCellValue`, ... from `authorPlayData.createAdapter(authorData)`.
- Meta tools (not in palette): `noopToken="__select_only__"` (163), `eraserToken="__erase_top__"` (161), synthetic tool objects `noopTool`/`eraserTool` at 170-189. **This is the existing precedent for toolbox-only pseudo-entries.**
- Ice-slope collapsing: `iceSlopeTools` filtered from palette (205), one canonical entry `iceSlopePaletteTool` w/ `displayToken:"S"` (212-222), direction→token map (207-211). `selectablePaletteTools()` (1978-2006) pushes only ONE ice-slope entry (`hasAddedIceSlope` flag, 1980/1992-2000) and filters `selectable===false`, `hole`, `box`/`b`.

### Toolbox popup DOM
- Static shell (client-side template): `public/author-shell.js:144-153` — `#author-hotbar` (`#hotbar-toolname`, `#hotbar-slots`, `#hotbar-backpack`) and `#author-inventory` ("Toolbox" section) with detail pane: `#inventory-detail-stage`, `#inventory-demo-canvas`, `#inventory-detail-swatch`, `#inventory-detail-name`, `#inventory-detail-text` (line 152).
- Grid of buttons: `renderPalette()` `author.js:2161-2202` — groups from `INVENTORY_GROUPS` (2009-2018; matched by `tool.name`: `weightless_box`/`ice_slope` etc. are in "Mechanisms"; unmatched names fall into "Scenery" catch-all). Buttons rendered as `<button class="author-inv-item" data-token="...">` (2181-2194).
- Detail pane: `renderInventoryDetail()` `author.js:2265-2302` — name/description/swatch from `toolForToken(state.selectedToken)`, CSS demo class via `demoClassForTool` (2242-2263), and live 3D demo `runDemoScene(tool)` (2756) when open. Demo layout comes from `tool.demo` (toolbox.json) via `configuredDemoSceneForTool` (2598-2639, `$`→token substitution at 2619-2625), falling back to hardcoded per-type scenes `demoSceneForTool` (2641-2700; `weightless_box` case at 2678, `clone` at 2662 — both already parametric on `tool.token`).
- Open/close: `setInventoryOpen` (2309-2322), `isInventoryOpen` (2304-2307), backpack click 7291-7293, `#inventory-close` 7294-7296, `B` key toggle 6512-6516, Esc 6503-6509.

### Selection flow
- Toolbox click: `elements.palette` click listener `author.js:7483-7491` → `selectToken(button.dataset.token, { assignToActiveSlot: true })`.
- Hotbar click: 7251-7256 → `selectToken(slot.dataset.token);` (exact text pinned by test, see §4).
- Number keys 1-9,0 pick hotbar slots: 6533-6541. Right-click eyedropper: `handleGridContextMenu` 6828-6857 → `selectToken(descriptor.topToken, { assignToActiveSlot: true })` (6849).
- `selectToken(token, options)` `author.js:3892-3930`: **guard at 3897 rejects any token not in `toolByToken`** (except noop/eraser); swaps into active hotbar slot (3907-3924, `swapTokenIntoHotbarSlot` 2114-2129); re-renders palette/hotbar; `flashHotbarToolname` (3929).
- Hotbar model: `defaultHotbarTokens` 2029-2040 (includes `toolByToken.get("M0")`/`get("M1")`), slots normalized/deduped/max 10 by `normalizeClientHotbarTokens` 2057-2077 (**silently drops tokens missing from `toolForToken`**). Persistence via save payload `hotbarTokens` (5139, 5156) and reload (5068, 5196-5200); only active when `authorData.hotbarTokens` is an array (2041) — `buildAuthorPageData` doesn't emit it locally, and the POST route ignores it (§2), so local persistence is effectively off.
- `toolForToken(token)` 2131-2142: noop/eraser/iceSlope specials, else `toolByToken.get(token)`.

### Placement (cell writes)
- Cell model: `state.cells[y][x]` strings like `".+M0"` (`+` = `authorData.blockAdder`, 162). Board state at 240-281.
- 2D/simple path: `paintCell(x,y,value)` 4139-4164 → `appendTokenToCellValue` (4082-4084 → adapter `appendCellToken`, author-play-data.js:306-318) → `updateCellValue` 3989-4014 (undo snapshot + `state.cells[y][x] = normalizedValue`).
- 3D-picked path: `paintFaceTarget(target)` 4580-4642 — token = `effectivePaintToken()` (4454-4456: substitutes camera-facing ice-slope token via `cameraFacingIceSlopeToken` 4448-4452) → `placeCellElevationTokenIfVacant` (author-play-data.js:663-731) → `updateCellValue`. Puncher/orange-button have dedicated painters (dispatch 4608-4614).
- Every write funnels through adapter normalizers that **throw `Unknown token "X"` for tokens missing from the palette** (author-play-data.js:74-78 in `normalizeCellValue`, called by `normalizeAuthoringCellValue` 234-240 and `appendCellToken`/`placeCellElevationTokenIfVacant` 307/664).

### Existing prompt/input flows to imitate
1. **Unsaved-changes modal (best template)**: DOM `author-shell.js:165-174` (`#unsaved-changes-modal`, message + Cancel/Save buttons); promise-based open/close in `author.js:4987-5025` (`promptForUnsavedChanges` opens modal, resolves via `closeUnsavedChangesPrompt`; lazy listener binding `ensureUnsavedChangesPromptListeners` 4997-5011 incl. Esc). Callers await it: 5029, 7196.
2. Native dialog precedent: `window.confirm` in `shouldDiscardUnsavedChanges` `author.js:4983-4985` — so a plain `window.prompt("Box id?")` would not be stylistically alien, but the modal pattern matches the editor better.
3. Numeric sidebar inputs: `#board-width`/`#board-height` (`author-shell.js:60-62`) consumed by `resizeLevel` `author.js:4799-4828` with `Number(...)` + clamp — the validation idiom to copy for id ranges.
4. Free-token input: `#cell-value` + Apply (`author-shell.js:108`) → `applySelectedCellValue` `author.js:4969-4981` — already try/catches the Unknown-token throw and surfaces it via `setStatus`.

## 2. Server: catalog + palette delivery

- `games/maze/toolbox.json` (183 lines): `{format:1, tools:{token → {name, description, demo{layout,moves,zoom,ambient}}}}`. Has `__select_only__`, `__erase_top__`, `Sr` (only right slope), `c0-c2`, `M0-M4`. Authoring doc: `games/maze/TOOLBOX.md`.
- Loaded once in `server/maze-levels.js:20-25`. Merged per-token into the palette in `buildAuthorPalette` `server/maze-levels.js:666-706` — **palette rows come from `games/maze/level_parsing.json` `objects` token entries** (`getObjectDefinitions` 196-234, `getDefinitionTokenEntries` 156-194), toolbox.json only contributes `demo`/`description`/`name` overrides (674-689; label fallback `` `${label} ${token}` `` at 687-689 means new M5-M9 need no toolbox.json entries to get "Weightless Box M5"-style labels).
- `level_parsing.json` enumerates ids explicitly: `weightless_box.tokens = ["M0".."M4"]` (games/maze/level_parsing.json:131), `clone` c0-c2 (49-62), `ice_slope` Sr/Sl/Su/Sd (21-42).
- Page data: `buildAuthorPageData` `server/maze-levels.js:708-758` emits `palette` (751) and full `toolboxCatalog` (752). Embedded as `window.__AUTHOR_DATA__` in `server/pages.js:526` (author page `renderAuthorPage` 464-540); the play page re-embeds `palette`+`toolboxCatalog` for draft worlds at `server/pages.js:256-267`.
- Routes: `server/router.js:733-775` — GET `/api/author/:game/:level` → `getLevelEditorState` (maze-levels.js:602-640), POST → `sanitizeEditorPayload` (642-664) then write file. **Save validation**: `normalizeEditorCellValue` maze-levels.js:575-600 throws `Unknown token "X"` (593-597) for tokens absent from `definitions.byToken` — an M7 painted client-side would be rejected here too if level_parsing.json isn't extended. POST ignores `hotbarTokens` (no server persistence in this repo).
- Python engine is generic: `games/maze/player.py:77-105` reads the same `level_parsing.json` token lists; `build_sprite` groups weightless boxes by their literal token (`WeightlessBox(x, y, group_key=token)` player.py:367-369), so M7 "just works" once listed.

## 3. New token → buildPlayData flow

- Editor palette IS the adapter palette: `createAdapter(authorData)` `public/author-play-data.js:41-50` builds `toolByToken`/`toolByName` from `authorData.palette` only.
- `buildPlayData` `author-play-data.js:777-833`: per cell `getCellStackEntries` (95-99) maps tokens through `toolByToken` and `.filter(Boolean)` — **unknown tokens are silently dropped** (also `cellStackMetadata` 138-142 skips them). So if an M7 ever got into `state.cells` with a palette listing only M0-M4, it would render/play as if absent — no crash, no actor.
- In practice you can't get there: `selectToken` guard (author.js:3897) + `normalizeCellValue` throw (author-play-data.js:74-78) + server save throw (maze-levels.js:593-597) all key off the same palette/definitions. **There is no "unknown token" fallback entry anywhere; the fix is to make the palette contain the token.**
- Grouping already generic: `buildPlayData` sets `groupId: tool.token` for `weightless_box`/`clone` types (author-play-data.js:798-803); actor type comes from `tool.type || tool.name` (52-54). A palette entry `{token:"M7", name:"weightless_box", type:"weightless_box"}` gives correct connected-box behavior with zero engine changes.

## 4. Tests that pin toolbox behavior

`tests/author-tool-catalog.test.js` (53 lines):
- Requires `catalog.format===1` and entries with string name+description for tokens incl. `Sr`, `M0`, `M1` (15-38). Every `demo` must have array `layout` + `moves` matching `/^[UDLR]*$/` (40-45). Regex-pins maze-levels.js source: loads `gamesDir, "maze", "toolbox.json"`, uses `toolboxTool.description`/`demo`, exports `toolboxCatalog,` (47-50) and pages.js `toolboxCatalog: authorData.toolboxCatalog` (51).

`tests/author-inventory.test.js` (270 lines) — source-regex heavy; fragile markers:
- `sourceSection` markers must keep function ORDER: `renderInventoryDetail`→`isInventoryOpen` (29-34), `demoPlayData`→`demoSceneForTool` (36-38), `configuredDemoSceneForTool`→`const demoSceneRenderer` (47-53), `const defaultHotbarTokens`→`const hotbarPersistenceEnabled` (115-118), `syncEditorDirtyState`→`applyPersistedHotbarTokens` (153-157), `swapTokenIntoHotbarSlot`→`toolForToken` (171-175, executed in a VM 175-183), `selectToken`→`selectCell` (185-188), `saveLevel` section (159-165), `applyAuthorLevelPayload` section (167-169).
- **defaultHotbarTokens marker order pinned** (119-136): noopToken, eraserToken, player, gem, defaultWallToken, defaultFloorToken, ice, `toolByToken.get("M0")`, `toolByToken.get("M1")`, `toolByToken.get("l")` — inserting new default slots must preserve this relative order (and the 10-slot caps at 138-139).
- Exact call shapes pinned: `selectToken(button.dataset.token, { assignToActiveSlot: true })` (189), `selectToken(descriptor.topToken, { assignToActiveSlot: true })` (190), `selectToken(slot.dataset.token);` (191), `toolboxToolConfigs[noopToken]`/`[eraserToken]` + "Deselect"/"Erase" fallbacks (141-144).
- Forbidden strings: source must NOT contain `Board token:` nor `inventory-detail-token` (146-147) — don't add a raw-token line to the detail pane under those names.
- Demo scene invariants: `levelId: "__toolbox_demo_"` (37), `$`-substitution `\.split\("\$"\)` and UDLR scrub (51-52).

`tests/author-editor-interactions.test.js` (1056 lines): no toolbox-button pins; it pins paint mechanics that new tokens flow through — `selectCell` bounds (76-91), `paintTargetFromPointerEvent` (93-107), `updateCellValue` single-undo-per-stroke (377-386), `promptForUnsavedChanges(options = {})` signature (365, area 361-375 nearby pins), puncher layer logic (361-375), weightless polycube pick section (645+ via `weightlessPolycubePickSection`). Keep function names/order intact and these stay green.

## 5. Recommended wiring for "Box N" / "Clone N" / colored-slope prompt entries

1. **Capacity**: enumerate the id range server-side in `games/maze/level_parsing.json` (e.g. `weightless_box.tokens: ["M0".."M9"]`, more `clone` and slope entries). That alone makes selection, painting, client+server validation, buildPlayData grouping, and the python engine all work (labels auto-derive at maze-levels.js:687-689). Optionally add toolbox.json entries for nicer names/demos; mark extras `"selectable": false` in level_parsing.json if they shouldn't flood the grid (filtered at author.js:1984).
2. **Prompt UI**: add pseudo-entries following the noop/eraser meta-tool pattern (author.js:161-189) with sentinel tokens (e.g. `__box_prompt__`), injected in `selectablePaletteTools()` (1978-2006). Intercept them in the palette click handler (7483-7491) *before* `selectToken`: open a small promise-based modal cloned from the unsaved-changes pattern (author-shell.js:165-174 + author.js:4987-5025), validate N against the enumerated range, then call `selectToken("M"+n, { assignToActiveSlot: true })`. Intercepting at the click handler avoids touching `selectToken` (whose section is regex-pinned by author-inventory.test.js:185-191).
3. **Gotcha for colored slopes**: `selectablePaletteTools` collapses ALL tools with type/name `ice_slope` into one entry (1980, 1992-2000) and `effectivePaintToken` (4454-4456) rewrites the token per camera direction using maps built from that single family (205-211). New colored slope families need either distinct `type` values (e.g. `ice_slope_red` — then extend `isIceSlopeTool` 4353-4355 / direction maps per family) or per-family canonical entries; also `renderSelectedTool` hardcodes the "Ice Slope" label for `isIceSlopeToken` (3557-3568).
