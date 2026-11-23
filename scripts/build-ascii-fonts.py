"""Build the browser's fixed-width glyph subsets (requires fonttools).

Usage: python scripts/build-ascii-fonts.py IosevkaFixed-ExtendedBold.ttf LiberationMono-Bold.ttf
"""
import json
from pathlib import Path
import subprocess
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.ttLib.scaleUpem import scale_upem

root = Path(__file__).resolve().parent.parent
glyphs = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e",
    "import {hiddenAsciiGlyphMap} from './render-ascii/v1/glyph-contract.mjs';"
    "const map=await hiddenAsciiGlyphMap('1');"
    "console.log(JSON.stringify([...new Set([' ', 'P','p','G','g',...map.keys(),...map.values()])]));"
], cwd=root, text=True))
codepoints = {ord(glyph) for glyph in glyphs}
coptic = set(range(0x03E2, 0x03F0))
output = root / "ui" / "fonts"
output.mkdir(parents=True, exist_ok=True)

for source, wanted, family, filename in [
    (sys.argv[1], codepoints - coptic, "MazeBench ASCII", "mazebench-ascii.woff"),
    (sys.argv[2], coptic, "MazeBench ASCII Coptic", "mazebench-ascii-coptic.woff"),
]:
    font = TTFont(source, recalcTimestamp=False)
    assert wanted <= font.getBestCmap().keys(), "Source font lacks required glyphs"
    options = subset.Options()
    options.layout_features = []
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=wanted)
    subsetter.subset(font)
    # The Coptic source uses 2048 units/em; rounding to 1000 makes its
    # monospaced advance exactly match Iosevka Extended's 600-unit cell.
    scale_upem(font, 1000)
    # OpenType permits OVERLAP_SIMPLE only on the first point. Canonicalize
    # upstream flags so browser font sanitizers accept the subset.
    for name in font.getGlyphOrder():
        glyph = font["glyf"][name]
        if glyph.numberOfContours > 0:
            overlap = any(flag & 0x40 for flag in glyph.flags)
            for index in range(len(glyph.flags)):
                glyph.flags[index] &= ~0x40
            if overlap:
                glyph.flags[0] |= 0x40
    for record in font["name"].names:
        replacement = {
            1: family, 2: "Bold", 3: family + " Bold 1.0",
            4: family + " Bold", 6: family.replace(" ", "") + "-Bold",
        }.get(record.nameID)
        if replacement is not None:
            record.string = replacement.encode(record.getEncoding())
    cmap = font.getBestCmap()
    assert all(font["hmtx"].metrics[cmap[cp]][0] == 600 for cp in wanted)
    font.flavor = "woff"
    font.save(output / filename)
    print(f"{filename}: {len(wanted)} glyphs, all 600 / 1000 em wide")
