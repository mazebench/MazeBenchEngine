import test from 'node:test';
import assert from 'node:assert/strict';
import { auditClaudeUsageStream, auditClaudeUsageSession, auditClaudeToolActivity } from '../benchmarking/recover-claude-usage-report.mjs';
import { createClaudeBoundaryValidator, claudeTools } from '../benchmarking/providers-v3/claude-policy.mjs';
const metadata = { model: 'claude-fable-5-2', claude_session_id: 'same', tools_enabled: false };
const encode = rows => rows.map(x => JSON.stringify(x));
function events() { return [
  { type: 'system', subtype: 'init', _turn_id: 't', model: metadata.model, permissionMode: 'dontAsk', tools: claudeTools(false), mcp_servers: [{ name: 'mazebench', status: 'connected' }] },
  { type: 'assistant', _turn_id: 't', message: { model: metadata.model, content: [{ type: 'tool_use', name: 'mcp__mazebench__maze_observe' }] } },
  { type: 'result', _turn_id: 't', _received_at: '2026-11-11T10:09:55.964Z', is_error: true, api_error: 'model_requires_usage_credits', modelUsage: { [metadata.model]: {}, 'claude-opus-5': { outputTokens: 8186 } } }
]; }
test('isolated aggregate mismatch preserves all recorded responses, including after old mixed accounting', async () => {
  const result = await auditClaudeUsageStream(encode(events()), { metadata, validatorFactory: createClaudeBoundaryValidator });
  assert.equal(result.responses_audited, 1);
  const session = [{ type: 'cost-state', sessionId: 'same', modelUsage: { [metadata.model]: {}, 'claude-opus-5': {} } },
    { type: 'assistant', sessionId: 'same', message: { model: metadata.model, content: [{ type: 'text', text: 'continue' }] } },
    { type: 'assistant', sessionId: 'same', timestamp: '2026-11-11T10:09:55.955Z', isApiErrorMessage: true, apiError: 'model_requires_usage_credits', message: { model: '<synthetic>', content: [{ type: 'text', text: 'rate limit' }] } }];
  const tail = await auditClaudeUsageSession(encode(session), { metadata, terminal: result.event });
  assert.equal(tail.bytes_after, Buffer.byteLength(encode(session.slice(0, -1)).join('\n') + '\n'));
  assert.equal(tail.removed_error_messages, 1);
});
test('actual wrong-model output, forbidden tools, mismatched sessions, and nonterminal failures are refused', async () => {
  for (const change of [rows => { rows[1].message.model = 'claude-opus-5'; }, rows => { rows[1].message.content[0].name = 'Bash'; }, rows => { rows[1].session_id = 'different'; }, rows => rows.push({ type: 'assistant', _turn_id: 't' })]) {
    const rows = events(); change(rows); await assert.rejects(auditClaudeUsageStream(encode(rows), { metadata, validatorFactory: createClaudeBoundaryValidator }));
  }
  await assert.rejects(auditClaudeUsageSession(encode([{ type: 'assistant', message: { model: 'claude-opus-5' } }]), { metadata, terminal: events().at(-1) }));
});
test('a rejected unvisited-room call is verified against its provider request and result without removing actions', async () => {
  const rows = events(), action = 'room NxC', error = 'Room NxC has not been visited.';
  rows.splice(2, 0,
    { type: 'assistant', _turn_id: 't', _received_at: '2026-11-11T10:09:50.000Z', message: { model: metadata.model,
      content: [{ type: 'tool_use', id: 'call', name: 'mcp__mazebench__maze_action', input: { action } }] } },
    { type: 'user', _turn_id: 't', _received_at: '2026-11-11T10:09:50.020Z', message: {
      content: [{ type: 'tool_result', tool_use_id: 'call', is_error: true, content: JSON.stringify({ error }) }] } });
  const evidence = await auditClaudeUsageStream(encode(rows), { metadata, validatorFactory: createClaudeBoundaryValidator });
  assert.equal(evidence.rejected_rooms.length, 1);
  const start = { id: 'activity', at: '2026-11-11T10:09:50.010Z', tool: 'maze_action', status: 'running', action_count_before: 123, action };
  const end = { ...start, status: 'failed', completed_at: '2026-11-11T10:09:50.015Z', action_count_after: 123, error };
  const options = { terminalAt: rows.at(-1)._received_at, actionCount: 123, rejectedRooms: evidence.rejected_rooms };
  assert.deepEqual(await auditClaudeToolActivity(encode([start, end]), options), { rejected_room_calls_verified: 1 });
  for (const change of [
    pair => { pair[1].action_count_after++; },
    pair => { pair[1].error = 'Unexpected internal failure'; },
    pair => { pair[1].action = 'room AxB'; },
    pair => { pair[1].completed_at = '2026-11-11T10:09:51.000Z'; },
    pair => { pair.shift(); }, pair => { pair.pop(); },
    pair => { pair.push(...structuredClone(pair)); }
  ]) {
    const pair = structuredClone([start, end]); change(pair);
    await assert.rejects(auditClaudeToolActivity(encode(pair), options));
  }
  await assert.rejects(auditClaudeToolActivity(encode([start, end]), { ...options, rejectedRooms: [] }));
  rows[3].message.content[0].tool_use_id = 'unrelated';
  const unrelated = await auditClaudeUsageStream(encode(rows), { metadata, validatorFactory: createClaudeBoundaryValidator });
  assert.equal(unrelated.rejected_rooms.length, 0);
});
