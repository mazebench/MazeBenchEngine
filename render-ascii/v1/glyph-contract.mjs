// Browser ESM adaptation of MazeBenchEngine/several-fixes'
// shared/maze-observation-contract.js. It keeps the same static glyphs,
// dynamic Unicode identity pools, and SHA-256-seeded hidden-name permutation.

export const ASCII_RENDERER_VERSION = "1";

export function glyphPair(top, side) {
  return Object.freeze({ side, top });
}

export const TERRAIN_GLYPHS = Object.freeze({
  block_asset: glyphPair("&", "7"),
  empty: glyphPair(" ", " "),
  exit: glyphPair("E", "e"),
  floor: glyphPair("A", "a"),
  hole: glyphPair("H", "h"),
  ice: glyphPair("I", "i"),
  ice_block: glyphPair("K", "k"),
  ice_slope: glyphPair("~", "-"),
  orange_wall: glyphPair("O", "o"),
  player_gate: glyphPair("Y", "y"),
  shrub: glyphPair("S", "s"),
  tree: glyphPair("T", "t"),
  wall: glyphPair("W", "w")
});

export const PLAYER_LIFT_GLYPHS = Object.freeze({
  player_lift: Object.freeze({ loweredTop: ">", raisedTop: "L", side: "l" })
});

export const ORANGE_BUTTON_GLYPHS = Object.freeze({
  orange_button: glyphPair("8", " ")
});

export const BLOCK_ASSET_GLYPHS = Object.freeze({
  1: glyphPair("!", "1"),
  2: glyphPair("@", "2"),
  3: glyphPair("#", "3"),
  4: glyphPair("$", "4")
});

export const ICE_SLOPE_DIRECTION_GLYPHS = Object.freeze({
  down: glyphPair("V", "v"),
  left: glyphPair("<", ","),
  right: glyphPair("R", "r"),
  up: glyphPair("^", "6")
});

export const BLACK_ICE_SLOPE_DIRECTION_GLYPHS = Object.freeze({
  down: glyphPair("▼", "▽"),
  left: glyphPair("◀", "◁"),
  right: glyphPair("▶", "▷"),
  up: glyphPair("▲", "△")
});

export const ORANGE_ICE_SLOPE_DIRECTION_GLYPHS = Object.freeze({
  down: glyphPair("↓", "⇩"),
  left: glyphPair("←", "⇦"),
  right: glyphPair("→", "⇨"),
  up: glyphPair("↑", "⇧")
});

export const ACTOR_GLYPHS = Object.freeze({
  box: glyphPair("B", "b"),
  clone: glyphPair("{", "["),
  floating_floor: glyphPair("F", "f"),
  gem: glyphPair("G", "g"),
  player: glyphPair("P", "p"),
  puncher: glyphPair("}", "]"),
  weightless_box: glyphPair(";", "_")
});

export const CLONE_GLYPHS = Object.freeze({
  c0: glyphPair("C", "c"),
  c1: glyphPair("D", "d"),
  c2: glyphPair("J", "j")
});

export const WEIGHTLESS_BOX_GLYPHS = Object.freeze({
  M0: glyphPair("U", "u"),
  M1: glyphPair("0", "9"),
  M2: glyphPair("(", ")"),
  M3: glyphPair("+", "="),
  M4: glyphPair(".", ":")
});

export const PUNCHER_DIRECTION_GLYPHS = Object.freeze({
  down: glyphPair("%", "5"),
  left: glyphPair("X", "x"),
  right: glyphPair("Q", "q"),
  up: glyphPair("Z", "z")
});

export const UNKNOWN_GLYPHS = Object.freeze({
  actor: glyphPair("|", "\\"),
  terrain: glyphPair("`", "'")
});

const STATIC_GLYPH_GROUPS = Object.freeze({
  ACTOR_GLYPHS,
  BLACK_ICE_SLOPE_DIRECTION_GLYPHS,
  BLOCK_ASSET_GLYPHS,
  CLONE_GLYPHS,
  ICE_SLOPE_DIRECTION_GLYPHS,
  ORANGE_BUTTON_GLYPHS,
  ORANGE_ICE_SLOPE_DIRECTION_GLYPHS,
  PLAYER_LIFT_GLYPHS,
  PUNCHER_DIRECTION_GLYPHS,
  TERRAIN_GLYPHS,
  UNKNOWN_GLYPHS,
  WEIGHTLESS_BOX_GLYPHS
});

function staticGlyphs() {
  const glyphs = new Set();
  Object.values(STATIC_GLYPH_GROUPS).forEach((group) => {
    Object.values(group).forEach((pair) => {
      if (!pair || typeof pair !== "object" || typeof pair.top !== "string") return;
      Object.values(pair).forEach((glyph) => glyphs.add(glyph));
    });
  });
  return glyphs;
}

function letterCharacters(start, end, excluded) {
  const characters = [];
  for (let codePoint = start; codePoint <= end; codePoint += 1) {
    const character = String.fromCodePoint(codePoint);
    if (/^\p{L}$/u.test(character) && !excluded.has(character)) characters.push(character);
  }
  return characters;
}

