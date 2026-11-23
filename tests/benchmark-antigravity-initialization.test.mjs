import test from 'node:test';import assert from 'node:assert/strict';
import { inspectAuthenticationFailure } from '../benchmarking/recover-antigravity-initialization.mjs';
const event = () => ({event:'result',result:{conversation_id:'',status:'ERROR',response:'',error:'authentication failed or timed out',duration_seconds:0,num_turns:0,usage:{input_tokens:0,output_tokens:0,thinking_tokens:0,cache_read_tokens:0,total_tokens:0}},_received_at:'2026-11-05T17:09:04.902Z',_turn_id:'auth-attempt'});
test('only a zero-activity authentication failure can clear a false initialization flag',()=>{
  assert.equal(inspectAuthenticationFailure([event()]).turn_id,'auth-attempt');
  for(const patch of [{response:'model text'},{conversation_id:'new-session'},{num_turns:1},{duration_seconds:1},{error:'unrelated failure'},{usage:{input_tokens:1,output_tokens:0,thinking_tokens:0,cache_read_tokens:0,total_tokens:1}}]){const e=event();Object.assign(e.result,patch);assert.throws(()=>inspectAuthenticationFailure([e]));}
  assert.throws(()=>inspectAuthenticationFailure([{...event(),event:'step_update'},event()]));
  assert.throws(()=>inspectAuthenticationFailure([{...event(),tool_name:'shell'}]));
});
