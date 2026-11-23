import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from '../v1/integrity.mjs';

export const PROVIDER = 'deepseek-harness';
export const POLICY = 'deepseek-harness-mcp-v1';
export const VERSION = '0.2.1-rc.5';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const runtimeHome = () => process.env.MAZEBENCH_DEEPSEEK_RUNTIME || path.join(os.homedir(), '.mazebench/deepseek-runtime');
export const authHome = () => process.env.MAZEBENCH_DEEPSEEK_AUTH_HOME || path.join(os.homedir(), '.dsh');
export const toolNames = enabled => ['maze_observe', 'maze_action', 'maze_sequence', ...(enabled ? ['python_exec'] : [])];
export const cliPath = (installation = runtimeHome()) => path.join(installation, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
export const yaml = (installation = runtimeHome()) => createRequire(cliPath(installation))('yaml');

export const credentialFile = (home, route) => path.join(home,
  route === 'anthropic' ? 'mazebench-anthropic.credentials.json' : route === 'openai' ? 'mazebench-chatgpt.credentials.json' : '.credentials.yaml');
export function credentialRoutes(home = authHome(), installation = runtimeHome()) {
  const read = route => { const file = credentialFile(home, route); return (existsSync(file) ? yaml(installation).parse(readFileSync(file, 'utf8')) : null) || {}; };
  const saved = read('deepseek-official'), routes = [];
  if (saved.records?.['deepseek-account-platform/default']?.kind === 'grant') routes.push('deepseek-account');
  else if (saved.refs?.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY) routes.push('deepseek-official');
  if (read('anthropic').refs?.ANTHROPIC_API_KEY) routes.push('anthropic');
  const grant = read('openai').records?.['llm-pi-ai/openai'];
  if (grant?.kind === 'grant' && grant.payload?.scopes?.includes('chatgpt.tokens.use.direct')) routes.push('openai');
  if (!routes.length) throw new Error('Connect a provider in DeepSeek Harness Settings → Models or run a MazeBench provider setup command.');
  return routes;
}
export const credentialRoute = (home, installation) => credentialRoutes(home, installation)[0];

export function environment(home, connection) {
  return { HOME: home, DSH_HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8', NO_COLOR: '1', CI: '1', DSH_TELEMETRY_DISABLED: '1',
    ...(process.env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : {}),
    ...(connection?.key_ref && process.env[connection.key_ref] ? { [connection.key_ref]: process.env[connection.key_ref] } : {}) };
}

// Disable optional tools and prompt contributors in the pinned official bundle.
// The remaining agent loop, compactor and session persistence are the stock harness.
const disabled = new Set(['agent-instructions', 'skill-filesystem', 'plan-mode', 'user-questions', 'goal-round-driver',
  'subagent', 'agent-team', 'subagent-spawn-in-process', 'subagent-fork-in-process', 'workflow-ptc', 'ptc-runtime',
  'session-title-llm', 'settings', 'config-editor', 'plugin-manager', 'session-log-deepseek', 'plugin-package-inventory-deepseek',
  'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http', 'llm-pi-ai', 'repeat-tool-reminder', 'mcp-resources']);

// The pinned CLI rewrites this anchor at every boot. Keep its exact bytes in
// the signed profile while allowing that identical rewrite.
const rootConfig = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;

export function profileFiles({ root, directory, home, installation = runtimeHome(), credentialHome = authHome(),
  model, effort, route = 'deepseek-official', connection, modelProfile, catalogProfiles, endpoint, mcp, catalog = false }) {
  const baseFile = path.join(installation, 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml');
  const entries = yaml(installation).parse(readFileSync(baseFile, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })[0].insert;
  const patches = entries.filter(entry => disabled.has(entry.id) || entry.id.startsWith('tool-') && entry.id !== 'tool-executor-native')
    .map(entry => ({ id: entry.id, disabled: true }));
  if (!connection && !['deepseek-official', 'deepseek-account', 'anthropic', 'openai'].includes(route)) throw new Error('Unsupported DeepSeek Harness provider route.');
  if (connection || ['anthropic', 'openai'].includes(route)) patches.push({ id: 'llm-pi-ai', disabled: false, config: { providers: {
    // A named Google catalog route uses pi-ai's native Gemini adapter.
    [route]: { ...(connection ? { ...(connection.api !== 'google-generative-ai' ? { api: connection.api } : {}),
        baseURL: connection.api === 'anthropic-messages' ? connection.base_url.replace(/\/v1\/?$/, '') : connection.base_url,
        ...(connection.auth !== 'chatgpt' ? { apiKeyEnv: connection.key_ref } : {}) }
        : route === 'anthropic' ? { apiKeyEnv: 'ANTHROPIC_API_KEY' } : {}),
      ...(endpoint ? { baseURL: endpoint } : {}),
      ...(!catalog || catalogProfiles ? { models: catalogProfiles || [modelProfile || { id: model }] } : {}) }
  } } });
  patches.push(
    { id: 'credentials', disabled: false, config: { path: connection?.credential_file || credentialFile(credentialHome, route), watch: false } },
    { id: 'authorization', disabled: route !== 'deepseek-account' },
    { id: 'deepseek-account', disabled: route !== 'deepseek-account' },
    { id: 'llm-deepseek-account', disabled: route !== 'deepseek-account' },
    { id: 'llm-deepseek', disabled: route !== 'deepseek-official', config: { ...(endpoint ? { baseURL: endpoint } : {}) } },
    { id: 'agent-default-model', config: { provider: route, model, ...(effort && effort !== 'default' ? { reasoningEffort: effort === 'none' ? 'off' : effort } : {}) } },
    { id: 'system-prompt', config: { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '' } },
    { id: 'session-persistence-jsonl', config: { root: path.join(home, 'sessions'), compression: 'none' } },
  );
  if (catalog) {
    patches.push({ id: 'headless-startup', disabled: true }, { id: 'headless-runner', disabled: true },
      { id: 'sandbox-policy', inject: [], config: { mode: 'read-only', workspaceRoot: directory } },
      { insert: [{ id: 'mazebench-catalog', name: path.join(root, 'benchmarking/deepseek/catalog-plugin.mjs'), config: { route, installation, accountVerified: Boolean(connection) } }] });
  } else {
    patches.push({ insert: [{ id: 'mazebench-mcp', name: '@deepseek-ai/dsh-mcp-client', required: true,
      config: { serverName: 'mazebench', transport: 'stdio', command: process.execPath,
        args: [mcp || path.join(root, 'benchmarking/deepseek/mcp.mjs')], cwd: directory,
        env: { MAZEBENCH_PROJECT_ROOT: root, MAZEBENCH_RUN_DIRECTORY: directory },
        startupTimeoutMs: 30000, toolCallTimeoutMs: 120000, failOnStartupError: true, reconnect: { enabled: false } } }] });
  }
  return {
    'profiles/headless/package.json': JSON.stringify({ name: 'mazebench-deepseek', private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } } }),
    'profiles/headless/cordis.yml': rootConfig,
    'profiles/headless/cordis.patch.yml': JSON.stringify(patches, null, 2) + '\n',
  };
}