function pairCharacters(characters) {
  const pairs = [];
  for (let index = 0; index + 1 < characters.length; index += 2) {
    pairs.push(glyphPair(characters[index], characters[index + 1]));
  }
  return Object.freeze(pairs);
}

const RESERVED_STATIC_GLYPHS = staticGlyphs();
export const DYNAMIC_CLONE_GLYPH_PAIRS = pairCharacters(
  letterCharacters(0x0100, 0x02af, RESERVED_STATIC_GLYPHS)
);
export const DYNAMIC_WEIGHTLESS_GLYPH_PAIRS = pairCharacters(
  letterCharacters(0x0370, 0x052f, RESERVED_STATIC_GLYPHS)
);

function normalizedIdentities(values) {
  return Array.from(new Set((values || []).map(String).filter(Boolean))).sort();
}

function assignDynamicPairs(identities, pairs, family) {
  const names = normalizedIdentities(identities);
  if (names.length > pairs.length) {
    throw new Error(
      `${family} uses ${names.length} identities, exceeding the one-cell Unicode capacity of ${pairs.length}`
    );
  }
  return new Map(names.map((name, index) => [name, pairs[index]]));
}

export function createDynamicGlyphCatalog({ cloneIdentities = [], weightlessIdentities = [] } = {}) {
  const clones = assignDynamicPairs(cloneIdentities, DYNAMIC_CLONE_GLYPH_PAIRS, "clone");
  const weightless = assignDynamicPairs(
    weightlessIdentities,
    DYNAMIC_WEIGHTLESS_GLYPH_PAIRS,
    "weightless box"
  );
  return Object.freeze({
    clones,
    weightless,
    pairFor(family, identity) {
      return family === "clone"
        ? clones.get(identity) || null
        : weightless.get(identity) || null;
    }
  });
}

const FIXED_GLYPHS = new Map([
  ["P", "P"], ["p", "p"], ["G", "G"], ["g", "g"]
]);

const LEGACY_HIDDEN_ASCII_GLYPHS = new Set(Array.from([
  "&7!1@2#3$4",
  " Hh",
  "AaEe8",
  "IiKk~-Vv<,Rr^6",
  "Oo",
  "Yy",
  ">Ll",
  "Ss",
  "Tt",
  "Ww",
  "`'",
  "Bb|\\",
  "{[CcDdJj",
  "Ff",
  "Gg",
  "Pp",
  "}]%5XxQqZz",
  ";_Uu09()+=.:"
].join("")));

function canonicalGlyphUniverse() {
  const glyphs = staticGlyphs();
  Object.values(PLAYER_LIFT_GLYPHS.player_lift).forEach((glyph) => glyphs.add(glyph));
  DYNAMIC_CLONE_GLYPH_PAIRS.forEach((pair) => Object.values(pair).forEach((glyph) => glyphs.add(glyph)));
  DYNAMIC_WEIGHTLESS_GLYPH_PAIRS.forEach((pair) => Object.values(pair).forEach((glyph) => glyphs.add(glyph)));
  return [...glyphs];
}

const hashCache = new Map();
async function sha256Hex(value) {
  const key = String(value);
  if (!hashCache.has(key)) {
    hashCache.set(key, globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)).then((bytes) =>
      [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")));
  }
  return hashCache.get(key);
}

const hiddenMapCache = new Map();
export async function hiddenAsciiGlyphMap(seed = "1") {
  const normalizedSeed = String(seed || "1");
  if (hiddenMapCache.has(normalizedSeed)) return hiddenMapCache.get(normalizedSeed);
  const promise = (async () => {
    const universe = canonicalGlyphUniverse()
      .filter((glyph) => glyph !== " " && !FIXED_GLYPHS.has(glyph))
      .sort();
    const targets = [...universe, "?"];
    const hashes = new Map(await Promise.all(targets.map(async (glyph) => [
      glyph,
      await sha256Hex(`${normalizedSeed}:ascii:${glyph}`)
    ])));
    const bySeed = (left, right) =>
      hashes.get(left).localeCompare(hashes.get(right)) || left.localeCompare(right);
    const legacy = universe.filter((glyph) => LEGACY_HIDDEN_ASCII_GLYPHS.has(glyph));
    const extended = universe.filter((glyph) => !LEGACY_HIDDEN_ASCII_GLYPHS.has(glyph));
    const legacyTargets = [...legacy, "?"].sort(bySeed);
    const mapping = new Map([" ", ...legacy].map((glyph, index) => [glyph, legacyTargets[index]]));
    const extendedTargets = [...extended].sort(bySeed);
    extended.forEach((glyph, index) => mapping.set(glyph, extendedTargets[index]));
    return mapping;
  })();
  hiddenMapCache.set(normalizedSeed, promise);
  return promise;
}

export async function hideAsciiGlyphNames(text, seed = "1") {
  const mapping = await hiddenAsciiGlyphMap(seed);
  return Array.from(String(text || ""), (glyph) =>
    FIXED_GLYPHS.get(glyph) || mapping.get(glyph) || glyph).join("");
}

export function hiddenGlyph(glyph, mapping) {
  return FIXED_GLYPHS.get(glyph) || mapping?.get(glyph) || glyph;
}
