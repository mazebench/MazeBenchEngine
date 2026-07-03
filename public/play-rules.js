(function () {
  const modules = window.PlayModules || (window.PlayModules = {});

  const DEFAULT_WORLD_AXIS = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  const WORLD_LEVEL_PATTERN = /^level_([A-Z])x([A-Z])$/;

  function normalizeAxisValues(values, fallback = DEFAULT_WORLD_AXIS) {
    const safeFallback = Array.isArray(fallback) ? fallback : DEFAULT_WORLD_AXIS;

    if (!Array.isArray(values) || values.length === 0) {
      return safeFallback.slice();
    }

    const normalized = values
      .filter((value) => typeof value === "string" && /^[A-Z]$/.test(value))
      .slice();

    return normalized.length > 0 ? normalized : safeFallback.slice();
  }

  function parseWorldLevelId(levelId, worldColumns = DEFAULT_WORLD_AXIS, worldRows = DEFAULT_WORLD_AXIS) {
    const match = String(levelId || "").match(WORLD_LEVEL_PATTERN);

    if (!match) {
      return null;
    }

    const columns = normalizeAxisValues(worldColumns);
    const rows = normalizeAxisValues(worldRows);
    const columnIndex = columns.indexOf(match[1]);
    const rowIndex = rows.indexOf(match[2]);

    if (columnIndex === -1 || rowIndex === -1) {
      return null;
    }

    return {
      columnIndex,
      rowIndex
    };
  }

  function worldLevelId(columnIndex, rowIndex, worldColumns = DEFAULT_WORLD_AXIS, worldRows = DEFAULT_WORLD_AXIS) {
    const columns = normalizeAxisValues(worldColumns);
    const rows = normalizeAxisValues(worldRows);

    if (columns.length === 0 || rows.length === 0) {
      return null;
    }

    if (
      columnIndex < 0 ||
      rowIndex < 0 ||
      columnIndex >= columns.length ||
      rowIndex >= rows.length
    ) {
      return null;
    }

    return `level_${columns[columnIndex]}x${rows[rowIndex]}`;
  }

  function adjacentWorldLevelId(levelId, dx, dy, worldColumns = DEFAULT_WORLD_AXIS, worldRows = DEFAULT_WORLD_AXIS) {
    const coordinates = parseWorldLevelId(levelId, worldColumns, worldRows);

    if (!coordinates) {
      return null;
    }

    return worldLevelId(coordinates.columnIndex + dx, coordinates.rowIndex + dy, worldColumns, worldRows);
  }

  modules.PlayRules = {
    DEFAULT_WORLD_AXIS,
    WORLD_LEVEL_PATTERN,
    normalizeAxisValues,
    parseWorldLevelId,
    worldLevelId,
    adjacentWorldLevelId
  };
})();
