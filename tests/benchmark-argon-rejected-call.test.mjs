import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRejectedCall } from '../scripts/recover-argon-rejected-call-v1.mjs';

const fixture = () => ['ACTIVE', 'ERROR'].map(state => ({ event: 'step_update', _turn_id: 'turn', _received_at: '2026-11-05T00:59:51.804Z',
  step_update: { state, step_index: 4, conversation_id: 'conversation', tool_name: 'call_mcp_tool', tool_info: {
    name: 'call_mcp_tool', parameters: { Arguments: { ServerName: 'mazebench', ToolName: 'python_exec', code: 'print(1)' } },
    ...(state === 'ERROR' ? { error: { type: 'TOOL_ERROR', message: "invalid arguments:\n- missing properties 'ServerName', 'ToolName'" } } : {})
  } } }));
const options = { conversationId: 'conversation', toolsEnabled: true };
test('only a matched, explicitly rejected routing-schema error qualifies for operator review', () => {
  assert.equal(inspectRejectedCall(fixture(), options).step_index, 4);
  for (const mutate of [
    events => events[1].step_update.tool_info.output = 'data',
    events => events[1].step_update.state = 'COMPLETED',
    events => events[1].step_update.step_index++,
    events => events[1].step_update.conversation_id = 'other',
    events => events[1].step_update.tool_info.error.message = 'execution failed',
    events => events.forEach(e => e.step_update.tool_info.parameters.Arguments.ServerName = 'outside'),
    events => events.forEach(e => e.step_update.tool_info.parameters.Arguments.ToolName = 'shell'),
    events => events.forEach(e => e.step_update.tool_info.parameters.ServerName = 'mazebench'),
    events => events.pop(),
  ]) {
    const events = fixture(); mutate(events); assert.throws(() => inspectRejectedCall(events, options));
  }
  assert.throws(() => inspectRejectedCall(fixture(), { ...options, toolsEnabled: false }));
});
