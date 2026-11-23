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

for (const [toolsEnabled, effort, model = 'deepseek-flash', route = 'deepseek-official'] of [[false, 'high'], [true, 'max'], [false, 'none'],
  [false, 'medium', 'claude-haiku-5-5', 'anthropic'], [true, 'high', 'claude-sonnet-5-5', 'anthropic']]) test(`DeepSeek official CLI: ${model} resumes with ${effort} reasoning and only the ${toolsEnabled ? 'Python' : 'coding-off'} tools`,
  { skip: !existsSync(cliPath()), timeout: 60000 }, async t => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-deepseek-wire-'));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const home = path.join(temp, 'profile'), directory = path.join(temp, 'run');
    await mkdir(path.join(directory, 'agent-cwd'), { recursive: true });
    await writeFile(path.join(directory, 'run.json'), JSON.stringify({ provider: 'deepseek-harness', model }));
    await mkdir(home);
    await writeFile(credentialFile(home, route), JSON.stringify({ version: 1, refs: { [route === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'DEEPSEEK_API_KEY']: 'fixture-only' } }), { mode: 0o600 });
    const requests = [], calls = path.join(temp, 'calls.jsonl');
    let forbidden = false;
    const server = createServer(async (req, res) => {
      let bytes = ''; for await (const chunk of req) bytes += chunk;
      const body = JSON.parse(bytes); requests.push(body);
      const used = body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'));
      const tool = toolsEnabled ? 'python_exec' : 'maze_observe';
      const content = forbidden ? [{ type: 'tool_use', id: 'forbidden', name: route === 'anthropic' ? '__pi_deferred_placeholder__' : 'bash', input: { command: 'touch ' + path.join(temp, 'escaped') } }]
        : used ? [{ type: 'text', text: 'Fixture complete.' }]
          : [{ type: 'tool_use', id: 'call-1', name: 'mcp__mazebench__' + tool, input: {} }];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (type, value) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n');
      send('message_start', { message: { id: 'msg-fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null,
        usage: { input_tokens: 20, cache_read_input_tokens: 8, cache_creation_input_tokens: 4, output_tokens: 0 } } });
      content.forEach((block, index) => {
        send('content_block_start', { index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
        send('content_block_delta', { index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
        send('content_block_stop', { index });
      });
      send('message_delta', { delta: { stop_reason: content[0].type === 'tool_use' ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } });
      send('message_stop', {}); res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const mcp = path.join(temp, 'fixture.mjs');
    await writeFile(mcp, `import readline from 'node:readline'; import {appendFileSync} from 'node:fs';
      for await (const line of readline.createInterface({input:process.stdin})) {
        const request=JSON.parse(line); if(request.id===undefined)continue;
        const result=request.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'mazebench',version:'1'}}:
          request.method==='tools/list'?{tools:${JSON.stringify(toolNames(toolsEnabled).map(name => ({ name, description: 'Fixture tool', inputSchema: { type: 'object', properties: {} } })))}}:
          request.method==='tools/call'?(appendFileSync(${JSON.stringify(calls)},JSON.stringify(request.params)+'\\n'),{content:[{type:'text',text:'Fixture observation'}]}):{};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
      }`);
    const files = profileFiles({ root: process.cwd(), directory, home, credentialHome: home, model, effort, route,
      endpoint: `http://127.0.0.1:${server.address().port}`, mcp });
    for (const [name, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(home, name)), { recursive: true });
      await writeFile(path.join(home, name), body, { mode: name.endsWith('/cordis.yml') ? 0o600 : 0o400 });
    }
    const metadata = { tools_enabled: toolsEnabled }, control = {};
    t.after(() => control.child?.kill('SIGKILL'));
    const options = { directory, metadata, frozen: { deepseek_executable: cliPath(), deepseek_home: home }, prompt: 'Call the game tool.', control,
      onSession: async id => { metadata.deepseek_session_id = id; } };
    const first = await runDeepSeekTurn(options);
    assert.equal(first.success, true, JSON.stringify(first) + '\n' + await readFile(path.join(directory, 'agent-stderr.log'), 'utf8'));
    const id = first.sessionId;
    const resumed = await runDeepSeekTurn({ ...options, prompt: 'Continue.' });
    assert.equal(resumed.success, true, JSON.stringify(resumed)); assert.equal(resumed.sessionId, id);
    for (const [name, body] of Object.entries(files)) assert.equal(await readFile(path.join(home, name), 'utf8'), body, name + ' changed during CLI boot/resume');
    for (const request of requests) {
      assert.equal(request.model, model);
      const placeholder = request.tools.find(tool => tool.name === '__pi_deferred_placeholder__');
      if (route === 'anthropic') assert.deepEqual(placeholder, { name: '__pi_deferred_placeholder__', description: 'Reserved placeholder. Never available. Never call this.', input_schema: { type: 'object', properties: {}, required: [] }, defer_loading: true });
      // Stock Anthropic transport reserves an invisible, never-activated cache
      // placeholder. All callable tools must still be exactly the maze allowlist.
      assert.deepEqual(request.tools.filter(tool => tool !== placeholder).map(tool => tool.name).sort(), toolNames(toolsEnabled).map(name => 'mcp__mazebench__' + name).sort());
      if (effort === 'none') assert.equal(request.thinking.type, 'disabled');
      else if (route === 'anthropic') {
        assert.equal(request.thinking.type, 'adaptive');
        assert(request.messages.some(message => message.output_config?.effort === effort));
      } else assert.equal(request.output_config.effort, effort);
    }
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1);
    const telemetry = await new TokenTelemetry().readTimeline(directory);
    assert.equal(telemetry.totals.total_tokens, requests.length * 37);
    assert.equal(telemetry.totals.cached_input_tokens, requests.length * 8);
    assert.equal(telemetry.totals.cache_write_input_tokens, requests.length * 4);
    assert.equal(telemetry.available, true);
    forbidden = true;
    const rejected = await runDeepSeekTurn({ ...options, prompt: 'Attempt a forbidden call.' });
    assert.match(rejected.boundaryError, /unavailable/);
    assert.equal(existsSync(path.join(temp, 'escaped')), false);
  });
