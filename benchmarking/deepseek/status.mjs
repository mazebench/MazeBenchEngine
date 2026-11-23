import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PROVIDER, VERSION, runtimeHome, authHome, cliPath, credentialRoute, credentialRoutes, environment, profileFiles, installationInfo } from './policy.mjs';
import { connectedCatalog } from '../connections/catalog.mjs';
import { connections } from '../connections/credentials.mjs';

const execute = promisify(execFile);
export async function modelCatalog({ root = path.resolve(import.meta.dirname, '../..'), installation = runtimeHome(), credentialHome = authHome() } = {}) {
  return (await detailedCatalog({ root, installation, credentialHome })).models;
}
export async function detailedCatalog({ root = path.resolve(import.meta.dirname, '../..'), installation = runtimeHome(), credentialHome = authHome(), force = false } = {}) {
  const connected = await connectedCatalog({ force });
  let nativeRoutes = [];
  try { nativeRoutes = credentialRoutes(credentialHome, installation).filter(route => route.startsWith('deepseek')); } catch { /* Other connections can work independently. */ }
  const deepseekConnection = connected.models.find(m => m.connection_id === 'deepseek-api')?.connection;
  if (deepseekConnection && (deepseekConnection.credential_file !== path.join(credentialHome, '.credentials.yaml') || deepseekConnection.key_ref !== 'DEEPSEEK_API_KEY' || deepseekConnection.base_url !== 'https://api.deepseek.com')) {
    nativeRoutes = nativeRoutes.filter(route => route !== 'deepseek-official');
  }
  const states = await Promise.all([
    ...nativeRoutes.map(async route => {
      const state = { id: route === 'deepseek-account' ? 'deepseek-account' : 'deepseek-api', name: route === 'deepseek-account' ? 'DeepSeek account' : 'DeepSeek API' };
      try { return { ...state, models: await routeCatalog({ root, installation, credentialHome, route }) }; }
      catch (error) { return { ...state, models: [], stale: true, error: error.message }; }
    }),
    ...connected.connections.filter(c => c.id !== 'deepseek-api' || !nativeRoutes.includes('deepseek-official')).map(async state => {
      const rows = connected.models.filter(m => m.connection_id === state.id);
      const staleModels = error => rows.map(m => ({ ...m, provider: PROVIDER, deepseek_route: m.connection.catalog_provider || m.connection.id, connection_stale: true, connection_error: error }));
      if (!rows.length || state.stale) return { ...state, models: staleModels(state.error) };
      try {
        const connection = rows[0].connection, route = connection.catalog_provider || connection.id;
        const resolved = await routeCatalog({ root, installation, credentialHome, route, connection, catalogProfiles: rows.map(m => m.model_profile) });
        return { ...state, models: resolved.map(m => ({ ...rows.find(row => row.id === m.id), ...m })) };
      } catch (error) { return { ...state, error: error.message, stale: true, models: staleModels(error.message) }; }
    })
  ]);
  const models = states.flatMap(state => state.models.map(model => ({ ...model, connection_id: state.id, connection_name: state.name })));
  if (!models.length) throw new Error('DeepSeek Harness could not load connected models. Check provider setup and run npm run check:deepseek.');
  return { models, connections: states.map(({ models, ...state }) => ({ ...state, model_count: models.length })) };
}

async function routeCatalog({ root, installation, credentialHome, route, connection, catalogProfiles }) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mazebench-deepseek-catalog-'));
  try {
    const model = catalogProfiles?.[0]?.id || 'deepseek-flash';
    const files = profileFiles({ root, directory: home, home, installation, credentialHome, model, effort: 'default', route, connection, catalogProfiles, catalog: true });
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(home, name)), { recursive: true, mode: 0o700 });
      await writeFile(path.join(home, name), contents, { mode: 0o600 });
    }
    const result = await execute(process.execPath, [cliPath(installation), 'headless'], {
      env: environment(home, connection), cwd: home, timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
    const { models } = JSON.parse(result.stdout.trim());
    return models.map(model => ({ id: model.id, name: model.name || model.id, provider: PROVIDER,
      efforts: model.reasoning?.efforts.map(e => e.id === 'off' ? 'none' : e.id) || ['default'],
      default_effort: model.reasoning?.defaultEffort === 'off' ? 'none' : model.reasoning?.defaultEffort ||
        (model.reasoning?.efforts.some(e => e.id === 'high') ? 'high' : model.reasoning?.efforts[0]?.id === 'off' ? 'none' : model.reasoning?.efforts[0]?.id || 'default'),
      context_limit: model.context?.contextWindow, deepseek_route: route,
      ...(connection ? { billing_source: connection.auth === 'chatgpt' ? 'chatgpt-plan' : connection.id } : {}) }));
  } catch {
    throw new Error('DeepSeek Harness could not load models. Check Settings → Models and run npm run check:deepseek.');
  } finally { await rm(home, { recursive: true, force: true }); }
}

export async function installationStatus({ installation = runtimeHome(), credentialHome = authHome(), models = [] } = {}) {
  let available = false, authenticated = false, tested = false;
  try {
    const installed = installationInfo(installation); available = true;
    const report = await readFile(path.join(installation, 'boundary-report.json'), 'utf8').then(JSON.parse).catch(() => null);
    tested = report?.version === VERSION && report?.sha256 === installed.sha256 && report?.passed === true;
    try { credentialRoute(credentialHome, installation); authenticated = true; }
    catch (error) { if (!connections().length) throw error; authenticated = true; }
    return { available, authenticated, tested, version: VERSION, models, coding_modes: ['off', 'python'],
      verified_routes: tested ? report.routes || ['deepseek-official', 'deepseek-account'] : [],
      verified_protocols: tested ? report.protocols || [] : [],
      launch_ready: tested, error: tested ? null : 'Run npm run check:deepseek to validate this Harness installation.' };
  } catch (error) {
    return { available, authenticated, tested, version: VERSION, models, launch_ready: false,
      error: error.code === 'ENOENT' ? 'Install DeepSeek Harness with npm run setup:deepseek.' : error.message };
  }
}