const fileHashes = new Map();
export function fileHash(file) {
  const stat = statSync(file), key = [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  if (fileHashes.get(file)?.key !== key) fileHashes.set(file, { key, hash: digest(readFileSync(file)) });
  return fileHashes.get(file).hash;
}
export function installationInfo(installation = runtimeHome()) {
  const executable = realpathSync(cliPath(installation));
  const version = JSON.parse(readFileSync(path.join(installation, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version;
  if (version !== VERSION) throw new Error(`DeepSeek Harness ${VERSION} is required. Run npm run setup:deepseek.`);
  const inventory = createHash('sha256');
  function scan(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.bin' || entry.name === '.cache') continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (entry.isFile()) inventory.update(path.relative(installation, file) + '\0' + fileHash(file) + '\n');
      else throw new Error('Unexpected symbolic link in the DeepSeek installation.');
    }
  }
  scan(path.join(installation, 'node_modules'));
  return { executable, version, sha256: inventory.digest('hex') };
}

export async function runtimeHashes(root) {
  const entries = await readdir(path.join(root, 'benchmarking/deepseek'), { withFileTypes: true });
  const files = entries.filter(entry => entry.name.endsWith('.mjs')).map(entry => 'benchmarking/deepseek/' + entry.name).sort();
  for (const entry of await readdir(path.join(root, 'benchmarking/connections'), { withFileTypes: true })) if (entry.name.endsWith('.mjs')) files.push('benchmarking/connections/' + entry.name);
  files.sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(path.join(root, file)))])));
}

export async function verifyIntegrity(root, directory, metadata, { installation = true } = {}) {
  if (existsSync(path.join(directory, 'integrity-violation.json'))) throw new Error('This DeepSeek run was invalidated.');
  const manifest = await verifyRunIntegrity(root, directory, metadata.integrity);
  assertRunConfiguration(metadata, manifest);
  const frozen = manifest.configuration;
  if (metadata.connection_id !== frozen.connection_id) throw new Error('DeepSeek model connection changed.');
  if (metadata.deepseek_route !== frozen.deepseek_route || metadata.billing_source !== frozen.billing_source) throw new Error('DeepSeek provider or billing route changed.');
  if (metadata.provider !== PROVIDER || frozen.provider !== PROVIDER || frozen.deepseek_policy !== POLICY ||
      metadata.observation_mode !== 'ascii' || metadata.world !== 'main-world' || frozen.deepseek_version !== VERSION ||
      metadata.coding_mode !== (metadata.tools_enabled ? 'python' : 'off')) throw new Error('DeepSeek run configuration changed.');
  if (installation && installationInfo(frozen.deepseek_installation).sha256 !== frozen.deepseek_sha256) throw new Error('DeepSeek Harness installation changed.');
  if (JSON.stringify(await runtimeHashes(root)) !== JSON.stringify(frozen.deepseek_runtime)) throw new Error('DeepSeek harness adapter changed.');
  const expected = profileFiles({ root, directory, home: frozen.deepseek_home, installation: frozen.deepseek_installation,
    credentialHome: frozen.deepseek_auth_home, model: frozen.model, effort: frozen.effort, route: frozen.deepseek_route,
    connection: frozen.model_connection, modelProfile: frozen.model_profile });
  if (JSON.stringify(Object.keys(expected)) !== JSON.stringify(Object.keys(frozen.deepseek_config))) throw new Error('DeepSeek profile inventory changed.');
  for (const [name, content] of Object.entries(expected)) {
    if (frozen.deepseek_config[name] !== digest(content) || digest(await readFile(path.join(frozen.deepseek_home, name))) !== digest(content)) throw new Error('DeepSeek profile changed.');
  }
  if (existsSync(path.join(frozen.deepseek_home, 'cordis.patch.yml')) || existsSync(path.join(frozen.deepseek_home, '.env'))) throw new Error('Unexpected DeepSeek home configuration.');
  if (digest(await readFile(path.join(directory, 'prompt.md'))) !== frozen.effective_prompt_sha256) throw new Error('Benchmark prompt changed.');
  verifyCheckpoint(directory);
  return frozen;
}
