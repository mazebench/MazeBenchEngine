// Editor-only numbered family selection. Storage and physics already use the
// numeric genericId/groupId carried by the concrete token generated here.

const MAX_GENERIC_ID = 2_147_483_647;

const FAMILIES = Object.freeze([
  {
    pattern: /^M(\d+)$/,
    canonical: "M0",
    family: "block",
    familyName: "Block",
    toolName: (id) => `Block ${id}`,
    descriptionKey: "__box_prompt__"
  },
  {
    pattern: /^c(\d+)$/,
    canonical: "c0",
    family: "clone",
    familyName: "Clone",
    toolName: (id) => `Clone ${id}`,
    descriptionKey: "__clone_prompt__"
  },
  {
    pattern: /^S([rlud])M(\d+)$/,
    canonical: "SrM0",
    family: "block",
    familyName: "Block",
    toolName: (id) => `Block Ice Slope ${id}`,
    descriptionKey: "__blue_slope_prompt__",
    slope: true
  },
  {
    pattern: /^S([rlud])c(\d+)$/,
    canonical: "Src0",
    family: "clone",
    familyName: "Clone",
    toolName: (id) => `Clone Ice Slope ${id}`,
    descriptionKey: "__yellow_slope_prompt__",
    slope: true
  }
]);

export { MAX_GENERIC_ID };

export function genericToolDescriptor(token) {
  const value = String(token || "");
  for (const definition of FAMILIES) {
    const match = definition.pattern.exec(value);
    if (!match) continue;
    const id = Number(match.at(-1));
    return {
      ...definition,
      id,
      token: value,
      name: definition.toolName(id)
    };
  }
  return null;
}

export function concreteGenericToolToken(token, id) {
  const descriptor = genericToolDescriptor(token);
  if (!descriptor) return token;
  if (!Number.isInteger(id) || id < 0 || id > MAX_GENERIC_ID) {
    throw new Error(`Generic IDs must be whole numbers from 0 to ${MAX_GENERIC_ID}.`);
  }
  return token.replace(/\d+$/, String(id));
}

export function canonicalGenericToolToken(token) {
  return genericToolDescriptor(token)?.canonical || token;
}

export function genericToolDescriptionKey(token) {
  return genericToolDescriptor(token)?.descriptionKey || token;
}

