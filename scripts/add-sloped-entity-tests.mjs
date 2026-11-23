// Register independently authored slope fixtures without changing existing cases.
import { readFile, writeFile } from 'node:fs/promises';
import { encodeCompactTest } from '../apps/web/app/projectFormat.mjs';
import {
  slopedEntityFixture, rampEntityFixture, rigidSlopeScenarios, rampEntityScenarios,
} from '../engine/tests/helpers/sloped-entity-fixtures.mjs';

const directory = new URL('../project-data/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('project.json', directory), 'utf8'));
const sections = {
  rigid: 'Rigid bodies',
  support: 'Riders and Ice',
  interactions: 'Pushes and gems',
  'ramp-contacts': 'Ramp contacts',
};
let added = 0;
for (const family of ['box', 'clone']) {
  const fixtures = [
    ...rigidSlopeScenarios.map(scenario => slopedEntityFixture(family, scenario)),
    ...rampEntityScenarios.map(scenario => rampEntityFixture(family, scenario)),
  ];
  const group = fixtures[0].folder;
  for (const [section, name] of Object.entries(sections)) {
    const id = `${group}-${section}`;
    if (!manifest.tags.some(tag => tag.id === id)) {
      manifest.tags.push({ id, name, parentId: group, collapsed: true });
    }
  }
  for (const { scenario, section, name, description, world, start, expected } of fixtures) {
    const id = `slope-${family}-${scenario}`;
    if (manifest.tests.some(test => test.id === id)) continue;
    const compact = encodeCompactTest({
      id, name, description, input: 'up', world,
      folderId: group, tagIds: [`${group}-${section}`], locked: false, hidden: false,
      start: { voxels: start },
      intermediate: expected.slice(0, -1).map(voxels => ({ voxels })),
      expected: { voxels: expected.at(-1) },
    });
    await writeFile(new URL(`tests/${id}.json`, directory), JSON.stringify(compact) + '\n');
    manifest.tests.push({ id, name, groupTagId: compact.groupTagId, tagIds: compact.tagIds, file: `${id}.json` });
    added++;
  }
}
await writeFile(new URL('project.json', directory), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Added ${added} sloped-entity cases; existing cases were left intact.`);
