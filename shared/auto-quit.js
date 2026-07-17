const AUTO_QUIT_DEFAULT_THRESHOLD = 10;
const AUTO_QUIT_DEFAULT_MODE = "cumulative";
const AUTO_QUIT_DEFAULT_WINDOW = 100;
const AUTO_QUIT_MAX_WINDOW = 10_000;

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function numberInRange(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function integerInRange(value, fallback, minimum, maximum) {
  return Math.round(numberInRange(value, fallback, minimum, maximum));
}

function configuredValue(source, snakeCase, camelCase, fallback) {
  if (source && Object.prototype.hasOwnProperty.call(source, snakeCase)) return source[snakeCase];
  if (source && Object.prototype.hasOwnProperty.call(source, camelCase)) return source[camelCase];
  return fallback;
}

function normalizeAutoQuitConfig(source = {}) {
  const modeValue = String(
    configuredValue(source, "auto_quit_mode", "autoQuitMode", source.mode ?? AUTO_QUIT_DEFAULT_MODE)
  ).trim().toLowerCase();
  return {
    enabled: booleanValue(configuredValue(source, "auto_quit", "autoQuit", source.enabled ?? false)),
    threshold: numberInRange(
      configuredValue(source, "auto_quit_threshold", "autoQuitThreshold", source.threshold ?? AUTO_QUIT_DEFAULT_THRESHOLD),
      AUTO_QUIT_DEFAULT_THRESHOLD,
      0,
      100
    ),
    mode: modeValue === "rolling" ? "rolling" : AUTO_QUIT_DEFAULT_MODE,
    window: integerInRange(
      configuredValue(source, "auto_quit_window", "autoQuitWindow", source.window ?? AUTO_QUIT_DEFAULT_WINDOW),
      AUTO_QUIT_DEFAULT_WINDOW,
      1,
      AUTO_QUIT_MAX_WINDOW
    )
  };
}

function boardStateHash(action) {
  return String(action?.board_state_hash || action?.status?.board_state_hash || "").trim();
}

// This intentionally matches the novelty chart on the run page. A state is
// novel only on its first appearance in the entire run. Cumulative mode also
// includes the initial observation; rolling mode measures action observations
// and waits for a full window before it can fire.
function evaluateAutoQuit(initialStateHash, actions, sourceConfig = {}) {
  const config = normalizeAutoQuitConfig(sourceConfig);
  if (!config.enabled) return null;

  const initialHash = String(initialStateHash || "").trim();
  const hashes = (Array.isArray(actions) ? actions : []).map(boardStateHash).filter(Boolean);
  if (!hashes.length) return null;

  const seen = new Set(initialHash ? [initialHash] : []);
  const novelty = [];
  for (const hash of hashes) {
    const novel = seen.has(hash) ? 0 : 1;
    seen.add(hash);
    novelty.push(novel);
  }

  let novelStates;
  let observedStates;
  if (config.mode === "rolling") {
    if (novelty.length < config.window) return null;
    const window = novelty.slice(-config.window);
    novelStates = window.reduce((sum, value) => sum + value, 0);
    observedStates = window.length;
  } else {
    novelStates = novelty.reduce((sum, value) => sum + value, initialHash ? 1 : 0);
    observedStates = novelty.length + (initialHash ? 1 : 0);
  }

  if (!observedStates) return null;
  const percentage = novelStates / observedStates * 100;
  if (percentage > config.threshold) return null;

  return {
    mode: config.mode,
    threshold: config.threshold,
    window: config.mode === "rolling" ? config.window : null,
    percentage,
    novel_states: novelStates,
    observed_states: observedStates,
    action_count: hashes.length
  };
}

function autoQuitLaunchParams(source = {}) {
  const config = normalizeAutoQuitConfig(source);
  return {
    auto_quit: config.enabled,
    auto_quit_threshold: config.threshold,
    auto_quit_mode: config.mode,
    auto_quit_window: config.window
  };
}

module.exports = {
  AUTO_QUIT_DEFAULT_MODE,
  AUTO_QUIT_DEFAULT_THRESHOLD,
  AUTO_QUIT_DEFAULT_WINDOW,
  AUTO_QUIT_MAX_WINDOW,
  autoQuitLaunchParams,
  evaluateAutoQuit,
  normalizeAutoQuitConfig
};
