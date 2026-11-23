// Operator repair for Prime's rejected reasoning-only assistant messages.
// Preserve the signed runtime, all model output, usage, and game checkpoints.
import { readFile, writeFile, mkdir, rename, appendFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { verifyIntegrity as verifyV1 } from './prime-direct/policy.mjs';
import { verifyIntegrity as verifyV2 } from './prime-direct-v2/policy.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const messageContentFailure = error => /^Prime inference returned HTTP 422(?:\.| \(output budget \d+\)\.)$/.test(error || '');
export function missingContentMessages(messages) {
  return messages.flatMap((message, index) => message.role === 'assistant' && message.content == null &&
    !message.tool_calls?.length && !message.function_call ? [index] : []);
}

export async function recoverPrimeMessageContent({ root, directory, home, assertInactive }) {
  const metadataFile = path.join(directory, 'run.json'), file = path.join(home, 'conversation.json');
  const metadataBytes = await readFile(metadataFile), metadata = JSON.parse(metadataBytes);
  if (metadata.provider !== 'prime-agent' || metadata.status !== 'failed' || !messageContentFailure(metadata.error)) return null;
  const verify = { 'prime-inference-direct-v1': verifyV1, 'prime-inference-direct-v2': verifyV2 }[metadata.harness];
  if (!verify) throw new Error('Unrecognized Prime harness; no message repair was applied.');
  await verify(root, directory, metadata);
  const before = await readFile(file), state = JSON.parse(before);
  if (state.run_id !== metadata.id || state.messages?.[0]?.content !== await readFile(path.join(directory, 'prompt.md'), 'utf8')) throw new Error('Saved conversation identity differs; no message repair was applied.');
  if (state.pending || state.inflight_tool) throw new Error('A tool call is pending; no message repair was applied.');
  const indices = missingContentMessages(state.messages);
  if (!indices.length) return null;
  for (const index of indices) state.messages[index].content = '';
  const after = Buffer.from(JSON.stringify(state, null, 2) + '\n');
  const unchanged = async () => {
    await assertInactive();
    if (!(await readFile(file)).equals(before) || !(await readFile(metadataFile)).equals(metadataBytes)) throw new Error('Run changed during message repair; conversation untouched.');
  };
  await unchanged();
  const id = randomUUID(), backups = path.join(home, 'operator-recovery-backups');
  await mkdir(backups, { recursive: true, mode: 0o700 });
  await writeFile(path.join(backups, id + '.json'), before, { flag: 'wx', mode: 0o600 });
  const audit = { id, at: new Date().toISOString(), run_id: metadata.id, kind: 'operator-repair-missing-message-content',
    message_indices: indices, before_sha256: digest(before), after_sha256: digest(after) };
  const journal = path.join(home, 'operator-recovery.jsonl');
  await appendFile(journal, JSON.stringify({ ...audit, phase: 'prepared' }) + '\n', { mode: 0o600 });
  const temporary = file + '.' + id + '.tmp';
  await writeFile(temporary, after, { flag: 'wx', mode: 0o600 });
  await unchanged();
  await rename(temporary, file);
  await appendFile(journal, JSON.stringify({ ...audit, phase: 'applied' }) + '\n', { mode: 0o600 });
  return { kind: audit.kind, id, message_indices: indices };
}
