#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--environment", "--name", "--model", "--metadata"].includes(key)) {
      throw new Error(`Unknown argument: ${key}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${key}.`);
    options[key.slice(2)] = value;
    index += 1;
  }
  for (const key of ["environment", "name", "model", "metadata"]) {
    if (!options[key]) throw new Error(`Missing --${key}.`);
  }
  return options;
}

function loadJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

function primeConfig(environment = process.env, homeDir = os.homedir()) {
  const configPath = String(
    environment.PRIME_CONFIG_PATH || path.join(homeDir, ".prime", "config.json")
  );
  let config = loadJson(configPath, {});
  const context = String(environment.PRIME_CONTEXT || "").trim();
  if (context && context !== "production" && /^[a-z0-9_-]+$/i.test(context)) {
    config = {
      ...config,
      ...loadJson(path.join(path.dirname(configPath), "environments", `${context}.json`), {})
    };
  } else if (context === "production") {
    config = { ...config, team_id: null, base_url: "https://api.primeintellect.ai" };
  }
  const apiKey = String(environment.PRIME_API_KEY || config.api_key || "");
  const baseUrl = String(
    environment.PRIME_API_BASE_URL ||
    environment.PRIME_BASE_URL ||
    config.base_url ||
    "https://api.primeintellect.ai"
  ).replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  const teamId = String(environment.PRIME_TEAM_ID || config.team_id || "").trim();
  if (!apiKey) throw new Error("Prime is not signed in. Run `prime login`, then retry the sync.");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("Prime API base URL must use HTTP or HTTPS.");
  return { apiKey, baseUrl, teamId };
}

async function primeApiRequest(config, endpoint, init = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${config.baseUrl}/api/v1${endpoint}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      ...(init.headers || {})
    }
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_error) {
    payload = {};
  }
  if (!response.ok) {
    const detail = payload.detail || payload.error?.message || text || response.statusText;
    throw new Error(`Prime API ${response.status}: ${String(detail).slice(0, 1200)}`);
  }
  return payload;
}

async function createPrimeEvaluation(options, dependencies = {}) {
  const config = dependencies.config || primeConfig(dependencies.environment, dependencies.homeDir);
  const fetchImpl = dependencies.fetchImpl || fetch;
  const slash = options.environment.indexOf("/");
  if (slash <= 0 || slash === options.environment.length - 1) {
    throw new Error("Prime environment must use the owner/name form.");
  }
  const owner = options.environment.slice(0, slash);
  const environmentName = options.environment.slice(slash + 1);
  const environmentResponse = await primeApiRequest(
    config,
    `/environmentshub/${encodeURIComponent(owner)}/${encodeURIComponent(environmentName)}/@latest`,
    {},
    fetchImpl
  );
  const environmentRecord = environmentResponse.data || environmentResponse;
  const environmentId = String(environmentRecord?.id || "");
  if (!environmentId) {
    throw new Error(`Prime environment ${options.environment} did not return an environment id.`);
  }

  const metadata = loadJson(options.metadata, {});
  const payload = {
    name: options.name,
    environments: [{ id: environmentId }],
    model_name: options.model,
    framework: metadata.framework || "verifiers",
    task_type: metadata.task_type || "agent-evaluation",
    metadata,
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    is_public: false
  };
  if (config.teamId) payload.team_id = config.teamId;
  const created = await primeApiRequest(
    config,
    "/evaluations/",
    { method: "POST", body: JSON.stringify(payload) },
    fetchImpl
  );
  const evaluationId = String(created.evaluation_id || created.id || created.data?.evaluation_id || "");
  if (!evaluationId) throw new Error("Prime did not return an evaluation id.");
  return { evaluation_id: evaluationId };
}

async function main() {
  const result = await createPrimeEvaluation(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createPrimeEvaluation,
  parseArgs,
  primeApiRequest,
  primeConfig
};
