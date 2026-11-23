// Audited operator continuation, outside the signed inference runtime.
import { readFile, writeFile, mkdir, rename, appendFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { verifyIntegrity as verifyV1 } from './prime-direct/policy.mjs';
import { verifyIntegrity as verifyV2 } from './prime-direct-v2/policy.mjs';
import { readCheckpointJson } from './v1/checkpoint-json.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
export const idleFailure = error => ['Prime returned three responses without a game tool call.', 'Prime exhausted its output budget without a game tool call.'].includes(error);
export async function recoverIdleContinuation({ root, directory, home, assertInactive }) {
  const metadataFile = path.join(directory, 'run.json'), file = path.join(home, 'conversation.json');
  const metadataBytes = await readFile(metadataFile), metadata = JSON.parse(metadataBytes);
  if (metadata.provider !== 'prime-agent' || metadata.tools_enabled !== false || metadata.status !== 'failed' || !idleFailure(metadata.error)) return null;
  const verify = { 'prime-inference-direct-v1': verifyV1, 'prime-inference-direct-v2': verifyV2 }[metadata.harness];
  if (!verify) throw new Error('Unrecognized Prime harness; no recovery was applied.');
  await verify(root, directory, metadata);
  const before = await readFile(file), state = JSON.parse(before);
  if (state.run_id !== metadata.id || state.messages?.[0]?.content !== await readFile(path.join(directory, 'prompt.md'), 'utf8')) throw new Error('Saved conversation identity differs; no recovery was applied.');
  if (state.pending || state.inflight_tool) throw new Error('A tool call is pending; operator continuation cannot be appended.');
  if (!(state.idle_turns >= 3)) return null;
  const summary = await readCheckpointJson(directory, 'summary.json');
  if (['won', 'action-limit'].includes(summary.game_status)) return null;
  const prompt = `The operator requested that you resume this same MazeBench run at ${summary.action_count} accepted actions. Call maze_observe now to re-anchor, then make a gameplay action. Keep playing until won, action-limit, or the operator pauses/stops the run. Do not stop merely because a turn ended.`;
  const previousIdle = state.idle_turns;
  // Retain every previous message, usage total, and pending game record. The
  // new user turn is a generic resume instruction, with no puzzle assistance.
  state.messages.push({ role: 'user', content: prompt });
  state.idle_turns = 0;
  const after = Buffer.from(JSON.stringify(state, null, 2) + '\n');
  await assertInactive();
  if (!(await readFile(file)).equals(before) || !(await readFile(metadataFile)).equals(metadataBytes)) throw new Error('Run changed during recovery; no recovery was applied.');
  const at = new Date().toISOString(), recoveryId = randomUUID();
  const backups = path.join(home, 'operator-recovery-backups');
  await mkdir(backups, { recursive: true, mode: 0o700 });
  await writeFile(path.join(backups, recoveryId + '.json'), before, { flag: 'wx', mode: 0o600 });
  const audit = { id: recoveryId, at, run_id: metadata.id, kind: 'operator-resume-after-idle-limit', action_count: summary.action_count,
    before_sha256: digest(before), after_sha256: digest(after), idle_turns_before: previousIdle, idle_turns_after: 0, prompt };
  await appendFile(path.join(home, 'operator-recovery.jsonl'), JSON.stringify({ ...audit, phase: 'prepared' }) + '\n', { mode: 0o600 });
  const temporary = file + '.' + recoveryId + '.tmp';
  await writeFile(temporary, after, { flag: 'wx', mode: 0o600 });
  await assertInactive();
  if (!(await readFile(file)).equals(before) || !(await readFile(metadataFile)).equals(metadataBytes)) throw new Error('Run changed during recovery; backup retained, conversation untouched.');
  await rename(temporary, file);
  await appendFile(path.join(home, 'operator-recovery.jsonl'), JSON.stringify({ ...audit, phase: 'applied' }) + '\n', { mode: 0o600 });
  return { kind: audit.kind, id: recoveryId, action_count: summary.action_count };
}
