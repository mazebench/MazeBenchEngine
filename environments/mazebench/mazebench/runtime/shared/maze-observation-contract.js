const crypto = require("node:crypto");

function glyphPair(top, side) {
  return Object.freeze({ side, top });
}

const TERRAIN_GLYPHS = Object.freeze({
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

const PLAYER_LIFT_GLYPHS = Object.freeze({
  player_lift: Object.freeze({
    loweredTop: ">",
    raisedTop: "L",
    side: "l"
  })
});

const ORANGE_BUTTON_GLYPHS = Object.freeze({
  orange_button: glyphPair("8", " ")
});

const BLOCK_ASSET_GLYPHS = Object.freeze({
  1: glyphPair("!", "1"),
  2: glyphPair("@", "2"),
  3: glyphPair("#", "3"),
  4: glyphPair("$", "4")
});

const ICE_SLOPE_DIRECTION_GLYPHS = Object.freeze({
  down: glyphPair("V", "v"),
  left: glyphPair("<", ","),
  right: glyphPair("R", "r"),
  up: glyphPair("^", "6")
});

const BLACK_ICE_SLOPE_DIRECTION_GLYPHS = Object.freeze({
  down: glyphPair("▼", "▽"),
  left: glyphPair("◀", "◁"),
  right: glyphPair("▶", "▷"),
  up: glyphPair("▲", "△")
});

const ORANGE_ICE_SLOPE_DIRECTION_GLYPHS = Object.freeze({
  down: glyphPair("↓", "⇩"),
  left: glyphPair("←", "⇦"),
  right: glyphPair("→", "⇨"),
  up: glyphPair("↑", "⇧")
});

const ACTOR_GLYPHS = Object.freeze({
  box: glyphPair("B", "b"),
  clone: glyphPair("{", "["),
  floating_floor: glyphPair("F", "f"),
  gem: glyphPair("G", "g"),
  player: glyphPair("P", "p"),
  puncher: glyphPair("}", "]"),
  weightless_box: glyphPair(";", "_")
});

const CLONE_GLYPHS = Object.freeze({
  c0: glyphPair("C", "c"),
  c1: glyphPair("D", "d"),
  c2: glyphPair("J", "j")
});

const WEIGHTLESS_BOX_GLYPHS = Object.freeze({
  M0: glyphPair("U", "u"),
  M1: glyphPair("0", "9"),
  M2: glyphPair("(", ")"),
  M3: glyphPair("+", "="),
  M4: glyphPair(".", ":")
});

const PUNCHER_DIRECTION_GLYPHS = Object.freeze({
  down: glyphPair("%", "5"),
  left: glyphPair("X", "x"),
  right: glyphPair("Q", "q"),
  up: glyphPair("Z", "z")
});

const UNKNOWN_GLYPHS = Object.freeze({
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

function singleCodePoint(value) {
  return Array.from(String(value || "")).length === 1;
}

function assertUniqueGlyphPairs(groups) {
  const used = new Map();

  Object.entries(groups).forEach(([groupName, group]) => {
    Object.entries(group).forEach(([name, pair]) => {
      if (!pair || typeof pair !== "object" || typeof pair.top !== "string") {
        return;
      }

      const owner = `${groupName}.${name}`;

      Object.entries(pair).forEach(([role, symbol]) => {
        if (symbol === " ") return;
        if (!singleCodePoint(symbol)) {
          throw new Error(`${owner}.${role} must be one Unicode code point`);
        }
        const previous = used.get(symbol);
        if (previous && previous !== owner) {
          throw new Error(`Duplicate ASCII glyph ${JSON.stringify(symbol)} in ${previous} and ${owner}.${role}`);
        }
        used.set(symbol, owner);
      });
    });
  });

  return used;
}

const STATIC_GLYPH_OWNERS = assertUniqueGlyphPairs(STATIC_GLYPH_GROUPS);

function letterCharacters(start, end, excluded) {
  const characters = [];

  for (let codePoint = start; codePoint <= end; codePoint += 1) {
    const character = String.fromCodePoint(codePoint);
    if (/^\p{L}$/u.test(character) && !excluded.has(character)) {
      characters.push(character);
    }
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

const RESERVED_STATIC_GLYPHS = new Set(STATIC_GLYPH_OWNERS.keys());
const DYNAMIC_CLONE_GLYPH_PAIRS = pairCharacters(
  letterCharacters(0x0100, 0x02af, RESERVED_STATIC_GLYPHS)
);
const DYNAMIC_WEIGHTLESS_GLYPH_PAIRS = pairCharacters(
  letterCharacters(0x0370, 0x052f, RESERVED_STATIC_GLYPHS)
);

function normalizedIdentities(values) {
  return Array.from(new Set((values || []).map(String).filter(Boolean))).sort();
}

function assignDynamicPairs(identities, pairs, family) {
  const names = normalizedIdentities(identities);
  if (names.length > pairs.length) {
    throw new Error(
      `${family} uses ${names.length} dynamic identities, exceeding the safe one-cell Unicode capacity of ${pairs.length}`
    );
  }
  return new Map(names.map((name, index) => [name, pairs[index]]));
}

function createDynamicGlyphCatalog({ cloneIdentities = [], weightlessIdentities = [] } = {}) {
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

const COLOR_GLYPHS = Object.freeze([
  [[TERRAIN_GLYPHS.block_asset, ...Object.values(BLOCK_ASSET_GLYPHS)], "#5b2f14"],
  [[TERRAIN_GLYPHS.empty, TERRAIN_GLYPHS.hole], "#050608"],
  [[TERRAIN_GLYPHS.floor, TERRAIN_GLYPHS.exit, ORANGE_BUTTON_GLYPHS.orange_button], "#d6bd94"],
  [[
    TERRAIN_GLYPHS.ice,
    TERRAIN_GLYPHS.ice_block,
    TERRAIN_GLYPHS.ice_slope,
    ...Object.values(ICE_SLOPE_DIRECTION_GLYPHS)
  ], "#a9d6f4"],
  [[...Object.values(BLACK_ICE_SLOPE_DIRECTION_GLYPHS)], "#23262c"],
  [[TERRAIN_GLYPHS.orange_wall, ...Object.values(ORANGE_ICE_SLOPE_DIRECTION_GLYPHS)], "#b85f16"],
  [[TERRAIN_GLYPHS.player_gate], "#c75652"],
  [[glyphPair(PLAYER_LIFT_GLYPHS.player_lift.loweredTop, PLAYER_LIFT_GLYPHS.player_lift.side), glyphPair(PLAYER_LIFT_GLYPHS.player_lift.raisedTop, PLAYER_LIFT_GLYPHS.player_lift.side)], "#8a63d2"],
  [[TERRAIN_GLYPHS.shrub], "#476b35"],
  [[TERRAIN_GLYPHS.tree], "#2f7d3f"],
  [[TERRAIN_GLYPHS.wall], "#23262c"],
  [[UNKNOWN_GLYPHS.terrain], "#d6bd94"],
  [[ACTOR_GLYPHS.box, UNKNOWN_GLYPHS.actor], "#2a2d33"],
  [[ACTOR_GLYPHS.clone, ...Object.values(CLONE_GLYPHS), ...DYNAMIC_CLONE_GLYPH_PAIRS], "#b59a2a"],
  [[ACTOR_GLYPHS.floating_floor], "#d6bd94"],
  [[ACTOR_GLYPHS.gem], "#6cd7ff"],
  [[ACTOR_GLYPHS.player], "#5aa95c"],
  [[ACTOR_GLYPHS.puncher, ...Object.values(PUNCHER_DIRECTION_GLYPHS)], "#ef4444"],
  [[ACTOR_GLYPHS.weightless_box, ...Object.values(WEIGHTLESS_BOX_GLYPHS), ...DYNAMIC_WEIGHTLESS_GLYPH_PAIRS], "#315991"]
]);

const FIXED_GLYPHS = new Map([
  ["P", "P"],
  ["p", "p"],
  ["G", "G"],
  ["g", "g"]
]);

// Hidden ASCII shipped before the dynamic Unicode identity catalog existed.
// Keep that original permutation pool stable so adding new clone/box glyphs
// cannot recolor or rename floor, wall, hole, and other established symbols in
// saved runs. Extended identities are shuffled independently below.
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

function canonicalPalette() {
  const palette = new Map();
  COLOR_GLYPHS.forEach(([pairs, color]) => {
    pairs.forEach((pair) => {
      Object.values(pair).forEach((glyph) => {
        if (glyph !== " " || !palette.has(glyph)) palette.set(glyph, color);
      });
    });
  });
  return palette;
}

function hiddenAsciiGlyphMap(seed, canonical = canonicalPalette()) {
  const normalizedSeed = String(seed || "1");
  const universe = [...canonical.keys()]
    .filter((glyph) => glyph !== " " && !FIXED_GLYPHS.has(glyph))
    .sort();
  const bySeed = (left, right) => {
    const leftHash = crypto.createHash("sha256").update(`${normalizedSeed}:ascii:${left}`).digest("hex");
    const rightHash = crypto.createHash("sha256").update(`${normalizedSeed}:ascii:${right}`).digest("hex");
    return leftHash.localeCompare(rightHash) || left.localeCompare(right);
  };
  const legacy = universe.filter((glyph) => LEGACY_HIDDEN_ASCII_GLYPHS.has(glyph));
  const extended = universe.filter((glyph) => !LEGACY_HIDDEN_ASCII_GLYPHS.has(glyph));
  const legacyTargets = [...legacy, "?"].sort(bySeed);
  const mapping = new Map(
    [" ", ...legacy].map((glyph, index) => [glyph, legacyTargets[index]])
  );
  const extendedTargets = [...extended].sort(bySeed);
  extended.forEach((glyph, index) => mapping.set(glyph, extendedTargets[index]));
  return mapping;
}

function hideAsciiGlyphNames(text, seed) {
  const mapping = hiddenAsciiGlyphMap(seed);
  return Array.from(String(text || ""), (glyph) =>
    FIXED_GLYPHS.get(glyph) || mapping.get(glyph) || glyph
  ).join("");
}

function asciiGlyphPalette({ hideNames = false, hideNamesSeed = "1" } = {}) {
  const canonical = canonicalPalette();
  const hidden = hideNames ? hiddenAsciiGlyphMap(hideNamesSeed, canonical) : null;
  const palette = {};
  canonical.forEach((color, glyph) => {
    const renderedGlyph = hidden
      ? FIXED_GLYPHS.get(glyph) || hidden.get(glyph) || glyph
      : glyph;
    palette[renderedGlyph] = color;
  });
  return palette;
}

module.exports = {
  ACTOR_GLYPHS,
  BLACK_ICE_SLOPE_DIRECTION_GLYPHS,
  BLOCK_ASSET_GLYPHS,
  CLONE_GLYPHS,
  DYNAMIC_CLONE_GLYPH_PAIRS,
  DYNAMIC_WEIGHTLESS_GLYPH_PAIRS,
  ICE_SLOPE_DIRECTION_GLYPHS,
  ORANGE_BUTTON_GLYPHS,
  ORANGE_ICE_SLOPE_DIRECTION_GLYPHS,
  PLAYER_LIFT_GLYPHS,
  PUNCHER_DIRECTION_GLYPHS,
  TERRAIN_GLYPHS,
  UNKNOWN_GLYPHS,
  WEIGHTLESS_BOX_GLYPHS,
  asciiGlyphPalette,
  canonicalPalette,
  createDynamicGlyphCatalog,
  glyphPair,
  hideAsciiGlyphNames,
  hiddenAsciiGlyphMap
};
