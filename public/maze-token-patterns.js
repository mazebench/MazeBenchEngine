// Shared token-pattern resolver (browser + Node).
//
// Explicit tokens (M0-M4, c0-c2, Sr/Sl/Su/Sd, ...) keep their catalog
// entries; this module resolves the OPEN-ENDED families on top of them
// (owner feature, 2026-07):
//
//   M<N>        weightless box with arbitrary group id N        (Box N)
//   c<N>        clone with arbitrary group id N                 (Clone N)
//   S<d>M<N>    blue ice slope tinted like box N                (d = r|l|u|d)
//   S<d>c<N>    yellow ice slope tinted like clone N
//   S<d>#      black ice slope styled like the wall decoration
//   S<d>O      orange ice slope (raises/lowers with the orange buttons;
//               its own terrain type: orange_ice_slope)
//
// Consumers look up their explicit catalogs FIRST and fall back to
// resolvePatternToken on a miss, adapting the descriptor to their local
// entry shape.
(function (root, factory) {
  const exported = factory();

  // Both, not either: the Node vm test loader exposes a `module` binding
  // while also relying on the window global.
  if (typeof module === "object" && module && module.exports) {
    module.exports = exported;
  }

  if (root) {
    root.MazeTokenPatterns = exported;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const DIRECTIONS = {
    r: "right",
    l: "left",
    u: "up",
    d: "down"
  };

  const DIRECTION_LABELS = {
    right: "Right",
    left: "Left",
    up: "Up",
    down: "Down"
  };

  const DIRECTION_CHARS_BY_TRANSFORM = {
    "rotate-left": { r: "u", u: "l", l: "d", d: "r" },
    "rotate-right": { r: "d", d: "l", l: "u", u: "r" },
    "flip-horizontal": { r: "l", l: "r", u: "u", d: "d" },
    "flip-vertical": { r: "r", l: "l", u: "d", d: "u" }
  };

  const BOX_PATTERN = /^M(\d+)$/;
  const CLONE_PATTERN = /^c(\d+)$/;
  const BLUE_SLOPE_PATTERN = /^S([rlud])M(\d+)$/;
  const YELLOW_SLOPE_PATTERN = /^S([rlud])c(\d+)$/;
  const BLACK_SLOPE_PATTERN = /^S([rlud])#$/;
  const ORANGE_SLOPE_PATTERN = /^S([rlud])O$/;

  function resolvePatternToken(token) {
    const value = String(token || "");
    let match = BOX_PATTERN.exec(value);

    if (match) {
      return {
        token: value,
        family: "weightless_box",
        type: "weightless_box",
        direction: null,
        styleKey: null,
        label: "Box " + match[1]
      };
    }

    match = CLONE_PATTERN.exec(value);

    if (match) {
      return {
        token: value,
        family: "clone",
        type: "clone",
        direction: null,
        styleKey: null,
        label: "Clone " + match[1]
      };
    }

    match = BLUE_SLOPE_PATTERN.exec(value);

    if (match) {
      const direction = DIRECTIONS[match[1]];

      // Owner rule: a Box Ice Slope IS a member of weightless group M<N> —
      // a slope-shaped pushable piece, not terrain.
      return {
        token: value,
        family: "weightless_box",
        type: "weightless_box",
        shape: "slope",
        groupId: "M" + match[2],
        direction,
        styleKey: "M" + match[2],
        label: "Box Ice Slope " + match[2] + " " + DIRECTION_LABELS[direction]
      };
    }

    match = YELLOW_SLOPE_PATTERN.exec(value);

    if (match) {
      const direction = DIRECTIONS[match[1]];

      // Owner rule: a Clone Ice Slope moves with clone group c<N>.
      return {
        token: value,
        family: "clone",
        type: "clone",
        shape: "slope",
        groupId: "c" + match[2],
        direction,
        styleKey: "c" + match[2],
        label: "Clone Ice Slope " + match[2] + " " + DIRECTION_LABELS[direction]
      };
    }

    match = BLACK_SLOPE_PATTERN.exec(value);

    if (match) {
      const direction = DIRECTIONS[match[1]];

      return {
        token: value,
        family: "ice_slope",
        type: "ice_slope",
        direction,
        styleKey: "wall",
        label: "Black Ice Slope " + DIRECTION_LABELS[direction]
      };
    }

    match = ORANGE_SLOPE_PATTERN.exec(value);

    if (match) {
      const direction = DIRECTIONS[match[1]];

      return {
        token: value,
        family: "orange_ice_slope",
        type: "orange_ice_slope",
        direction,
        styleKey: "orange",
        label: "Orange Ice Slope " + DIRECTION_LABELS[direction]
      };
    }

    return null;
  }

  // Tokens the prompt-style toolbox entries generate.
  function boxToken(id) {
    return "M" + String(id);
  }

  function cloneToken(id) {
    return "c" + String(id);
  }

  function blueSlopeToken(direction, id) {
    return "S" + direction.charAt(0) + "M" + String(id);
  }

  function yellowSlopeToken(direction, id) {
    return "S" + direction.charAt(0) + "c" + String(id);
  }

  function transformDirectionalToken(token, transformType) {
    const value = String(token ?? "");
    const directionChars = DIRECTION_CHARS_BY_TRANSFORM[transformType];

    if (!directionChars) {
      return value;
    }

    const puncherMatch = /^p([rlud])$/.exec(value);

    if (puncherMatch) {
      return "p" + directionChars[puncherMatch[1]];
    }

    const slopeMatch = /^S([rlud])(.*)$/.exec(value);

    if (slopeMatch) {
      return "S" + directionChars[slopeMatch[1]] + slopeMatch[2];
    }

    return value;
  }

  function transformDirectionalCellValue(cellValue, blockAdder, transformType) {
    const separator = typeof blockAdder === "string" && blockAdder ? blockAdder : "+";

    return String(cellValue ?? "")
      .split(separator)
      .map((token) => transformDirectionalToken(token, transformType))
      .join(separator);
  }

  return {
    resolvePatternToken,
    boxToken,
    cloneToken,
    blueSlopeToken,
    yellowSlopeToken,
    transformDirectionalToken,
    transformDirectionalCellValue
  };
});
