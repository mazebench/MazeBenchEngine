import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readProjectDirectory } from "./lib/project-store.mjs";
import { auditContradictions, describeTest, immutableTestFingerprint } from "./lib/test-audit.mjs";

const project = await readProjectDirectory(new URL("../project-data", import.meta.url));
const manifestPath = "project-data/project.json";
const manifestText = await readFile(new URL(`../${manifestPath}`, import.meta.url), "utf8");
const manifest = JSON.parse(manifestText);
const names = new Set();
const overrides = {
  "test-132-copy-copy": {
    name: "Eleven-cell player moves north as one rigid body",
    description: "The eleven connected player cells translate north together without changing shape. This scene has no gem; the gem-collection note inherited from the original copied case did not describe these frames.",
  },
  "test-132-copy-copy-copy": {
    name: "Three-cell player moves north without splitting",
    description: "The three-cell player, including its raised cell, moves north as one body. An internal player cell must never be treated as a separate carrier. No gem is present in this scene.",
  },
  "test-132-copy-copy-copy-copy": {
    name: "Three-cell player falls into the void as one rigid body",
    description: "The player moves north, descends for three ticks, then disappears as a whole body on tick five. No gem is present; this copied scene tests rigid-body falling and void removal, not gem collection.",
  },
  "test-517": {
    name: "Tall wide box climbs two slopes, crosses the crest, then falls",
    description: "A two-wide, three-high weightless box meets the uphill face with only one of its bottom cells. The entire rigid box must rise; the other foot on flat Floor cannot veto an upward move. The player advances once and stays behind. Expect two uphill ticks, one level tick beyond the crest, then two downward ticks onto Floor. This guards against making slope behavior depend on a polycube's height or width.",
  },
  "test-518": {
    name: "Player leaves a bridge supported by a stationary four-cell pedestal",
    description: "The player shares support of box 2 with stationary box 0, a four-cell pedestal resting on Floor. Walking north moves only the player. Both boxes must remain in place. Pedestal support must behave the same for one cube and for a larger polycube; unlike an interlocking clasp, this pedestal is independently supported and does not rest on the bridge.",
  },
};
const records = project.tests.map((t, index) => {
  const facts = describeTest(t, project);
  const placeholder = /untitled|\bcopy\b/i.test(t.name);
  let name = overrides[t.id]?.name ?? (placeholder ? facts.generatedTitle : t.name.trim());
  if (names.has(name)) name += ` [case ${index + 1}]`;
  names.add(name);
  const authorText = overrides[t.id]?.description ?? (t.description.startsWith("One Up command in ") ? "" : t.description.split("\n\nOne Up command in ")[0].trim());
  const description = authorText ? `${authorText}\n\n${facts.description}` : facts.description;
  const updated = { ...t, name, description };
  assert.equal(immutableTestFingerprint(t), immutableTestFingerprint(updated));
  return { id: t.id, previousName: t.name, name, description, ticks: facts.frames - 1, group: t.folderId, hidden: !!t.hidden };
});

if (!process.argv.includes("--patch")) {
  console.log(JSON.stringify({ tests: records.length, audit: auditContradictions(project), samples: records.filter((_, i) => i % 35 === 0 || i > records.length - 3) }, null, 2));
} else {
  // Emit a patch rather than directly rewriting files. Only name/description
  // fields change; palettes, delta frames, IDs, and all other metadata remain
  // byte-for-byte equal as JSON values. No store cleanup/deletion is invoked.
  const lines = (s, prefix) => s.trimEnd().split("\n").map(l => prefix + l).join("\n");
  let patch = "*** Begin Patch\n";
  const from = Number(process.argv.find(a => a.startsWith("--from="))?.split("=")[1] ?? 0);
  const limit = Number(process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] ?? records.length);
  for (const [i, record] of records.entries()) {
    const entry = manifest.tests.find(t => t.id === record.id);
    entry.name = record.name;
    if (process.argv.includes("--catalogue-only") || process.argv.includes("--manifest-only") || i < from || i >= from + limit) continue;
    const path = `project-data/tests/${entry.file}`;
    const before = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    const compact = JSON.parse(before);
    const { name, description, ...unchanged } = compact;
    compact.name = record.name;
    compact.description = record.description;
    const { name: nextName, description: nextDescription, ...after } = compact;
    assert.deepEqual(after, unchanged);
    patch += `*** Update File: ${path}\n@@\n${lines(before, "-")}\n+${JSON.stringify(compact)}\n`;
  }
  if (!process.argv.includes("--only-tests") && !process.argv.includes("--catalogue-only")) {
    const originalManifest = JSON.parse(manifestText);
    const changed = manifest.tests.filter((entry, i) => entry.name !== originalManifest.tests[i].name);
    if (changed.length) {
      patch += `*** Update File: ${manifestPath}\n`;
      for (const entry of changed) {
        const original = originalManifest.tests.find(t => t.id === entry.id);
        patch += `@@\n       "id": ${JSON.stringify(entry.id)},\n-      "name": ${JSON.stringify(original.name)},\n+      "name": ${JSON.stringify(entry.name)},\n`;
      }
    }
  }
  const catalogue = ["# Authored test catalogue", "", "Every original ID and authored frame is preserved. Titles and descriptions summarize the authored expectation, independently of engine output.", "", "The previous title is retained here so existing references remain searchable.", ""];
  for (const tag of project.tags.filter(t => !t.parentId)) {
    catalogue.push(`## ${tag.name}`, "", "| Test | Title | Previous title | Ticks |", "| --- | --- | --- | ---: |");
    for (const r of records.filter(r => r.group === tag.id)) catalogue.push(`| [${r.id}](../project-data/tests/${manifest.tests.find(t => t.id === r.id).file})${r.hidden ? " (hidden)" : ""} | ${r.name.replaceAll("|", "\\|")} | ${r.previousName.replaceAll("|", "\\|")} | ${r.ticks} |`);
    catalogue.push("");
  }
  if (!process.argv.includes("--only-tests") && !process.argv.includes("--manifest-only")) patch += `*** Add File: docs/TEST_CATALOG.md\n${lines(catalogue.join("\n"), "+")}\n`;
  patch += "*** End Patch\n";
  process.stdout.write(patch);
}
