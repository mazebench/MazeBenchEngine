import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { authHome, registryFile, validateConnection, connections, providerModels } from '../benchmarking/connections/credentials.mjs';
import { fetchConnectionModels, describeModel } from '../benchmarking/connections/catalog.mjs';

const presets = {
  anthropic: { id: 'anthropic-api', name: 'Anthropic API', api: 'anthropic-messages', base_url: 'https://api.anthropic.com', catalog_provider: 'anthropic' },
  openai: { id: 'openai-api', name: 'OpenAI API', api: 'openai-responses', base_url: 'https://api.openai.com/v1', catalog_provider: 'openai' },
  deepseek: { id: 'deepseek-api', name: 'DeepSeek API', api: 'openai-completions', base_url: 'https://api.deepseek.com', catalog_provider: 'deepseek' },
  google: { id: 'google-ai-studio', name: 'Google AI Studio', api: 'google-generative-ai', base_url: 'https://generativelanguage.googleapis.com/v1beta', catalog_provider: 'google' },
  xai: { id: 'xai-api', name: 'xAI API', api: 'openai-completions', base_url: 'https://api.x.ai/v1', catalog_provider: 'xai' },
  openrouter: { id: 'openrouter-api', name: 'OpenRouter API', api: 'openai-completions', base_url: 'https://openrouter.ai/api/v1', catalog_provider: 'openrouter' }
};
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  id: { type: 'string' }, name: { type: 'string' }, api: { type: 'string' }, 'base-url': { type: 'string' },
  'catalog-provider': { type: 'string' }, 'key-env': { type: 'string' }, list: { type: 'boolean' }, help: { type: 'boolean' }
} });
if (values.help || !values.list && !positionals.length && !values.id) {
  console.log(`Connect models to DeepSeek Harness and Grok Build:
  npm run setup:connection -- anthropic|openai|deepseek|google|xai|openrouter
  npm run setup:connection -- --id my-provider --name "My provider" --api openai-completions --base-url https://example.com/v1
  npm run setup:connection -- --list

The API key is entered at a hidden prompt. --key-env NAME reads an existing environment variable.
Supported APIs: anthropic-messages, openai-responses, openai-completions.
Google AI Studio uses the native Gemini API and is available in DeepSeek Harness.
ChatGPT plan credits: npm run setup:deepseek-chatgpt
Models are discovered from the account's /models endpoint. Refresh models in the launcher after setup.`);
} else if (values.list) {
  for (const c of connections()) console.log(`${c.id}\t${c.name}\t${c.api}\t${c.base_url}`);
} else {
  try {
    const preset = presets[positionals[0]];
    if (positionals[0] && !preset) throw new Error('Unknown preset; use --id, --api and --base-url for another provider.');
    const id = values.id || preset?.id;
    const connection = validateConnection({ ...preset, id, name: values.name || preset?.name || id,
      api: values.api || preset?.api, base_url: values['base-url'] || preset?.base_url,
      catalog_provider: values['catalog-provider'] || preset?.catalog_provider,
      key_ref: 'MAZEBENCH_' + String(id).toUpperCase().replaceAll('-', '_') + '_KEY',
      credential_file: path.join(authHome(), 'connections', String(id) + '.json') });
    let key;
    if (values['key-env']) key = process.env[values['key-env']];
    else {
      if (!process.stdin.isTTY) throw new Error('Run in Terminal for the hidden API key prompt, or pass --key-env NAME.');
      const prompt = spawnSync('python3', ['-c', 'import getpass,sys; sys.stdout.write(getpass.getpass("API key (hidden): "))'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
      if (prompt.status !== 0) throw new Error('API key entry cancelled.');
      key = prompt.stdout.trim();
    }
    if (!key) throw new Error('No API key supplied.');
    const rows = await fetchConnectionModels(connection, { token: key });
    const installed = await providerModels(connection.catalog_provider);
    const models = rows.map(row => describeModel(row, connection, installed)).filter(Boolean);
    if (!models.length) throw new Error('The account returned no compatible language models.');
    const file = registryFile();
    const saved = await readFile(file, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return { version: 1, connections: [] }; throw error; });
    if (saved.version !== 1 || !Array.isArray(saved.connections)) throw new Error('Invalid existing connection registry.');
    async function atomic(file, value) {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = file + '.' + randomUUID();
      await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temp, file);
    }
    await atomic(connection.credential_file, { version: 1, refs: { [connection.key_ref]: key } });
    saved.connections = [...saved.connections.filter(c => c.id !== id), connection];
    await atomic(file, saved);
    const harness = connection.api === 'google-generative-ai' ? 'DeepSeek Harness' : 'DeepSeek Harness or Grok Build';
    console.log(`Connected ${connection.name}: ${models.length} language models. Refresh models in the launcher and select ${harness}.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
