import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cliPath, profileFiles, toolNames, credentialFile } from '../benchmarking/deepseek/policy.mjs';
import { runDeepSeekTurn } from '../benchmarking/deepseek/runner.mjs';
import { TokenTelemetry } from '../benchmarking/token-telemetry.mjs';

test('stock DeepSeek loop runs Terra over Responses with OAuth, resumes and rejects quota failures', { skip: !existsSync(cliPath()), timeout: 60000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-dsh-openai-')), home = path.join(temp, 'profile'), directory = path.join(temp, 'run');
  t.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(home); await mkdir(path.join(directory, 'agent-cwd'), { recursive: true });
  await writeFile(path.join(directory, 'run.json'), JSON.stringify({ provider: 'deepseek-harness', model: 'gpt-6.1-terra' }));
  await writeFile(credentialFile(home, 'openai'), JSON.stringify({ version: 1, records: { 'llm-pi-ai/openai': { kind: 'grant', payload: {
    type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', clientId: 'oaiapp_fixture', scopes: ['chatgpt.tokens.use.direct'], expires: Date.now() + 3600000
  } } } }), { mode: 0o600 });
  const requests = []; let quota = false;
  const server = createServer(async (req, res) => {
    let bytes = ''; for await (const chunk of req) bytes += chunk;
    const body = JSON.parse(bytes); requests.push({ body, path: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = event => res.write('data: ' + JSON.stringify(event) + '\n\n');
    send({ type: 'response.created', response: { id: 'resp-' + requests.length, status: 'in_progress', output: [] } });
    if (quota) {
      send({ type: 'response.failed', response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Fixture plan limit.' } } });
      return res.end();
    }
    const used = body.input.some(item => item.type === 'function_call_output');
    const item = used ? { type: 'message', id: 'msg-fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture complete.', annotations: [] }] }
      : { type: 'function_call', id: 'fc-fixture', call_id: 'call-fixture', name: 'mcp__mazebench__maze_observe', arguments: '{}', status: 'completed' };
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, ...(used ? { content: [] } : { arguments: '' }) } });
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { id: 'resp-' + requests.length, status: 'completed', output: [item], usage: { input_tokens: 20,
      input_tokens_details: { cached_tokens: 8 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 25 } } });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const mcp = path.join(temp, 'fixture.mjs');
  await writeFile(mcp, `import readline from 'node:readline';
    for await(const line of readline.createInterface({input:process.stdin})) {
      const r=JSON.parse(line); if(r.id===undefined)continue;
      const result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'mazebench',version:'1'}}:
        r.method==='tools/list'?{tools:${JSON.stringify(toolNames(false).map(name => ({ name, description: 'Fixture', inputSchema: { type: 'object', properties: {} } })))}}:
        {content:[{type:'text',text:'Fixture observation'}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
    }`);
  const files = profileFiles({ root: process.cwd(), directory, home, credentialHome: home, model: 'gpt-6.1-terra', effort: 'high', route: 'openai',
    endpoint: `http://127.0.0.1:${server.address().port}/v1`, mcp });
  for (const [name, contents] of Object.entries(files)) { await mkdir(path.dirname(path.join(home, name)), { recursive: true }); await writeFile(path.join(home, name), contents); }
  const metadata = { tools_enabled: false }, control = {};
  t.after(() => control.child?.kill('SIGKILL'));
  const options = { directory, metadata, frozen: { deepseek_executable: cliPath(), deepseek_home: home }, prompt: 'Call the maze tool.', control,
    onSession: async id => { metadata.deepseek_session_id = id; } };
  const first = await runDeepSeekTurn(options);
  assert.equal(first.success, true, JSON.stringify(first) + '\n' + await readFile(path.join(directory, 'agent-stderr.log'), 'utf8'));
  const resumed = await runDeepSeekTurn({ ...options, prompt: 'Continue.' });
  assert.equal(resumed.success, true, JSON.stringify(resumed)); assert.equal(resumed.sessionId, first.sessionId);
  for (const { body, path, authorization } of requests) {
    assert.equal(path, '/v1/responses'); assert.equal(authorization, 'Bearer fixture-access');
    assert.equal(body.model, 'gpt-6.1-terra'); assert.equal(body.store, false); assert.equal(body.stream, true);
    const tools = [...(body.tools || []), ...body.input.filter(item => item.type === 'additional_tools').flatMap(item => item.tools)];
    assert.deepEqual([...new Set(tools.map(tool => tool.name))].sort(), toolNames(false).map(name => 'mcp__mazebench__' + name).sort());
  }
  const telemetry = await new TokenTelemetry().readTimeline(directory);
  assert.equal(telemetry.totals.input_tokens, requests.length * 20);
  assert.equal(telemetry.totals.cached_input_tokens, requests.length * 8);
  assert.equal(telemetry.totals.output_tokens, requests.length * 5);
  quota = true;
  const failed = await runDeepSeekTurn({ ...options, prompt: 'Continue after fixture quota.' });
  assert.equal(failed.success, false);
  assert.match(failed.error, /subscription_sharing_usage_limit_exceeded|plan limit/i);
});
