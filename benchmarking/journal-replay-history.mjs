import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { verifyJournal } from './storage/journal.mjs';
import { readCheckpointJson } from './v1/checkpoint-json.mjs';
import { safeOpenFile, safeReadFile } from './v1/safe-files.mjs';

const cache = new Map();
const maxEntryBytes = 32 * 1024 * 1024;
const verificationError = () => new Error('Replay journal verification failed.');

// Read the authenticated state log without materializing its undo history.
export async function readJournalReplayHistory(directory) {
  const head = verifyJournal(directory);
  const folder = `journal/${head.generation}`;
  const prior = cache.get(directory);
  const extending = prior?.generation === head.generation && prior.bytes <= head.bytes && prior.revision <= head.revision;
  if (extending && prior.revision === head.revision && prior.tip === head.tip) return prior.history;

  const source = extending ? prior.history : await readCheckpointJson(directory, `${folder}/base-state.json`);
  const history = { actions: source.actions.slice(), actionCount: source.actionCount, createdAt: source.createdAt };
  const offset = extending ? prior.bytes : 0;
  let revision = extending ? prior.revision : 0;
  let tip = extending ? prior.tip : null;
  if (offset < head.bytes) {
    const key = safeReadFile(directory, 'sandbox-state/integrity-key', null);
    const fd = safeOpenFile(directory, `${folder}/entries.jsonl`);
    const input = createReadStream(null, {fd, start:offset, end:head.bytes - 1, encoding:'utf8', highWaterMark:256 * 1024});
    let pending = '';
    try {
      for await (const chunk of input) {
        pending += chunk;
        let start = 0, end;
        while ((end = pending.indexOf('\n', start)) !== -1) {
          if (end - start > maxEntryBytes) throw verificationError();
          const {hmac, ...entry} = JSON.parse(pending.slice(start, end));
          start = end + 1;
          const expected = createHmac('sha256', key).update(JSON.stringify(entry)).digest();
          const actual = Buffer.from(String(hmac || ''), 'hex');
          if (entry.generation !== head.generation || entry.revision !== ++revision || entry.previous !== tip ||
              actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw verificationError();
          tip = hmac;

          const {set = {}, arrays = {}} = entry.state;
          if (Object.hasOwn(set, 'actions')) history.actions = set.actions;
          if (Object.hasOwn(set, 'actionCount')) history.actionCount = set.actionCount;
          if (Object.hasOwn(set, 'createdAt')) history.createdAt = set.createdAt;
          const change = arrays.actions;
          if (change) {
            if (!Number.isSafeInteger(change.keep) || change.keep < 0 || change.keep > history.actions.length) throw verificationError();
            history.actions.length = change.keep;
            for (const action of change.append) history.actions.push(action);
          }
        }
        pending = pending.slice(start);
        if (pending.length > maxEntryBytes) throw verificationError();
      }
      if (pending) throw verificationError();
    } finally { input.destroy(); }
  }
  if (tip !== head.tip || revision !== head.revision || history.actions.length !== history.actionCount) throw verificationError();
  cache.delete(directory);
  cache.set(directory, { generation:head.generation, bytes:head.bytes, revision, tip, history });
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  return history;
}
