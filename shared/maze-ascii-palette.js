const crypto = require("node:crypto");

// Canonical glyphs from scripts/maze-terminal.js grouped by the exact colors
// used by play-render-three.js terrainColor() and actorColor(). Keeping this
// module dependency-free lets server/pages.js embed a palette without pulling
// the terminal back through server/app.js and creating a circular dependency.
const COLOR_GLYPHS = Object.freeze([
  ["&7!1@2#3$4", "#5b2f14"], // block assets
  [" Hh", "#050608"], // empty / hole
  ["AaEe8", "#d6bd94"], // floor / exit / orange button
  ["IiKk~-Vv<,Rr^6", "#a9d6f4"], // ice / ice block / ice slopes
  ["Oo", "#b85f16"], // orange wall
  ["Yy", "#c75652"], // player gate
  [">Ll", "#8a63d2"], // player lift
  ["Ss", "#476b35"], // shrub
  ["Tt", "#2f7d3f"], // tree
  ["Ww", "#23262c"], // wall
  ["`'", "#d6bd94"], // unknown terrain
  ["Bb|\\", "#2a2d33"], // box / unknown actor
  ["{[CcDdJj", "#b59a2a"], // clone families
  ["Ff", "#d6bd94"], // floating floor
  ["Gg", "#6cd7ff"], // gem
  ["Pp", "#5aa95c"], // player
  ["}]%5XxQqZz", "#ef4444"], // punchers
  [";_Uu09()+=.:", "#315991"] // weightless boxes
]);

const FIXED_GLYPHS = new Map([
  ["P", "P"],
  ["p", "p"],
  ["G", "G"],
  ["g", "g"]
]);

function canonicalPalette() {
  const palette = new Map();
  COLOR_GLYPHS.forEach(([glyphs, color]) => {
    Array.from(glyphs).forEach((glyph) => palette.set(glyph, color));
  });
  return palette;
}

function hiddenGlyphMap(seed, canonical) {
  const normalizedSeed = String(seed || "1");
  const universe = [...canonical.keys()]
    .filter((glyph) => glyph !== " " && !FIXED_GLYPHS.has(glyph))
    .sort();
  const sourceGlyphs = [" ", ...universe];
  const targetGlyphs = [...universe, "?"].sort((left, right) => {
    const leftHash = crypto.createHash("sha256").update(`${normalizedSeed}:ascii:${left}`).digest("hex");
    const rightHash = crypto.createHash("sha256").update(`${normalizedSeed}:ascii:${right}`).digest("hex");
    return leftHash.localeCompare(rightHash) || left.localeCompare(right);
  });
  return new Map(sourceGlyphs.map((glyph, index) => [glyph, targetGlyphs[index]]));
}

function asciiGlyphPalette({ hideNames = false, hideNamesSeed = "1" } = {}) {
  const canonical = canonicalPalette();
  const hidden = hideNames ? hiddenGlyphMap(hideNamesSeed, canonical) : null;
  const palette = {};
  canonical.forEach((color, glyph) => {
    const renderedGlyph = hidden
      ? FIXED_GLYPHS.get(glyph) || hidden.get(glyph) || glyph
      : glyph;
    palette[renderedGlyph] = color;
  });
  return palette;
}

module.exports = { asciiGlyphPalette };
