import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const name = 'mazebench-deepseek-catalog';
export const inject = ['llm', 'credentials'];
async function availableModels(ctx, config) {
  const headers = {}, route = config.route;
  let endpoint;
  if (route === 'anthropic') {
    headers['x-api-key'] = (await ctx.credentials.resolve('ANTHROPIC_API_KEY'))?.value;
    headers['anthropic-version'] = '2023-06-01';
    endpoint = 'https://api.anthropic.com/v1/models?limit=1000';
  } else if (route === 'openai') {
    const { openaiProvider } = await import(pathToFileURL(path.join(config.installation, 'node_modules/@earendil-works/pi-ai/dist/providers/openai.js')).href);
    // Share the stock harness credential lock with inference; refresh tokens rotate.
    const record = await ctx.credentials.modifyRecord('llm-pi-ai/openai', async record => {
      if (record?.kind !== 'grant') throw new Error('ChatGPT is not connected.');
      if (record.payload.expires > Date.now() + 60000) return record;
      return { kind: 'grant', payload: await openaiProvider().auth.oauth.refresh(record.payload, AbortSignal.timeout(15000)) };
    });
    headers.Authorization = 'Bearer ' + record.payload.access;
    endpoint = 'https://api.openai.com/v1/models';
  } else return null;
  const ids = new Set();
  for (let page = 0; page < 100; page++) {
    const response = await fetch(endpoint, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Provider model lookup failed.');
    const body = await response.json();
    const models = route === 'openai' ? body.models : body.data;
    if (!Array.isArray(models)) throw new Error('Invalid provider model catalog.');
    for (const model of models) if (route !== 'openai' || model.visibility === 'list') ids.add(model.slug || model.id);
    if (!body.has_more) return ids;
    const url = new URL(endpoint), cursor = body.last_id;
    if (!cursor || cursor === url.searchParams.get('after_id')) throw new Error('Provider pagination did not advance.');
    url.searchParams.set('after_id', cursor); endpoint = url.href;
  }
  throw new Error('Provider catalog exceeded its page limit.');
}
export function apply(ctx, config) {
  void (async () => {
    await ctx.get('loader').await();
    const available = config.accountVerified ? null : await availableModels(ctx, config);
    const models = (await ctx.llm.listModels(config.route)).filter(model => !available || available.has(model.id));
    const resolved = await Promise.all(models.map(model => ctx.llm.resolveModelInfo(config.route, model.id)));
    process.stdout.write(JSON.stringify({ models: resolved }) + '\n');
    ctx.get('appExit')(0);
  })().catch(() => {
    process.stderr.write('DeepSeek model catalog unavailable. Check sign-in or API key.\n');
    ctx.get('appExit')(1);
  });
}
