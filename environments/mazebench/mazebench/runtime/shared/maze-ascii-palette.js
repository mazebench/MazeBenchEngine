// Kept as the stable public import used by the run page and tests. The actual
// contract lives beside it so terminal rendering, hidden mode, and the bitmap
// palette cannot drift apart.
const { asciiGlyphPalette } = require("./maze-observation-contract");

module.exports = { asciiGlyphPalette };
