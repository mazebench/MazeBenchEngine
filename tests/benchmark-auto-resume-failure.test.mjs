import test from 'node:test';import assert from 'node:assert/strict';
import { recoveryFailure } from '../benchmarking/auto-resume-failure.mjs';
import { failurePolicy } from '../benchmarking/auto-resume-policy.mjs';
const run={id:'run-2026-11-05T00-00-00-000Z-aaaaaa',provider:'deepseek-harness',status:'failed',completed_at:'2026-11-05T20:02:10.538Z',error:'DeepSeek Harness could not complete the turn. See the run’s private agent-stderr.log.'};
const event={type:'status',phase:'turn_end',_turn_id:'turn-id',_received_at:'2026-11-05T20:02:10.530Z',reason:{kind:'error',error:{message:'OAuth refresh failed for openai: fetch failed',code:'TRANSPORT'}}};
test('generic runner failures use the same terminal turn structured transport error',async()=>{
 const result=await recoveryFailure(run,{directory:'/fixture',tail:async()=>[event]});assert.equal(result.error,run.error);assert.equal(failurePolicy(result.recovery_error).kind,'transient');
 assert.equal(failurePolicy('Connection error.').kind,'transient');assert.equal(failurePolicy('Insufficient Balance (request_id: abc)').kind,'blocked');
 const stale=await recoveryFailure({...run,completed_at:'2026-11-06T20:02:10.538Z'},{directory:'/fixture',tail:async()=>[event]});assert.equal(stale.recovery_error,undefined);
 const newer={type:'status',phase:'turn_start',_turn_id:'later',_received_at:'2026-11-05T20:02:10.533Z'};
 assert.equal((await recoveryFailure(run,{directory:'/fixture',tail:async()=>[event,newer]})).recovery_error,undefined);
 const balance=await recoveryFailure(run,{directory:'/fixture',tail:async()=>[{...event,reason:{kind:'error',error:{message:'Insufficient Balance',code:'QUOTA',status:402}}}]});assert.equal(failurePolicy(balance.recovery_error).kind,'blocked');
});
test('Claude aggregate usage mismatch preserves the actual same-turn rate-limit reset', async () => {
 const failed = { ...run, provider: 'claude-code', error: 'Claude reported usage for a different model.' };
 const limit = { type: 'rate_limit_event', _turn_id: 'same', session_id: 'session', _received_at: '2026-11-05T20:02:10.500Z', rate_limit_info: { status: 'rejected', resetsAt: 1795132800 } };
 const end = { type: 'result', _turn_id: 'same', session_id: 'session', is_error: true, _received_at: run.completed_at };
 const result = await recoveryFailure(failed, { directory: '/fixture', tail: async () => [limit, end] });
 assert.equal(result.error, failed.error);
 assert.deepEqual(failurePolicy(result.recovery_error), { kind: 'transient', retryAt: 1795132800000 });
 for (const change of [
  rows => { rows[0]._turn_id = 'old'; }, rows => { rows[0].session_id = 'different'; },
  rows => { rows[0].rate_limit_info.status = 'allowed'; }, rows => { rows[0].rate_limit_info.resetsAt = 'bad'; },
  rows => { rows[0]._received_at = '2026-11-04T20:02:10.500Z'; },
  rows => { rows.push({ type: 'system', subtype: 'init', _turn_id: 'new' }); }
 ]) {
  const rows = structuredClone([limit, end]); change(rows);
  assert.equal((await recoveryFailure(failed, { directory: '/fixture', tail: async () => rows })).recovery_error, undefined);
 }
 assert.equal((await recoveryFailure({ ...failed, completed_at: '2026-11-06T20:02:10.538Z' }, { directory: '/fixture', tail: async () => [limit, end] })).recovery_error, undefined);
});
