import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createActivityClock, consumeActivityEvent, consumeRecoveryEvent, activeTimeReport } from '../benchmarking/active-run-time.mjs';
import { ActivityClockReader } from '../benchmarking/activity-clock-reader.mjs';

const event = (at, type, extra = {}) => ({ _received_at: new Date(at).toISOString(), type, ...extra });
const report = times => ({ samples: times.map((timestamp, i) => ({ timestamp, tokens: 100 + i })), compactions: [], totals: { input_tokens: 123 }, api_estimate: { usd: 1.5 } });

test('explicit failures and resumes remove downtime while retaining long active reasoning', () => {
  const clock = createActivityClock();
  for (const e of [event(0,'thread.started'), event(1,'turn.started'), event(100,'item.started'), event(3_600_000,'item.completed'), event(3_700_000,'turn.failed'), event(20_000_000,'thread.started'), event(20_000_001,'turn.started'), event(20_100_000,'item.completed')]) consumeActivityEvent(clock,e);
  const value = report([100,3_600_000,20_100_000]); value.compactions.push({timestamp:20_050_000,before_tokens:100,after_tokens:10});
  const result = activeTimeReport(value,[clock]);
  assert.equal(result.time_axis.excluded_ms,16_300_000);
  assert.deepEqual(result.samples.map(s=>s.active_ms),[0,3_599_900,3_799_900]);
  assert.equal(result.compactions[0].active_ms,3_749_900);
  assert.deepEqual(result.samples.map(s=>s.timestamp),value.samples.map(s=>s.timestamp));
  assert.equal(result.totals,value.totals); assert.equal(result.api_estimate,value.api_estimate);
  assert.equal(value.samples[0].active_ms,undefined,'display transformation never mutates usage records');
});

test('missing exit events use restart evidence and preserve intervening native token evidence', () => {
  const clock = createActivityClock();
  for (const e of [event(0,'thread.started'),event(100,'item.completed'),event(10000,'thread.started'),event(10100,'item.completed')]) consumeActivityEvent(clock,e);
  const result = activeTimeReport(report([50,200,10100]),[clock]);
  assert.equal(result.time_axis.excluded_ms,9800);
  assert.equal(result.time_axis.inferred_interruptions,1);
  assert.deepEqual(result.samples.map(s=>s.active_ms),[0,150,250]);
  const silent = activeTimeReport(report([0,3_600_000]),[createActivityClock()]);
  assert.equal(silent.time_axis.kind,'elapsed'); assert.equal(silent.time_axis.excluded_ms,0);
});

test('Kimi and Muse process groups, explicit retry delays, and overlapping waits merge once', () => {
  const kimi=createActivityClock();
  for(const e of [event(0,'system.version',{_turn_id:'one'}),event(100,'turn.step.retrying',{_turn_id:'one',delay_ms:500}),event(300,'turn.step.retrying',{_turn_id:'one',delay_ms:500}),event(900,'role',{_turn_id:'one'}),event(10000,'system.version',{_turn_id:'two'}),event(10100,'role',{_turn_id:'two'})]) consumeActivityEvent(kimi,e,{provider:'kimi-code'});
  const result=activeTimeReport(report([0,900,10100]),[kimi]);
  assert.equal(result.time_axis.excluded_ms,9800); // 700 retry + 9,100 stopped
  const muse=createActivityClock();
  for(const e of [event(0,undefined,{_turn_id:'one'}),event(100,undefined,{_turn_id:'one',recorded_at:100000,payload:{kind:'run_terminal'}}),event(10000,undefined,{_turn_id:'two',recorded_at:100000,payload:{kind:'run_terminal'}}),event(11000,undefined,{_turn_id:'two'})]) consumeActivityEvent(muse,e,{provider:'muse-code'});
  const resumed=activeTimeReport(report([0,11000]),[muse]);
  assert.equal(resumed.time_axis.excluded_ms,9900,'replayed Muse terminal event must not stop the new process');
});

test('Prime per-request completions retain reasoning time; recovery journal removes actual backoff', () => {
  const stream=createActivityClock(), recovery=createActivityClock();
  for(const e of [event(0,'request_usage'),event(1,'turn.completed'),event(1000,'request_usage'),event(1001,'turn.completed')]) consumeActivityEvent(stream,e,{provider:'prime-agent',harness:'prime-inference-direct-v1'});
  assert.equal(activeTimeReport(report([0,1000]),[stream]).time_axis.excluded_ms,0);
  for(const [at,name] of [[0,'enabled'],[100,'retry-scheduled'],[300,'retry-started'],[400,'resumed']]) consumeRecoveryEvent(recovery,{at:new Date(at).toISOString(),event:name});
  assert.equal(activeTimeReport(report([0,1000]),[stream,recovery]).time_axis.excluded_ms,300);
});

test('incremental log reader handles partial records, repeated polls and replaced logs', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'mazebench-active-'));
  try {
    const meta={id:'run-2026-10-26T00-00-00-000Z-abcdef',provider:'antigravity'};
    await writeFile(path.join(dir,'run.json'),JSON.stringify(meta));
    const file=path.join(dir,'antigravity-events.jsonl'), first=event(0,'unused',{event:'init',type:undefined}), end=event(100,'unused',{event:'result',type:undefined});
    const resumed=JSON.stringify(event(1000,'unused',{event:'init',type:undefined}));
    await writeFile(file,[first,end].map(e=>JSON.stringify(e)).join('\n')+'\n'+resumed.slice(0,20));
    const reader=new ActivityClockReader(), value=report([0,100,1100]);
    const before=await reader.read(dir,value); assert.equal(before.time_axis.excluded_ms,1000);
    await appendFile(file,resumed.slice(20)+'\n'+JSON.stringify(event(1100,'unused',{event:'step_update',type:undefined}))+'\n');
    const after=await reader.read(dir,value); assert.equal(after.time_axis.excluded_ms,900);
    assert.deepEqual(await reader.read(dir,value),after);
    await writeFile(file,JSON.stringify(first)+'\n');
    assert.equal((await reader.read(dir,value)).time_axis.excluded_ms,0);
  } finally {await rm(dir,{recursive:true,force:true});}
});
