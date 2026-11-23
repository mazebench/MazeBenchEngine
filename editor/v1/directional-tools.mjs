// Collapse four-way parser entries into one toolbox tool, then resolve the
// concrete token from the cardinal editor camera only when it is painted.

function entriesForDefinition(definition) {
  if (!Array.isArray(definition.tokens)) return [];
  return definition.tokens.map((entry) =>
    typeof entry === "string" ? { token: entry } : entry);
}

function familySignature(entry) {
  const properties = Object.entries(entry)
    .filter(([key]) => !["direction", "label", "selectable", "token"].includes(key))
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(properties);
}

function directionalFamily(parser, token) {
  for (const [name, definition] of Object.entries(parser.objects || {})) {
    const entries = entriesForDefinition(definition);
    const selected = entries.find((entry) => entry.token === token);
    if (!selected?.direction) continue;
    const signature = familySignature(selected);
    return {
      entries: entries.filter((entry) => entry.direction && familySignature(entry) === signature),
      isSlope: `${definition.type || name}`.includes("slope"),
      name,
      selected
    };
  }
  return null;
}

export function parserToolTokens(parser) {
  const result = ["__erase_top__"];
  Object.values(parser.objects || {}).forEach((definition) => {
    if (definition.selectable === false) return;
    if (typeof definition.token === "string") result.push(definition.token);
    const entries = entriesForDefinition(definition).filter((entry) => entry.selectable !== false);
    const addedFamilies = new Set();
    entries.forEach((entry) => {
      if (!entry.direction) {
        result.push(entry.token);
        return;
      }
      const signature = familySignature(entry);
      if (addedFamilies.has(signature)) return;
      addedFamilies.add(signature);
      const family = entries.filter((candidate) =>
        candidate.direction && familySignature(candidate) === signature);
      result.push((family.find((candidate) => candidate.direction === "right") || family[0]).token);
    });
  });
  return [...new Set(result.filter(Boolean))];
}

export function cameraFacingToken(parser, token, directions) {
  const family = directionalFamily(parser, token);
  if (!family) return token;
  // A slope's direction is uphill, so its ramp faces the camera when its
  // uphill edge points away. Other directional objects point toward camera.
  const direction = family.isSlope ? directions.far : directions.near;
  return family.entries.find((entry) => entry.direction === direction)?.token || token;
}

export function portraitToken(parser, token) {
  const family = directionalFamily(parser, token);
  if (!family) return token;
  // These match the original editor portraits: canonical right-hand ramps
  // and a south-facing puncher whose striking face is visible.
  const direction = family.isSlope ? "right" : "down";
  return family.entries.find((entry) => entry.direction === direction)?.token || token;
}

export function isDirectionalTool(parser, token) {
  return directionalFamily(parser, token) !== null;
}
