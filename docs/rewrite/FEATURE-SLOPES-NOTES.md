# Colored ice slopes + arbitrary-numbered boxes/clones — plumbing map

Scope: token parsing, colors, terrain-layer field flow, editor palette. All paths repo-relative. Line numbers as of 2026-07-16 (branch main, 465a474).

## 1. Token parsing

### Server: server/maze-levels.js
- `parseLevelRows` :111, `parseLevelCells` :115 (split rows on `rules.separator` " "), `parseCellStack` :125-135 (split cell on `rules.block_adder` "+"), `normalizeLegacyMazeToken` :137-140 ("h" → "" = air).
- `getDefinitionTokens` :142-154 and `getDefinitionTokenEntries` :156-194 read `level_parsing.json` `token`/`tokens`. Per-token-entry fields that survive: `initial_raised`, `direction`, `label`, `selectable`, `token` — **any other field on a token entry (e.g. a `color`) is dropped here**.
- `getObjectDefinitions` :196-234 builds `byName` and `byToken` Maps. `byToken` is an **exact-string Map** (:217-232). Lookup: `definitions.byToken.get(normalizedToken)` :504. **No regex/prefix/pattern support anywhere** — `M7`/`c5` are unknown tokens until listed in games/maze/level_parsing.json (weightless_box tokens :131, clone :49-64, ice_slope Sr/Sl/Su/Sd with `direction` :20-44).
- groupId assignment: `getLevelState` actor emission :516-532 — `groupId: definitionType===\"weightless_box\"||\"clone\" ? definition.token : null` :519-523. **groupId IS the raw token string** ("M0", "c2"). Arbitrary tokens work at this layer automatically once parseable; JS engine (maze-engine.js:784-830, :2714+) and clone grouping (:2783+) treat groupId as an opaque string.
- Layer/cell whitelists: `buildTerrainLayer` :325-337 = `{type,label,imageUrl,modelUrl,direction,elevation,raised}`; `buildTerrainCell` :236-247 = `{type,direction,label,imageUrl,modelUrl,layers,underlay,raised}`. **A new `styleVariant` field must be added to BOTH or it never reaches playData.**
- Stack semantics: `buildCellStack` :339-462 (raised layer priority list :395-410 includes `ice_slope` :397); type classification `isActorDefinition` :253-267 (includes weightless_box), `isRaisedTerrainDefinition` :286-299 (includes ice_slope).
- Save validation: `normalizeEditorCellValue` :575-600 throws `Unknown token "X"` :596; used by `getLevelEditorState` :623 and `sanitizeEditorPayload` :642-664; wired to POST /api/author/:game/:levelId at server/router.js:751-769 (:759). GET level-state JSON: router.js:694.
- Palette build: `buildAuthorPalette` :666-706 — one entry per tokenEntry, merged with games/maze/toolbox.json `tools[<token>]` (`toolboxTools[entry.token]` :674; name/description/demo :675-689). Palette entry fields :675-701: `{demo,description,imageUrl,modelUrl,label,initialRaised,name,selectable,token,type,direction}`. toolbox.json is keyed by exact token (M0-M4 :97-121, c0-c2 :42-56, Sr only :32-36) — new tokens need entries or fall back to `entry.label`/`titleCase(name) + token` :684-689.
- `buildAuthorPageData` :708-758 ships `palette` :751, `toolboxCatalog` :752, `blockAdder` :717-720, `separator` :753-756.

### Client twin: public/author-play-data.js
- `createAdapter(authorData)` :41; `toolByToken`/`toolByName` from palette :49-50 (exact match). `normalizeCellValue` throws Unknown token :74-78.
- `buildCellStack` :491-618 mirrors server; **duplicate whitelists**: `buildTerrainCell` :464-475, `buildTerrainLayer` :477-489 (direction from palette tool :485). `styleVariant` must be added here too.
- `buildPlayData` :777-833 — groupId = `tool.token` for weightless_box/clone :798-811. Actor/terrain shape identical to server `getLevelState`.
- Type sets duplicated at top: actorNames :3-13, raisedTerrainNames :22-30 (ice_slope :25), plus ice_slope special-case `isAttachableSurfaceTool` :373-375.

### Python engine: games/maze/player.py
- `config_tokens` :77-90, `config_token_entry` :93-106 — exact match against level_parsing.json. `object_definition_for_token` :356-365. `build_sprite` :367-377: weightless_box → `WeightlessBox(group_key=token)` :368-369.
- **Gap**: `MazeWorld.object_classes` :271-287 has NO clone/ice_slope/ice_block/puncher/tree classes — those object names fall through to plain non-solid `MazeSprite` :376-377. Python benchmark engine ignores slopes/clones entirely today; new tokens degrade the same way (silently non-solid).

## 2. Colors

