import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson } from '../providers/claude-runner.mjs';
import { readCheckpointJson } from '../v1/checkpoint-json.mjs';
import { credentials } from '../prime/policy.mjs';
import { TOOLS, verifyIntegrity } from './policy.mjs';

export const emptyUsage = () => ({ input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, total_tokens: 0 });
export function normalizeUsage(usage) {
  const input = usage?.prompt_tokens, output = usage?.completion_tokens;
  if (![input, output].every(n => Number.isFinite(n) && n >= 0)) return null;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0;
  const writes = usage.prompt_tokens_details?.cache_write_tokens ?? usage.cache_creation_input_tokens ?? 0;
  return { input_tokens: input, cached_input_tokens: Math.min(input, Math.max(0, Number(cached) || 0)),
    cache_write_input_tokens: Math.min(input, Math.max(0, Number(writes) || 0)), output_tokens: output, total_tokens: input + output,
    ...(Number.isFinite(usage.cost) ? { cost_usd: usage.cost } : {}) };
}
export function assistantMessage(raw) {
  if (raw?.role !== 'assistant') throw new Error('Prime returned no assistant message.');
  // Preserve provider reasoning/signatures for subsequent tool-call turns.
  return Object.fromEntries(['role', 'content', 'tool_calls', 'reasoning', 'reasoning_content', 'reasoning_details']
    .filter(key => raw[key] != null).map(key => [key, raw[key]]));
}
export function createGameClient(root, directory) {
  const child = spawn(process.execPath, [path.join(root, 'benchmarking/prime-direct-v2/mcp.mjs')], {
    env: { PATH: '/usr/bin:/bin', MAZEBENCH_PROJECT_ROOT: root, MAZEBENCH_RUN_DIRECTORY: directory }, stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map(); let sequence = 0;
  child.stderr.resume(); // No private host diagnostics enter the model transcript.
  const rejectAll = () => { for (const { reject } of pending.values()) reject(new Error('MazeBench MCP stopped.')); pending.clear(); };
  child.on('error', rejectAll); child.on('exit', rejectAll);
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let value; try { value = JSON.parse(line); } catch { child.kill('SIGKILL'); return; }
    const call = pending.get(value.id); if (!call) return; pending.delete(value.id);
    if (value.error) call.reject(new Error(value.error.message)); else call.resolve(value.result);
  });
  return {
    call: (method, params = {}) => new Promise((resolve, reject) => {
      if (child.exitCode !== null || child.killed) return reject(new Error('MazeBench MCP is unavailable.'));
      const id = ++sequence; pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    }),
    close: async () => {
      if (child.exitCode !== null || child.killed) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.stdin.end(); await exited; clearTimeout(timer);
    }
  };
}
async function sendPrime(body, signal) {
  const { key, team } = await credentials();
  return fetch('https://api.pinference.ai/api/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...(team ? { 'X-Prime-Team-ID': team } : {}) },
    body: JSON.stringify(body), signal
  });
}
export async function primeCompletion(body, control, send = sendPrime) {
  let budget = body.max_tokens, contextRetries = 0, transientRetries = 0;
  while (true) {
    if (control.stopRequested) throw new Error('Run stopped.');
    control.abort = new AbortController();
    const response = await send({ ...body, max_tokens: budget }, AbortSignal.any([control.abort.signal, AbortSignal.timeout(1200000)]));
    if (response.ok) return { ...await response.json(), _output_budget: budget, _context_retries: contextRetries };
    await response.body?.cancel();
    // Some Prime routes report only a generic 400 when input + reserved output
    // exceeds context. Keep every message and the requested reasoning effort;
    // retry a rejected request with bounded, recorded output headroom.
    if (response.status === 400 && budget > 4096 && contextRetries < 4) {
      budget = Math.max(4096, Math.floor(budget / 2)); contextRetries++; continue;
    }
    if (![429, 500, 502, 503, 504].includes(response.status) || transientRetries >= 2) throw new Error(`Prime inference returned HTTP ${response.status} (output budget ${budget}).`);
    await delay(1000 * 2 ** transientRetries++);
  }
}

