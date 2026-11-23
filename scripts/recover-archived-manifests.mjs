import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { manifestDigest, recoverPriorManifest } from '../benchmarking/manifest-recovery.mjs';

const [auditFile, planFile, destination = '.mazebench/recovered-manifests'] = process.argv.slice(2);
if (!auditFile || !planFile) throw new Error('Usage: <catalogue.json> <successor-plan.json> [archive destination]');
const audit = JSON.parse(await readFile(auditFile));
const planBytes = await readFile(planFile), plan = JSON.parse(planBytes);
for (const run of audit.runs) for (const target of run.unresolved_manifest_hashes || []) {
  const source = path.join(run.directory, 'repairs/incremental-storage-v1/dashboard-snapshot/integrity.json');
  const sourceBytes = await readFile(source);
  const metadata = JSON.parse(await readFile(path.join(run.directory, 'run.json')));
  // Target must occur in the original run's recorded audit history, not just the report.
  if (!JSON.stringify(metadata).includes(`"${target}"`)) throw new Error('Target is not recorded by the run.');
  const sibling = JSON.parse(await readFile(path.join(path.dirname(source), 'run.json')));
  if (manifestDigest(sourceBytes) !== sibling.integrity?.manifest_sha256) throw new Error('Successor backup is not verified.');
  const recovered = recoverPriorManifest(sourceBytes, plan, target);
  const folder = path.resolve(destination, run.id, target);
  if (folder.startsWith(path.resolve(run.directory) + path.sep)) throw new Error('Recovery must be outside the original run.');
  await mkdir(folder, { recursive: true });
  try { await writeFile(path.join(folder, 'integrity.json'), recovered, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST' || manifestDigest(await readFile(path.join(folder, 'integrity.json'))) !== target) throw error; }
  const receipt = { schema_version: 1, run: run.id, manifest_sha256: target,
    method: 'Reverse recorded successor plan; exact original SHA-256 match',
    source: { file: source, sha256: manifestDigest(sourceBytes) },
    plan: { file: path.resolve(planFile), sha256: manifestDigest(planBytes) } };
  await writeFile(path.join(folder, 'recovery.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(`${run.id}: recovered ${target}`);
}
