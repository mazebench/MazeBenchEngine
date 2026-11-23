import { createHash } from 'node:crypto';

export const manifestDigest = bytes => createHash('sha256').update(bytes).digest('hex');

// Reconstruct archived bytes only. Never reseal or write an executing run.
export function recoverPriorManifest(bytes, plan, expectedHash) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('A recorded target hash is required.');
  const manifest = JSON.parse(bytes);
  const inventories = [manifest.files, ...Object.entries(manifest.configuration || {})
    .filter(([key, value]) => key.endsWith('_runtime') && value && typeof value === 'object').map(([, value]) => value)];
  for (const files of inventories) {
    if (!files || typeof files !== 'object') throw new Error('Missing manifest inventory.');
    for (const [file, change] of Object.entries(plan.files || {})) if (Object.hasOwn(files, file)) {
      if (files[file] !== change.after) throw new Error(`Unexpected successor hash: ${file}`);
      if (change.before === null) delete files[file];
      else if (/^[a-f0-9]{64}$/.test(change.before)) files[file] = change.before;
      else throw new Error(`Invalid predecessor hash: ${file}`);
    }
  }
  const recovered = Buffer.from(JSON.stringify(manifest) + '\n');
  if (manifestDigest(recovered) !== expectedHash) throw new Error('Reconstruction does not match the recorded manifest hash.');
  return recovered;
}
