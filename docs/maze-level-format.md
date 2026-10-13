# Maze Level Format

Maze level cells use `+` as the layer separator.

The token before the first `+` is the bottom row. A blank token means air, so `+` means an empty cell and `+M0` means air on the bottom row with `M0` sitting at the same elevation a floor would support. Legacy `h` hole tokens are read as blank air.

Examples:

- `.+#+G+#` is floor, wall, gem, wall.
- `.+#+#+#+#+#` is floor with five walls stacked above it.
- `.+#+++#+#` is floor, one wall, two empty layers, then two walls.

Orange buttons (`o`) control all orange walls (`O`) and orange ice slopes
in the same room. Any pressed button lowers them; they rise when every
button is released, subject to the existing clearance rules. Several
buttons may be used, and no numbering or matching is required. Older
numbered tokens such as `o1`, `O2`, and `SrO3` remain readable as ordinary
orange devices; their numeric suffixes and any `orangeId` metadata are ignored.
