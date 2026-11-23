/**
 * A test is visible in a tag when one of its direct tags is that tag or one
 * of its descendants. The visited set also makes malformed legacy cycles safe.
 *
 * @param {readonly string[]} directTagIds
 * @param {string} tagId
 * @param {ReadonlyMap<string, { id: string, parentId?: string }>} tagsById
 */
export function directTagsIncludeTag(directTagIds, tagId, tagsById) {
  return directTagIds.some((directTagId) => {
    const visited = new Set();
    let cursor = tagsById.get(directTagId);
    while (cursor && !visited.has(cursor.id)) {
      if (cursor.id === tagId) return true;
      visited.add(cursor.id);
      cursor = cursor.parentId ? tagsById.get(cursor.parentId) : undefined;
    }
    return false;
  });
}

/**
 * @param {string} tagId
 * @param {ReadonlyMap<string, { id: string, parentId?: string }>} tagsById
 */
export function rootTagId(tagId, tagsById) {
  const visited = new Set();
  let cursor = tagsById.get(tagId);
  let rootId;
  while (cursor && !visited.has(cursor.id)) {
    rootId = cursor.id;
    visited.add(cursor.id);
    cursor = cursor.parentId ? tagsById.get(cursor.parentId) : undefined;
  }
  return rootId;
}

/**
 * Keep the authored taxonomy strictly two levels deep. Legacy descendants are
 * promoted to direct children of their root group without changing their ids.
 *
 * @template {{ id: string, parentId?: string }} T
 * @param {readonly T[]} tags
 * @returns {T[]}
 */
export function flattenSubtags(tags) {
  const tagsById = new Map(tags.map((tag) => [tag.id, tag]));
  return tags.map((tag) => {
    if (!tag.parentId) return { ...tag };
    const rootId = rootTagId(tag.id, tagsById);
    return rootId && rootId !== tag.id && tag.parentId !== rootId
      ? { ...tag, parentId: rootId }
      : { ...tag };
  });
}

/**
 * Canonicalize a case's direct subtag membership using the saved tag order.
 *
 * @param {readonly string[]} tagIds
 * @param {ReadonlyMap<string, number>} tagOrder
 */
export function canonicalTagCombination(tagIds, tagOrder) {
  return [...new Set(tagIds)].sort((left, right) =>
    (tagOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (tagOrder.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right));
}

/** @param {readonly string[]} tagIds @param {ReadonlyMap<string, number>} tagOrder */
export function tagCombinationKey(tagIds, tagOrder) {
  return canonicalTagCombination(tagIds, tagOrder).join("\u001f");
}

/**
 * A multi-subtag case is intentionally absent from each individual subtag.
 * It is shown by its derived combination alias instead.
 *
 * @param {readonly string[]} testTagIds
 * @param {string} tagId
 */
export function directSubtagViewIncludesTest(testTagIds, tagId) {
  const uniqueTagIds = [...new Set(testTagIds)];
  return uniqueTagIds.length === 1 && uniqueTagIds[0] === tagId;
}

/**
 * Count true saved membership rather than cards visible in an individual
 * subtag view. Multi-subtag combination cases still use every constituent tag.
 *
 * @param {{ folderId: string, tagIds: readonly string[] }} test
 * @param {{ id: string, parentId?: string }} tag
 */
export function testUsesTag(test, tag) {
  return tag.parentId
    ? test.folderId === tag.parentId && test.tagIds.includes(tag.id)
    : test.folderId === tag.id;
}

/**
 * @param {readonly string[]} testTagIds
 * @param {readonly string[]} combinationTagIds
 * @param {ReadonlyMap<string, number>} tagOrder
 */
export function combinationViewIncludesTest(testTagIds, combinationTagIds, tagOrder) {
  return tagCombinationKey(testTagIds, tagOrder) ===
    tagCombinationKey(combinationTagIds, tagOrder);
}

/**
 * @param {string} groupTagId
 * @param {readonly { default?: boolean, id: string, name: string, parentId?: string }[]} tags
 */
export function defaultSubtagId(groupTagId, tags) {
  return tags.find((tag) => tag.parentId === groupTagId &&
    (tag.default || tag.name.trim().toLowerCase() === "default"))?.id;
}

/**
 * Add one stable, reserved Default child to every top-level tag group.
 * Existing default children are normalized instead of duplicated.
 *
 * @template {{ collapsed?: boolean, default?: boolean, id: string, locked?: boolean, name: string, parentId?: string }} T
 * @param {readonly T[]} tags
 * @returns {Array<T | (T & { default: true, parentId: string })>}
 */
export function ensureDefaultSubtags(tags) {
  const usedIds = new Set(tags.map((tag) => tag.id));
  const roots = tags.filter((tag) => !tag.parentId);
  const existingDefaults = new Map(roots.flatMap((root) => {
    const existing = tags.find((tag) => tag.parentId === root.id &&
      (tag.default || tag.name.trim().toLowerCase() === "default"));
    return existing ? [[root.id, existing.id]] : [];
  }));
  const generatedDefaults = new Map();
  for (const root of roots) {
    if (existingDefaults.has(root.id)) continue;
    const baseId = `${root.id}-default`;
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
    usedIds.add(id);
    generatedDefaults.set(root.id, {
      collapsed: false,
      default: true,
      id,
      locked: false,
      name: "Default",
      parentId: root.id,
    });
  }
  return tags.flatMap((tag) => {
    const normalized = tag.parentId && existingDefaults.get(tag.parentId) === tag.id
      ? { ...tag, default: true, name: "Default" }
      : tag;
    return tag.parentId
      ? [normalized]
      : [normalized, ...(generatedDefaults.has(tag.id) ? [generatedDefaults.get(tag.id)] : [])];
  });
}

/**
 * Enforce one root group and one-or-more direct subtags. A Default subtag is
 * used only when the case has no authored subtag in its selected group.
 *
 * @param {{ directTagIds?: readonly string[], preferredTagId?: string }} value
 * @param {readonly { default?: boolean, id: string, name: string, parentId?: string }[]} tags
 */
export function normalizeTestTagPlacement(value, tags) {
  const tagsById = new Map(tags.map((tag) => [tag.id, tag]));
  const rootTags = tags.filter((tag) => !tag.parentId);
  const validDirect = [...new Set((value.directTagIds ?? []).filter((tagId) => tagsById.has(tagId)))];
  const preferredRoot = value.preferredTagId && tagsById.has(value.preferredTagId)
    ? rootTagId(value.preferredTagId, tagsById)
    : undefined;
  const groupTagId = preferredRoot ??
    (validDirect.length ? rootTagId(validDirect[0], tagsById) : undefined) ??
    rootTags[0]?.id;
  if (!groupTagId) return { groupTagId: "", tagIds: [] };

  const defaultId = defaultSubtagId(groupTagId, tags);
  let tagIds = validDirect.filter((tagId) =>
    tagId !== groupTagId && rootTagId(tagId, tagsById) === groupTagId);
  if (tagIds.some((tagId) => tagId !== defaultId)) {
    tagIds = tagIds.filter((tagId) => tagId !== defaultId);
  }
  if (!tagIds.length && defaultId) tagIds = [defaultId];
  return { groupTagId, tagIds };
}
