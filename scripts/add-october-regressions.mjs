// Idempotent registration of the independently specified October audit cases.
// Only new IDs are added. Existing author edits are never overwritten.
import { readFile, writeFile } from 'node:fs/promises';
import { encodeCompactTest } from '../apps/web/app/projectFormat.mjs';
import { interlockedFixture } from '../engine/tests/helpers/interlocked-fixtures.mjs';
import { cloneVacancyFixture } from '../engine/tests/helpers/clone-vacancy-fixtures.mjs';
const directory = new URL('../project-data/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('project.json', directory), 'utf8'));
const candidates = [];
for (const remote of [false, true]) for (const blocked of [false, true]) for (const passenger of [false, true]) {
  const fixture = interlockedFixture({ remote: remote ? 'right' : null, blocked, passenger });
  candidates.push({ ...fixture, expected: [fixture.expected],
    id: `audit-tunnel-${remote ? 'ramp' : 'plain'}-${blocked ? 'blocked' : 'clear'}-${passenger ? 'rider' : 'bare'}`,
    name: `Interlocked tunnel: ${blocked ? 'ceiling blocks the whole push' : 'one push, one tile'}${passenger ? ' with a passenger' : ''}${remote ? ' · distant ramp' : ''}`,
    description: blocked ? 'The far ceiling intercepts one cell of the tunnel. The entire push, including the player and any passenger, must remain unchanged.' : 'A bar passes through a rigid tunnel. Its foot leaves its own pedestal during the push, but the tunnel still supports it. Every participating body moves north once and retains its height; a distant ramp cannot create momentum.',
    tag: 'engine-regressions-support',
  });
}
for (const obstacle of ['wall', 'two-crates', 'two-floors', 'clear', 'ramp', 'ramp-ceiling']) for (const remote of [false, true]) {
  candidates.push({ ...cloneVacancyFixture({ obstacle, remote }),
    id: `audit-clone-vacancy-${obstacle}-${remote ? 'remote-ramp' : 'local'}`,
    name: `Trailing clone: ${obstacle.replaceAll('-', ' ')}${remote ? ' · distant ramp' : ''}`,
    description: ['clear', 'ramp'].includes(obstacle)
      ? 'The player has a clear destination. The trailing clone may enter the vacated source in the same tick, including when the player ascends a ramp. Subsequent Ice motion belongs only to the player.'
      : 'The player cannot vacate because of solid terrain or the one-crate push limit. The trailing clone must retain its own cell. A ramp elsewhere cannot waive the collision check.',
    tag: 'engine-regressions-actors',
  });
}
if (!manifest.tags.some(t => t.id === 'engine-regressions-actors')) manifest.tags.push({ id: 'engine-regressions-actors', name: 'Actor collisions', parentId: 'engine-regressions', collapsed: true });
let added = 0;
for (const { id, name, description, world, start, expected, tag } of candidates) {
  if (manifest.tests.some(t => t.id === id)) continue;
  const compact = encodeCompactTest({ id, name, description, input: 'up', world,
    folderId: 'engine-regressions', tagIds: [tag], locked: false, hidden: false,
    start: { voxels: start }, intermediate: expected.slice(0, -1).map(voxels => ({ voxels })), expected: { voxels: expected.at(-1) },
  });
  await writeFile(new URL(`tests/${id}.json`, directory), JSON.stringify(compact) + '\n');
  manifest.tests.push({ id, name, groupTagId: compact.groupTagId, tagIds: compact.tagIds, file: `${id}.json` });
  ++added;
}
await writeFile(new URL('project.json', directory), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Registered ${added} new visual regressions.`);
