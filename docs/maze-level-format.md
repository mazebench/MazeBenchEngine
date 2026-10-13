# Maze Level Format

Maze level cells use `+` as the layer separator.

The token before the first `+` is the bottom row. A blank token means air, so `+` means an empty cell and `+M0` means air on the bottom row with `M0` sitting at the same elevation a floor would support. Legacy `h` hole tokens are read as blank air.

Examples:

- `.+#+G+#` is floor, wall, gem, wall.
- `.+#+#+#+#+#` is floor with five walls stacked above it.
- `.+#+++#+#` is floor, one wall, two empty layers, then two walls.

Orange devices use a shared numeric channel id: `o1` is Orange Button 1,
`O1` is Orange Wall 1, and `SrO1` is a right-facing orange ice slope on
channel 1. Any pressed button lowers the orange terrain with the same id;
it rises when all buttons on that channel are released, subject to the
existing clearance rules. Channels are local to a room. Several buttons
and several walls may share an id, while different ids operate independently.
Unnumbered `o`, `O`, and `SrO` use channel 0 (equivalent to `o0`, `O0`,
and `SrO0`). Button occupancy still requires matching position and elevation.
The Build toolbox provides Orange Button N and Orange Wall N id selectors.
