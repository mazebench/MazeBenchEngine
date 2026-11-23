import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GeminiAsciiAutoRecovery, GeminiVisionAutoRecovery, geminiVisionRetryable } from '../benchmarking/gemini-vision-auto-recovery.mjs';
const id = 'run-2026-10-26T00-00-00-000Z-bbbbbb';
const error = "This request was blocked by Gemini's filters. They can occasionally trigger by mistake on safe coding, security, or biology-related queries. Please try rephrasing your prompt.";
const json = async file => JSON.parse(await readFile(file, 'utf8'));

async function fixture(t, Recovery = GeminiVisionAutoRecovery, fields = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-gemini-retry-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const directory = path.join(temp, 'runs', id); await mkdir(directory, { recursive: true });
  const metadata = { id, provider: 'antigravity', world: 'main-world', observation_mode: 'vision', tools_enabled: false, coding_mode: 'off',
    capability_policy: { name: 'subscription-vision-coding-off-v1' }, antigravity_session_id: 'same-conversation',
    model: 'gemini-fixture', effort: 'high', effective_prompt_sha256: 'same-prompt', created_at: '2026-10-26T00:00:00Z', status: 'failed', error, ...fields };
  await writeFile(path.join(directory, 'run.json'), JSON.stringify(metadata));
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify({ action_count: 2621, game_status: 'playing' }));
  await writeFile(path.join(directory, 'agent-events.jsonl'), JSON.stringify({ error }) + '\n');
  let time = Date.parse('2026-10-26T03:00:00Z'), resumes = 0, runner = false;
  const update = async patch => writeFile(path.join(directory, 'run.json'), JSON.stringify({ ...await json(path.join(directory, 'run.json')), ...patch }));
  const options = { recordsRoot: path.join(temp, 'runs'), stateRoot: path.join(temp, 'state'), now: () => time, delays: [10, 20, 30],
    request: async (runId, action) => {
      assert.equal(runId, id);
      if (action === 'resume') { resumes++; runner = true; await update({ status: 'continuing', error: null }); }
      else if (action) { runner = false; await update({ status: action === 'pause' ? 'paused' : 'stopped' }); }
      const run = await json(path.join(directory, 'run.json'));
      return { ...run, error: run.error?.trim() || null, runner_active: runner };
    } };
  const c = new Recovery(process.cwd(), options); await c.ready; t.after(() => c.close());
  return { c, options, metadata, directory, update, advance: n => { time += n; }, resumes: () => resumes,
    fail: async (message = error) => { runner = false; await update({ status: 'failed', error: message }); } };
}

test('Gemini retry classification is specific, not a general permission/integrity bypass', () => {
  assert(geminiVisionRetryable(error));
  assert(geminiVisionRetryable(error + ' You can [send feedback](https://example.test) or read more about our policies.\n'));
  for (const other of ['Permission denied', 'Run invalidated by an integrity violation.', 'Vision agent turn failed.', 'Provider executable changed.', 'Quota exceeded', 'Request rejected for prohibited content', 'prefix ' + error]) assert.equal(geminiVisionRetryable(other), false);
});

