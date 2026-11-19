import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export async function findClaudeSession(metadata, home = path.join(os.homedir(), '.claude')) {
  assert(/^[a-f0-9-]{36}$/.test(metadata.claude_session_id || ''), 'Missing original Claude session.');
  const matches = [], root = path.join(home, 'projects');
  for (const folder of await readdir(root)) {
    const file = path.join(root, folder, metadata.claude_session_id + '.jsonl');
    if (await stat(file).then(s => s.isFile(), () => false)) matches.push(file);
  }
  assert.equal(matches.length, 1, 'Original Claude conversation is not uniquely available.');
  return matches[0];
}