### 3D renderer (primary; registers `app.threeRenderer` play-render-three.js:12681)
- `actorColor` public/play-render-three.js:4757-4783 — **flat per type, no groupId keying**: player/circle_player `#5aa95c`, clone `#b59a2a`, weightless_box `#315991`, floating_floor `#d6bd94`, gem `#6cd7ff`, puncher `#ef4444`, default `#2a2d33`. The "distinct shades per group" premise is false today — groups are distinguished only by **numeric face labels**, and only in editor/palette-preview modes: `addWeightlessGroupFaceLabels` :3359 (gate :3360-3362), `weightlessGroupLabel` :1723-1728 — regex `^[Mc](.+)$` **already handles arbitrary numbers** (M23 → "23", c5 → "5"). Label texture :1730-1761 (black text only).
- Group rendering: `addWeightlessActorGroups` :7096+ (covers weightless_box AND clone :7136-7137); merged polycube colored by `actorColor(columns[0].actor)` :7225; per-column path `actorRenderColor` :7079-7087, :7451-7452. Per-group color = change these three call sites to key off `actor.groupId`.
- `terrainColor(type)` :4631-4677 — wall `#23262c`, tree `#2f7d3f`, shrub `#476b35`, block_asset `#5b2f14`, **ice/ice_block/ice_slope `#a9d6f4`** :4648-4650, player_gate `#c75652`, player_lift `#8a63d2`, **orange_wall `#b85f16`**, orange_button `#d6bd94`, hole/empty `#050608`, exit/default `#d6bd94`.
- Materials: `material(color,opacity,variants)` :993-1003 → `cachedMaterialForRenderColor` :1005-1055 (MeshLambertMaterial keyed by color+opacity+variants; emissive = color, intensity 0.12, 0.28 for `#b85f16` :1023-1026). Purely color-string driven — a variant only needs a different hex.
- **Slope mesh**: `addIceSlopeCell` :6734-6778 — `addOutlinedMesh(iceSlopeGeometry(descriptor.layer?.direction), terrainColor(descriptor.type), ...)` :6756-6775. Geometry is **procedural** (`iceSlopeGeometry` :1966-2016, cache key direction+unit :1968; edges `iceSlopeEdgeGeometry` :2018+). No GLB/texture/tint — the single place to inject a per-layer color is the `terrainColor(descriptor.type)` argument at :6758, reading `descriptor.layer.styleVariant`.
- **Region merge hazard**: `terrainPieceDescriptorKey` :6001-6013 includes type/elevation/heights/direction/modelUrl — NOT a variant. `addTerrainRegions` :6977 flood-fills same-key neighbors (:7008, :7018) and renders the whole region from the first descriptor (:7034 → `addTerrainComponent` :6780; slopes per-cell :6796-6798 but still one descriptor). **styleVariant must be appended to the key** or adjacent different-colored slopes render as one color. Same for slope edge suppression `iceSlopeDescriptorsCanMergeAtContact` :6635-6669 (different variants would visually fuse).

### 2D canvas renderer (legacy path, play-render.js:11-21)
- weightless box: `#315991` body / `#79abeb` shine / outlines `#315991`+`#000` — public/play-render-actors.js:86, :100, :163-166. Clone: `#b59a2a` body :1057, lip `#8f7b21` :1062. Player `#5aa95c` :1018.
- terrain: wall `#23262c` top / `#4f5560` face, ice_block `#a9d6f4`/`#7fb6db`, block_asset `#5b2f14`/`#3c1f0d` — public/play-render-terrain.js:590-592; orange wall `#b85f16` :934; floor `#d6bd94` :305 / `#b89c73` :312. **No ice_slope handling at all in the 2D renderer** (zero matches) — slopes exist only in 3D.

## 3. Terrain-layer field flow (would `styleVariant` survive?)

Pipeline: level .txt → server getLevelState → page embed/API → play-core state → renderer descriptors.