export async function runDirect({ root, directory, home, control, onUsage = async () => {}, complete = primeCompletion }) {
  const metadata = JSON.parse(await readFile(path.join(directory, 'run.json')));
  await verifyIntegrity(root, directory, metadata);
  const prompt = await readFile(path.join(directory, 'prompt.md'), 'utf8');
  const stateFile = path.join(home, 'conversation.json');
  let state;
  try { state = JSON.parse(await readFile(stateFile)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  state ||= { run_id: metadata.id, messages: [{ role: 'user', content: prompt }], usage: emptyUsage(), pending: null,
    inflight_tool: null, context_tokens: 0, requests: 0, compactions: 0, idle_turns: 0 };
  if (state.run_id !== metadata.id || state.messages[0]?.content !== prompt) throw new Error('Saved Prime conversation does not match this run.');
  if (state.inflight_tool) throw new Error('An interrupted tool call needs reconciliation before resuming; no game action was replayed.');
  const save = () => atomicJson(stateFile, state);
  const emit = event => appendFile(path.join(directory, 'agent-events.jsonl'), JSON.stringify({ ...event, _received_at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  const item = value => emit({ type: 'item.completed', item: value });
  const summary = () => readCheckpointJson(directory, 'summary.json');
  const terminal = async () => ['won', 'action-limit'].includes((await summary()).game_status);
  const interrupted = () => control.stopRequested ? 'stopped' : control.pauseRequested ? 'paused' : null;
  const game = createGameClient(root, directory);
  try {
    await game.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mazebench-prime-direct', version: '1' } });
    const catalog = (await game.call('tools/list')).tools;
    if (JSON.stringify(catalog.map(t => t.name)) !== JSON.stringify(TOOLS)) throw new Error('Unexpected game tool catalog.');
    const tools = catalog.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    await save(); await onUsage(state.usage);
    const request = async (messages, compact = false) => {
      await verifyIntegrity(root, directory, JSON.parse(await readFile(path.join(directory, 'run.json'))));
      const response = await complete({ model: metadata.model, messages, ...metadata.sampling,
        ...(compact ? {} : { tools, tool_choice: 'auto', ...(metadata.parallel_tool_calls === false ? { parallel_tool_calls: false } : {}) }), stream: false }, control);
      const choice = response.choices?.[0];
      const message = assistantMessage(choice?.message), usage = normalizeUsage(response.usage);
      state.requests++;
      if (usage) {
        for (const key of Object.keys(state.usage)) state.usage[key] += usage[key] || 0;
        state.context_tokens = usage.total_tokens;
        await emit({ type: 'request_usage', response_id: randomUUID(), provider_response_id: response.id, model: metadata.model, usage, compact,
          output_budget: response._output_budget ?? metadata.sampling.max_tokens, context_retries: response._context_retries || 0 });
        await emit({ type: 'turn.completed', usage: state.usage });
        await onUsage(state.usage);
      }
      return { message, finish: choice.finish_reason };
    };
    while (true) {
      if (interrupted()) return interrupted();
      if (await terminal()) return 'completed';
      if (state.pending) {
        const calls = state.pending.calls;
        while (state.pending.index < calls.length) {
          if (interrupted()) { await save(); return interrupted(); }
          const call = calls[state.pending.index];
          let result;
          if (call.type !== 'function' || !TOOLS.includes(call.function?.name)) {
            result = { isError: true, content: [{ type: 'text', text: 'Only maze_observe, maze_action and maze_sequence are available. No code executor exists.' }] };
          } else {
            let args; try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = null; }
            if (!args || typeof args !== 'object' || Array.isArray(args)) result = { isError: true, content: [{ type: 'text', text: 'Tool arguments must be a JSON object.' }] };
            else {
              state.inflight_tool = { id: call.id, name: call.function.name, action_count: (await summary()).action_count };
              await save();
              result = await game.call('tools/call', { name: call.function.name, arguments: args });
            }
          }
          state.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
          state.pending.index++; state.inflight_tool = null;
          await save();
          await item({ type: 'mcp_tool_call', server: 'mazebench', tool: call.function?.name, arguments: call.function?.arguments, status: 'completed' });
          if (await terminal()) return 'completed';
        }
        state.pending = null; await save();
      }
      if (interrupted()) return interrupted();
      // Compact only at a complete tool boundary, using the same model/effort.
      // Tool outputs may be much larger than the previous reported context.
      const roughTokens = Buffer.byteLength(JSON.stringify(state.messages)) / 3;
      if (Math.max(state.context_tokens, roughTokens) >= metadata.compaction_threshold) {
        const compact = await request([...state.messages, { role: 'user', content: 'Summarize this ongoing MazeBench game for your continuation. Preserve discovered rooms and routes, exact coordinates, mechanisms, failed plans, current objectives and next actions. Use only information already observed. Do not play or call tools. Return a concise but sufficient working memory.' }], true);
        if (!compact.message.content || compact.finish === 'length') throw new Error('Prime context summary was incomplete; conversation retained.');
        state.messages = [{ role: 'user', content: prompt }, { role: 'assistant', content: compact.message.content },
          { role: 'user', content: 'Continue this same game from the saved working memory. Call maze_observe to check the current state, then keep playing.' }];
        state.compactions++; state.context_tokens = 0; await save();
        await emit({ type: 'context_compacted', count: state.compactions });
      }
      const { message, finish } = await request(state.messages);
      state.messages.push(message);
      const calls = message.tool_calls || [];
      if (calls.length) { state.pending = { calls, index: 0 }; state.idle_turns = 0; }
      else {
        state.idle_turns++;
        state.messages.push({ role: 'user', content: 'The MazeBench game is still in progress. Call maze_observe if needed, then use the game tools to keep playing until won or action-limit.' });
      }
      await save();
      const reasoning = message.reasoning_content || message.reasoning;
      if (typeof reasoning === 'string') await item({ type: 'reasoning', text: reasoning });
      if (typeof message.content === 'string') await item({ type: 'agent_message', text: message.content });
      if (state.idle_turns >= 3) throw new Error(finish === 'length' ? 'Prime exhausted its output budget without a game tool call.' : 'Prime returned three responses without a game tool call.');
    }
  } finally { await game.close(); }
}