test('Gemini normal resume preserves history and session, retries with backoff, then stops', async t => {
  const f = await fixture(t), c = f.c;
  const history = await readFile(path.join(f.directory, 'agent-events.jsonl')), summary = await readFile(path.join(f.directory, 'summary.json'));
  await c.tick(); assert.equal(c.status(id), null, 'Historical failures are not adopted.');
  await c.command(id, 'resume'); assert.equal(f.resumes(), 1);
  for (const delay of [10, 20, 30]) {
    await f.fail(error + '\n'); await c.tick(); assert.equal(c.status(id).state, 'waiting');
    f.advance(delay - 1); await c.tick(); assert.equal(c.status(id).state, 'waiting');
    f.advance(1); await Promise.all([c.tick(), c.tick()]); assert.equal(c.status(id).state, 'watching');
  }
  assert.equal(f.resumes(), 4);
  await f.fail(); await c.tick(); assert.equal(c.status(id).state, 'blocked'); assert.equal(c.status(id).enabled, false);
  assert.equal((await json(path.join(f.directory, 'run.json'))).antigravity_session_id, 'same-conversation');
  assert.deepEqual(await readFile(path.join(f.directory, 'agent-events.jsonl')), history);
  assert.deepEqual(await readFile(path.join(f.directory, 'summary.json')), summary);
  const audit = (await readFile(path.join(f.options.stateRoot, 'retry-audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(audit.filter(a => a.status === 'resumed').length, 4);
  assert(audit.every(a => a.action_count === 2621 && a.conversation_id === 'same-conversation'));
});

test('Gemini pause survives restart, new progress resets attempts, hourly cap still applies', async t => {
  const f = await fixture(t); await f.c.enroll(f.metadata); await f.c.tick();
  await f.c.command(id, 'pause'); f.advance(100); await f.c.tick(); assert.equal(f.resumes(), 0);
  await f.c.close();
  const c = new GeminiVisionAutoRecovery(process.cwd(), f.options); await c.ready; t.after(() => c.close());
  await c.tick(); assert.equal(c.status(id).enabled, false); assert.equal(c.decorate(f.metadata).status, 'paused');
  await c.command(id, 'resume');
  await f.fail(); await c.tick(); f.advance(10); await c.tick();
  await writeFile(path.join(f.directory, 'summary.json'), JSON.stringify({ action_count: 2622, game_status: 'playing' }));
  await f.fail(); await c.tick(); assert.equal(c.status(id).attempts, 0);
  c.records.get(id).recent_retries = Array(8).fill(f.options.now());
  await c.tick(); assert.equal(c.status(id).state, 'blocked');
});

test('Gemini refuses invalidated, changed, completed, and unrelated failed runs', async t => {
  for (const kind of ['invalidation', 'identity', 'completed', 'unrelated']) {
    const f = await fixture(t); await f.c.enroll(f.metadata);
    if (kind === 'invalidation') await writeFile(path.join(f.directory, 'integrity-violation.json'), '{"error":"blocked"}');
    if (kind === 'identity') await f.update({ antigravity_session_id: 'different-session' });
    if (kind === 'completed') await writeFile(path.join(f.directory, 'summary.json'), JSON.stringify({ action_count: 2621, game_status: 'won' }));
    if (kind === 'unrelated') await f.fail('Provider executable changed.');
    await f.c.tick(); f.advance(10); await f.c.tick();
    assert.equal(f.resumes(), 0); assert.equal(f.c.status(id).state, 'blocked');
    if (kind === 'invalidation') assert.equal(await readFile(path.join(f.directory, 'integrity-violation.json'), 'utf8'), '{"error":"blocked"}');
  }
});

test('Gemini pause cancels a pending retry before its owner receives resume', async t => {
  const f = await fixture(t); await f.c.enroll(f.metadata); await f.c.tick(); f.advance(10);
  const original = f.c.request; let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.c.request = async (runId, action) => { if (!action && !release) { entered(); await new Promise(resolve => { release = resolve; }); } return original(runId, action); };
  const tick = f.c.tick(); await ready;
  const pause = f.c.command(id, 'pause'); await Promise.resolve(); release(); await Promise.all([tick, pause]);
  assert.equal(f.resumes(), 0); assert.equal(f.c.status(id).state, 'paused');
});

test('Gemini automatically audits a rejected image read before resuming the same run', async t => {
  const f = await fixture(t);
  const missing = `ENOENT: no such file or directory, lstat '${f.directory}/vision-images/${'a'.repeat(64)}.png'`;
  let repaired = 0;
  f.c.imageReadRepair = async ({ directory, assertInactive, apply }) => {
    assert.equal(directory, f.directory); assert.equal(apply, true);
    await assertInactive(await json(path.join(directory, 'run.json')));
    await rm(path.join(directory, 'integrity-violation.json'));
    await f.update({ status: 'paused', error: null }); repaired++;
  };
  await f.c.enroll(f.metadata); await f.fail(missing);
  await writeFile(path.join(f.directory, 'integrity-violation.json'), JSON.stringify({ error: missing }));
  await f.c.tick(); assert.equal(f.c.status(id).state, 'waiting');
  f.advance(10); await f.c.tick();
  assert.equal(repaired, 1); assert.equal(f.resumes(), 1); assert.equal(f.c.status(id).state, 'watching');
});

test('ASCII coding off, legacy Python on, and Any language retry through the same owner', async t => {
  const conditions = [
    ...['antigravity-mcp-only-v1', 'antigravity-catalog-mcp-v2'].flatMap(name => [
      { capability_policy: { name }, tools_enabled: false, coding_mode: 'off' },
      { capability_policy: { name }, tools_enabled: true, coding_mode: 'python' },
    ]),
    { capability_policy: { name: 'antigravity-mcp-only-v1' }, tools_enabled: true, coding_mode: undefined },
    ...['antigravity-any-language-v2', 'antigravity-catalog-any-language-v3'].map(name => ({ capability_policy: { name }, tools_enabled: true, coding_mode: 'any' })),
  ];
  for (const condition of conditions) {
    const f = await fixture(t, GeminiAsciiAutoRecovery, { observation_mode: 'ascii', ...condition });
    const c = f.c;
    const checkpoint = await readFile(path.join(f.directory, 'summary.json'));
    await c.tick(); assert.equal(c.status(id), null, 'Old failures need an explicit resume.');
    await c.command(id, 'resume');
    await f.fail(error + '\n'); await c.tick(); assert.equal(c.status(id).state, 'waiting');
    f.advance(10); await c.tick(); assert.equal(f.resumes(), 2);
    assert.equal(c.decorate(await c.request(id)).auto_recovery.state, 'watching');
    await f.fail(); await c.tick(); await c.command(id, 'pause'); f.advance(10); await c.tick();
    assert.equal(f.resumes(), 2);
    assert.equal(c.policy.retryable(`ENOENT: no such file or directory, lstat '${f.directory}/vision-images/${'a'.repeat(64)}.png'`), false);
    assert.deepEqual(await readFile(path.join(f.directory, 'summary.json')), checkpoint);
    assert.equal((await json(path.join(f.directory, 'run.json'))).antigravity_session_id, 'same-conversation');
    for (const fields of [{ tools_enabled: true, coding_mode: 'off' }, { tools_enabled: false, coding_mode: 'python' }, { antigravity_session_id: null }, { capability_policy: { name: 'unknown' } }]) {
      assert.equal(c.policy.eligible({ ...f.metadata, ...fields }), false);
    }
  }
});

test('coding-on ASCII uses the same no-progress retry cap and preserves integrity failures', async t => {
  const f = await fixture(t, GeminiAsciiAutoRecovery, { observation_mode: 'ascii', tools_enabled: true, coding_mode: undefined,
    capability_policy: { name: 'antigravity-mcp-only-v1' } });
  await f.c.command(id, 'resume');
  for (const delay of [10, 20, 30]) { await f.fail(); await f.c.tick(); f.advance(delay); await f.c.tick(); }
  await f.fail(); await f.c.tick();
  assert.equal(f.resumes(), 4); assert.equal(f.c.status(id).state, 'blocked');
  await writeFile(path.join(f.directory, 'integrity-violation.json'), '{"error":"changed configuration"}');
  await assert.rejects(f.c.command(id, 'resume'), /integrity violation/);
  assert.equal(f.resumes(), 4);
});

test('a newly failed ASCII run is discovered and an invalidated checkpoint cannot resume', async t => {
  const f = await fixture(t, GeminiAsciiAutoRecovery, { observation_mode: 'ascii', coding_mode: 'off',
    capability_policy: { name: 'antigravity-catalog-mcp-v2' }, created_at: '2026-10-26T03:00:00Z' });
  await f.c.tick(); assert.equal(f.c.status(id).state, 'waiting');
  f.advance(10); await f.c.tick(); assert.equal(f.resumes(), 1);
  await f.fail(); await writeFile(path.join(f.directory, 'integrity-violation.json'), '{}');
  await f.c.tick(); f.advance(20); await f.c.tick();
  assert.equal(f.c.status(id).state, 'blocked');
  assert.equal(f.resumes(), 1);
  assert.equal(await readFile(path.join(f.directory, 'integrity-violation.json'), 'utf8'), '{}');
});