- Embed: server/pages.js `renderPlayPage` :254-255 → `window.__PLAY_DATA__` :354 (`serializeForScript` keeps all fields); world palette sidecar `__PLAY_WORLD_DATA__` :257-268, :355. JSON API: server/router.js:694; fetched by `loadLevelState` public/play-core.js:1642-1658 (no filtering).
- Initial state: public/play-core.js `state.terrain = playData.terrain` :203 (by reference); actors `{...actor}` :204.
- Room switches/reset: `applyLevelState` :1513 → `cloneTerrainState` :1576/:1359 → `cloneTerrainCell` :1351-1357 = `{...cell, layers: layers.map(l => ({...l}))}` — **spread-based; extra layer/cell fields survive**. Neighbor prep `prepareLevelRenderState` :304-324 same. Actors: `createRuntimeActor` :834-865 spreads `{...actor}` — extras survive.
- **Actor whitelist hazard**: `cloneActorState` public/play-core.js:1328-1345 (used by `cloneLevelSnapshot` :1501-1511 and play-world-transitions.js:52) whitelists actor fields. `groupId` is kept :1331; any NEW actor field (e.g. per-box colorKey) is **stripped on entry snapshots/undo-reset**. Prefer deriving box/clone color from `groupId`.
- Renderer read: `renderTerrainLayersAt` play-render-three.js:4738-4755 — passes `cell.layers` through untouched :4741-4743, but the **no-layers fallback synthesizes `{type,elevation,modelUrl,raised}` only** :4745-4754 (legacy cells would lose the variant). Descriptor keeps the whole layer object (`layer` field) :6057/:6106 → available at `addIceSlopeCell` as `descriptor.layer.styleVariant` :6757.
- **Engine constraint**: public/maze-engine.js `normalizedTerrainType` :121-123 maps `layer.type` string → numeric code via `terrainTypes` :2-19; **unknown type strings become `empty` (0)** — so colored slopes must stay `type:"ice_slope"` + separate style field, NOT a new type string. Engine already ships a latent behavioral variant `orange_ice_slope` (:18) — blocks when buttons unpressed, slope band when pressed (:2352-2362, :1668-1669, :2470-2471, :295-296, :542-543, :1436-1437) — with **no token, no renderer color, no parser support**. Ice-slope blocking band: `terrainLayerBlocksElevation` :2352-2354 (elevation and elevation+1).
- Net: `styleVariant` on the LAYER survives everything **except** the two `buildTerrainLayer` whitelists (server maze-levels.js:325-337, client author-play-data.js:477-489) and the token-entry whitelist `getDefinitionTokenEntries` (maze-levels.js:156-194, and client palette entry shape via `buildAuthorPalette` :666-706). Those three are the gatekeepers to extend.

## 4. Editor palette

- Author page bootstrap: server/pages.js `renderAuthorPage` :464-465 → `window.__AUTHOR_DATA__ = buildAuthorPageData(...)` :526 (palette + toolboxCatalog). Play page ships the same palette as `__PLAY_WORLD_DATA__` :257-268/:355 and loads /author-play-data.js; public/play.js `primeWorldStates` :1001-1026 rebuilds neighbor-room playData client-side via `createAdapter(playWorldData)` :1005 + `buildPlayData` :1010.
- public/author.js: `authorData = window.__AUTHOR_DATA__` :2; adapter :95; palette container `#palette` (public/author-shell.js:152).
- `selectablePaletteTools` author.js:1978-2006 filters `selectable===false`, hole, legacy box "b", and **collapses ALL ice_slope tokens into ONE palette tool** `iceSlopePaletteTool` :205-222 (displayToken "S"); placement picks Sr/Sl/Su/Sd by camera yaw: `iceSlopeTokenByDirection` :207-211, resolver :4451, `isIceSlopeTool` :4353-4355. Colored slope tokens (e.g. "Rr","Rl"...) would ALL be swallowed into that single button unless the collapse groups by variant.
- Toolbox grouping: `INVENTORY_GROUPS` :2009-2018 match by `tool.name` — weightless_box → "Mechanisms", clone → "Players & Goals"; new tokens of existing objects auto-group. Button markup :2167+, detail demos from toolbox.json `demo` (canvas replay).
- Palette swatch previews are real renders: `buildPlayData({levelId: "__palette_preview_"+token,...})` :3315-3390 (special camera via `isPalettePreviewRenderMode` play-render-three.js:256-259 — also enables group face labels there).
- Hotbar defaults hardcode `"M0"`, `"M1"` :2029-2040.
- Editor paint validation and save both route through the exact-token maps (adapter `normalizeCellValue`, then server `sanitizeEditorPayload` router.js:759) — **an unknown token anywhere in a level makes the editor/save throw**, so level_parsing.json must be extended before any M7/c23 level exists on disk (getLevelState silently drops unknown tokens :501-506, but the author editor state loader `normalizeEditorCellValue` throws :596).

## Cheat-sheet: files to touch for the feature

| Change | Files |
|---|---|
| New tokens (M5+, c3+, colored S*) | games/maze/level_parsing.json; games/maze/toolbox.json (labels/demos) |
| Pattern tokens (regex M\d+) instead of enumeration | server/maze-levels.js:142-234, :501-506, :593-599; public/author-play-data.js:49, :74; author.js toolForToken :2131; games/maze/player.py:77-106 — today all exact-match |
| Slope styleVariant field | server/maze-levels.js:156-194 (token entry), :325-337 (layer); public/author-play-data.js:477-489; palette entry maze-levels.js:666-706 |
| Slope variant color | play-render-three.js:4631-4677 or :6758; descriptor key :6001-6013; edge merge :6635 |
| Per-group box/clone colors | play-render-three.js:4757-4783, :7225, :7451-7452; (2D: play-render-actors.js:86/:100/:1057) |
| Engine behavior (if variant ≠ cosmetic) | public/maze-engine.js:2-19, :2352-2362 (orange_ice_slope already exists); games/maze/player.py |
