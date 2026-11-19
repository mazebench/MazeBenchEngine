import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { profileFiles, cliPath, toolNames } from '../benchmarking/deepseek/policy.mjs';
import { runDeepSeekTurn } from '../benchmarking/deepseek/runner.mjs';

const executable = cliPath();
for (const api of ['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai']) {
  const oauth = false;
  const google = api === 'google-generative-ai';
  test(`stock DeepSeek uses arbitrary models over ${api}, resumes and enforces the tool boundary`, { skip: !existsSync(executable), timeout: 90000 }, async t => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-dsh-connected-')), home = path.join(temp, 'home'), directory = path.join(temp, 'run');
    t.after(() => rm(temp, { recursive: true, force: true }));
    await mkdir(home); await mkdir(path.join(directory, 'agent-cwd'), { recursive: true });
    const credential_file = path.join(temp, 'credentials.json');
    await writeFile(credential_file, JSON.stringify({ version: 1, refs: { FIXTURE_API_KEY: 'fixture-only' } }), { mode: 0o600 });
    const requests = []; let forbidden = false, quota = false;
    const model = google ? 'gemini-4-neon' : 'fixture-arbitrary-new-model';
    const signature = 'Zml4dHVyZS1zaWduYXR1cmU=';
    const server = createServer(async (req, res) => {
      if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: model }] })); }
      let bytes = ''; for await (const chunk of req) bytes += chunk;
      const body = JSON.parse(bytes); requests.push({ body, path: req.url, headers: req.headers });
      if (quota && api !== 'openai-responses') { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { type: 'permission_error', message: 'Fixture account limit.' } })); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let sequence = 0;
      const send = event => res.write((api === 'anthropic-messages' ? 'event: ' + event.type + '\n' : '') + 'data: ' + JSON.stringify({ sequence_number: sequence++, ...event }) + '\n\n');
      // Each new user turn needs one tool invocation, then a final response.
      const messages = body.contents || body.messages || body.input || [];
      const last = messages.at(-1);
      const title = body.tools?.some(t => (t.name || t.function?.name) === 'session_title');
      const used = title || last?.parts?.some(part => part.functionResponse) || last?.type === 'function_call_output'
        || last?.role === 'tool' || last?.role === 'user' && Array.isArray(last.content) && last.content.some(c => c.type === 'tool_result');
      const name = forbidden ? 'run_terminal_cmd' : 'mcp__mazebench__maze_observe';
      const input = forbidden ? { command: 'echo forbidden' } : {};
      if (api === 'anthropic-messages') {
        send({ type: 'message_start', message: { id: 'msg-' + requests.length, type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 20, output_tokens: 0 } } });
        send({ type: 'content_block_start', index: 0, content_block: used ? { type: 'text', text: '' } : { type: 'tool_use', id: 'call-' + requests.length, name, input: {} } });
        send({ type: 'content_block_delta', index: 0, delta: used ? { type: 'text_delta', text: 'Fixture complete.' } : { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
        send({ type: 'content_block_stop', index: 0 });
        send({ type: 'message_delta', delta: { stop_reason: used ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 5 } });
        send({ type: 'message_stop' });
      } else if (api === 'openai-responses') {
        const envelope = { id: 'resp-' + requests.length, object: 'response', created_at: 1, model, error: null, incomplete_details: null, instructions: null, metadata: {}, parallel_tool_calls: false, temperature: 1, tool_choice: 'auto', tools: [], top_p: 1 };
        send({ type: 'response.created', response: { ...envelope, status: 'in_progress', output: [] } });
        if (quota) { send({ type: 'response.failed', response: { ...envelope, status: 'failed', output: [], error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Fixture account limit.' } } }); return res.end(); }
        const item = used ? { type: 'message', id: 'msg-fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture complete.', annotations: [] }] }
          : { type: 'function_call', id: 'fc-fixture', call_id: 'call-' + requests.length, name, arguments: JSON.stringify(input), status: 'completed' };
        send({ type: 'response.output_item.added', output_index: 0, item: { ...item, ...(used ? { content: [] } : { arguments: '' }) } });
        if (used) send({ type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: 'Fixture complete.', logprobs: [] });
        else send({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments });
        send({ type: 'response.output_item.done', output_index: 0, item });
        send({ type: 'response.completed', response: { ...envelope, status: 'completed', output: [item], usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 25 } } });
      } else if (google) {
        const part = used ? { text: 'Fixture complete.' } : { functionCall: { name, args: input }, thoughtSignature: signature };
        send({ candidates: [{ index: 0, content: { role: 'model', parts: [part] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 } });
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
          r.method==='tools/list'?{tools:${JSON.stringify(toolNames(false).map(name => ({ name, description: 'Fixture', inputSchema: { type: 'object', properties: {} } })))}}:
          {content:[{type:'text',text:'Fixture observation'}]};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
      }`);
    const connection = { id: 'fixture', name: 'Fixture', api, auth: oauth ? 'chatgpt' : 'api-key',
      base_url: `http://127.0.0.1:${server.address().port}/${google ? 'v1beta' : 'v1'}`, credential_file, key_ref: 'FIXTURE_API_KEY' };
    const files = profileFiles({ root: process.cwd(), directory, home, model, effort: 'default', route: google ? 'google' : 'fixture-provider', connection,
      modelProfile: { id: model, reasoningEfforts: false, contextWindow: 32768, maxTokens: 4000 }, mcp });
    for (const [name, contents] of Object.entries(files)) { await mkdir(path.dirname(path.join(home, name)), { recursive: true }); await writeFile(path.join(home, name), contents); }
    await writeFile(path.join(directory, 'run.json'), JSON.stringify({ provider: 'deepseek-harness', model }));
    const metadata = { model, effort: 'default', tools_enabled: false }, control = {};
    t.after(() => control.child?.kill('SIGKILL'));
    const options = { directory, metadata, frozen: { deepseek_executable: executable, deepseek_home: home, model_connection: connection }, prompt: 'Use the maze tool once.', control,
      onSession: async id => { metadata.deepseek_session_id = id; } };
    const first = await runDeepSeekTurn(options);
    assert.equal(first.success, true, JSON.stringify(first) + '\n' + await readFile(path.join(directory, 'agent-stderr.log'), 'utf8'));
    const resumed = await runDeepSeekTurn({ ...options, prompt: 'Use the maze tool again.' });
    assert.equal(resumed.boundaryError, null, JSON.stringify(resumed)); assert.equal(resumed.success, true, JSON.stringify(resumed));
    assert.equal(resumed.sessionId, first.sessionId);
    assert.ok(requests.length >= 3);
    for (const { body, path: endpoint, headers } of requests) {
      if (google) {
        assert.equal(endpoint.split('?')[0], '/v1beta/models/' + model + ':streamGenerateContent');
        assert.equal(headers['x-goog-api-key'], 'fixture-only');
        assert.deepEqual(body.tools.flatMap(t => t.functionDeclarations.map(f => f.name)).sort(),
          toolNames(false).map(name => 'mcp__mazebench__' + name).sort());
        continue;
      }
      assert.equal(body.model, model, JSON.stringify(requests.map(r => ({ model: r.body.model, path: r.path, stream: r.body.stream, tools: r.body.tools?.map(t => t.name || t.function?.name) })))); assert.equal(body.stream, true);
      if (api !== 'anthropic-messages') assert.equal(headers.authorization, 'Bearer fixture-only');
      if (api === 'anthropic-messages') { assert.equal(endpoint.split('?')[0], '/v1/messages'); assert.equal(headers['x-api-key'], 'fixture-only'); assert.equal(body.thinking, undefined); }
      if (api === 'openai-responses') { assert.equal(endpoint, '/v1/responses'); assert.equal(body.store, false); }
      if (api === 'openai-completions') assert.equal(endpoint, '/v1/chat/completions');
      const tools = [...(body.tools || []), ...(body.input || []).filter(i => i.type === 'additional_tools').flatMap(i => i.tools)].map(t => t.name || t.function?.name).filter(n => n !== '__pi_deferred_placeholder__').sort();
      assert.deepEqual([...new Set(tools)], toolNames(false).map(name => 'mcp__mazebench__' + name).sort());
    }
    if (google) {
      const signatures = requests.map(({ body }) => body.contents.flatMap(c => c.parts).filter(p => p.functionCall).map(p => p.thoughtSignature));
      assert.deepEqual(signatures[1], [signature]);
      assert.ok(signatures[2].includes(signature), 'Resume must preserve Gemini thought signatures.');
    }
    quota = true;
    const limited = await runDeepSeekTurn({ ...options, prompt: 'Try with account limit.' });
    assert.equal(limited.success, false, JSON.stringify(limited));
    quota = false; forbidden = true;
    const rejected = await runDeepSeekTurn({ ...options, prompt: 'Try forbidden fixture.' });
    assert.match(rejected.boundaryError, /unavailable|forbidden/i);
  });
}
