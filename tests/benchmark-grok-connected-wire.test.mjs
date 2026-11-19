import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { grokConfig } from '../benchmarking/grok-connected/supervisor.mjs';
import { mazeToolNames, grokEnvironment } from '../benchmarking/grok-connected/policy.mjs';
import { runGrokTurn } from '../benchmarking/grok-connected/runner.mjs';
import { availablePort } from '../benchmarking/grok-connected/chatgpt-transport.mjs';

const executable = process.env.MAZEBENCH_GROK_BIN || path.join(os.homedir(), '.local/bin/grok');
for (const [api, oauth = false] of [['anthropic-messages'], ['openai-responses'], ['openai-completions'], ['openai-responses', true]]) {
  test(`stock Grok Build uses ${api}${oauth ? ' with ChatGPT transport' : ''}, resumes and enforces the tool boundary`, { skip: !existsSync(executable), timeout: 90000 }, async t => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-grok-connected-')), home = path.join(temp, 'home'), directory = path.join(temp, 'run');
    t.after(() => rm(temp, { recursive: true, force: true }));
    await mkdir(home); await mkdir(path.join(directory, 'agent-cwd'), { recursive: true });
    const credential_file = path.join(temp, 'credentials.json');
    await writeFile(credential_file, JSON.stringify({ version: 1, refs: { FIXTURE_API_KEY: 'fixture-only' } }), { mode: 0o600 });
    const requests = []; let forbidden = false, quota = false;
    const model = 'fixture-arbitrary-new-model';
    const server = createServer(async (req, res) => {
      if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: model }] })); }
      let bytes = ''; for await (const chunk of req) bytes += chunk;
      const body = JSON.parse(bytes); requests.push({ body, path: req.url, headers: req.headers });
      if (quota && api !== 'openai-responses') { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { type: 'permission_error', message: 'Fixture account limit.' } })); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let sequence = 0;
      const send = event => res.write('data: ' + JSON.stringify({ sequence_number: sequence++, ...event }) + '\n\n');
      // Each new user turn needs one tool invocation, then a final response.
      const messages = body.messages || body.input || [];
      const last = messages.at(-1);
      const title = body.tools?.some(t => (t.name || t.function?.name) === 'session_title');
      const used = title || last?.type === 'function_call_output' || last?.role === 'tool' || last?.role === 'user' && Array.isArray(last.content) && last.content.some(c => c.type === 'tool_result');
      const name = forbidden ? 'run_terminal_cmd' : 'use_tool';
      const input = forbidden ? { command: 'echo forbidden' } : { tool_name: 'mazebench__maze_observe', tool_input: {} };
      if (api === 'anthropic-messages') {
        send({ type: 'message_start', message: { id: 'msg-' + requests.length, type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 20, output_tokens: 0 } } });
        send({ type: 'content_block_start', index: 0, content_block: used ? { type: 'text', text: '' } : { type: 'tool_use', id: 'call-' + requests.length, name, input: {} } });
        send({ type: 'content_block_delta', index: 0, delta: used ? { type: 'text_delta', text: 'Fixture complete.' } : { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
        send({ type: 'content_block_stop', index: 0 });
        send({ type: 'message_delta', delta: { stop_reason: used ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 5 } });
        send({ type: 'message_stop' });
      } else if (api === 'openai-responses') {
        if (oauth) send({ type: 'response.metadata', metadata: { fixture: true } });
        const envelope = { id: 'resp-' + requests.length, object: 'response', created_at: 1, model, error: null, incomplete_details: null, instructions: null, metadata: {}, parallel_tool_calls: false, temperature: 1, tool_choice: 'auto', tools: [], top_p: 1 };
        send({ type: 'response.created', response: { ...envelope, status: 'in_progress', output: [] } });
        if (quota) { send({ type: 'response.failed', response: { ...envelope, status: 'failed', output: [], error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Fixture account limit.' } } }); return res.end(); }
        const item = used ? { type: 'message', id: 'msg-fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture complete.', annotations: [] }] }
          : { type: 'function_call', id: 'fc-fixture', call_id: 'call-' + requests.length, name, arguments: JSON.stringify(input), status: 'completed' };
        send({ type: 'response.output_item.added', output_index: 0, item: { ...item, ...(used ? { content: [] } : { arguments: '' }) } });
        if (used) send({ type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: 'Fixture complete.', logprobs: [] });
        else send({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments });
        send({ type: 'response.output_item.done', output_index: 0, item });
        send({ type: 'response.completed', response: { ...envelope, status: 'completed', output: oauth ? [] : [item], usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 25 } } });
      } else {
        send({ id: 'chat-' + requests.length, created: 1, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: used ? { role: 'assistant', content: 'Fixture complete.' } : { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + requests.length, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }] });
        send({ id: 'chat-' + requests.length, created: 1, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: used ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
        res.write('data: [DONE]\n\n');
      }
      res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const mcp = path.join(temp, 'fixture.mjs');
    await writeFile(mcp, `import readline from 'node:readline';
      for await(const line of readline.createInterface({input:process.stdin})) {
        const r=JSON.parse(line); if(r.id===undefined)continue;
        const result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'mazebench',version:'1'}}:
          r.method==='tools/list'?{tools:${JSON.stringify(mazeToolNames(false).map(name => ({ name, description: 'Fixture', inputSchema: { type: 'object', properties: {} } })))}}:
          {content:[{type:'text',text:'Fixture observation'}]};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
      }`);
    const connection = { id: 'fixture', name: 'Fixture', api, auth: oauth ? 'chatgpt' : 'api-key', base_url: oauth ? 'https://api.openai.com/v1' : `http://127.0.0.1:${server.address().port}/v1`, credential_file, key_ref: 'FIXTURE_API_KEY' };
    const proxyPort = oauth ? await availablePort() : undefined;
    const config = grokConfig({ projectRoot: process.cwd(), runDirectory: directory, grokHome: home, selected: { id: model, connection }, proxyPort })
      .replace('max_retries = 2', 'max_retries = 0').replace('rate_limit_retry_threshold = 2', 'rate_limit_retry_threshold = 0')
      .replace(path.join(process.cwd(), 'benchmarking/grok-connected/mcp.mjs'), mcp);
    await writeFile(path.join(home, 'config.toml'), config);
    await writeFile(path.join(home, 'models_cache.json'), '{}');
    await writeFile(path.join(home, 'settings_cache.json'), '{"payload":"{}"}');
    const metadata = { model, effort: 'default', tools_enabled: false }, control = {};
    t.after(() => control.child?.kill('SIGKILL'));
    const options = { directory, metadata, environment: { ...grokEnvironment(home), GROK_MAX_RETRIES: '0' }, frozen: { grok_executable: executable, grok_home: home, model_connection: connection, grok_transport_port: proxyPort }, prompt: 'Use the maze tool once.', control,
      transportOptions: { token: async () => 'fixture-only', fetcher: (url, options) => { assert.equal(url, 'https://api.openai.com/v1/responses'); return fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, options); } },
      onSession: async id => { metadata.grok_session_id = id; } };
    const first = await runGrokTurn(options);
    assert.equal(first.boundaryError, null, JSON.stringify(first) + '\n' + await readFile(path.join(directory, 'grok-events.jsonl'), 'utf8'));
    assert.equal(first.code, 0, JSON.stringify(first) + '\n' + await readFile(path.join(directory, 'agent-stderr.log'), 'utf8'));
    assert.equal(first.result?.is_error, false, JSON.stringify(first));
    const resumed = await runGrokTurn({ ...options, prompt: 'Use the maze tool again.' });
    assert.equal(resumed.boundaryError, null, JSON.stringify(resumed)); assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.notEqual(resumed.sessionId, first.sessionId);
    assert.ok(requests.length >= 4);
    for (const { body, path: endpoint, headers } of requests) {
      assert.equal(body.model, model, JSON.stringify(requests.map(r => ({ model: r.body.model, path: r.path, stream: r.body.stream, tools: r.body.tools?.map(t => t.name || t.function?.name) })))); assert.equal(body.stream, true);
      assert.equal(headers.authorization, 'Bearer fixture-only', JSON.stringify(requests.map(r => ({ model: r.body.model, authorized: Boolean(r.headers.authorization), tools: r.body.tools?.map(t => t.name || t.function?.name) }))));
      if (api === 'anthropic-messages') { assert.equal(endpoint, '/v1/messages'); assert.equal(headers['x-api-key'], 'fixture-only'); assert.equal(body.thinking, undefined); }
      if (api === 'openai-responses') { assert.equal(endpoint, '/v1/responses'); assert.equal(body.store, false); }
      if (oauth) { assert.ok(body.input.every(i => i.role !== 'system')); assert.equal(body.temperature, undefined); assert.equal(body.max_output_tokens, undefined); }
      if (api === 'openai-completions') assert.equal(endpoint, '/v1/chat/completions');
      const tools = body.tools.map(t => t.name || t.function?.name).sort();
      assert.deepEqual(tools, tools.includes('session_title') ? ['session_title'] : ['search_tool', 'use_tool']);
    }
    quota = true;
    const limited = await runGrokTurn({ ...options, prompt: 'Try with account limit.' });
    assert.ok(limited.code !== 0 || limited.result?.is_error || limited.error, JSON.stringify(limited));
    quota = false; forbidden = true;
    const rejected = await runGrokTurn({ ...options, prompt: 'Try forbidden fixture.' });
    assert.match(rejected.boundaryError, /forbidden|unexpected/i);
  });
}
