# ASCII board fonts

The browser uses these local font subsets for every glyph the v1 ASCII
contract can emit, including seeded permutations. All 960 characters have a
600-unit advance at 1000 units/em. No board glyph requires an installed system
font. Character identities and benchmark observation text are unchanged.

- `mazebench-ascii.woff`: 946 characters from Iosevka Fixed Extended Bold
  [34.9.0](https://github.com/be5invis/Iosevka/releases/tag/v34.9.0), from
  `PkgTTF-IosevkaFixed-34.9.0.zip`. Subset and renamed to MazeBench ASCII.
- `mazebench-ascii-coptic.woff`: the 14 Coptic letters U+03E2–03EF from
  [Liberation Mono Bold 2.1.5](https://github.com/liberationfonts/liberation-fonts/releases/tag/2.1.5).
  Subset, scaled from 2048 to 1000 units/em, and renamed to MazeBench ASCII Coptic.
  Its rounded advance is exactly the same as the main font.

Both source fonts use SIL OFL 1.1; their copyright and license notices are
included alongside the subsets. The original glyph outlines are retained,
apart from the Coptic unit scaling. Shaping features are removed from the
subsets and disabled in CSS to keep adjacent characters independent.

To rebuild, install Python `fonttools` and pass the two source TTF files to:

```sh
python scripts/build-ascii-fonts.py IosevkaFixed-ExtendedBold.ttf LiberationMono-Bold.ttf
node --test tests/ascii-font.test.mjs
```

The test reads coverage and advances directly from the shipped WOFF files.
Changes to the glyph pool must pass it before new glyphs reach the UI.
