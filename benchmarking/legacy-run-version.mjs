import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { legacyRunVersion } from './run-version-label.mjs';

export function readLegacyRunVersion(directory) {
  const result = legacyRunVersion();
  try {
    result.source_metadata_sha256 = createHash('sha256').update(readFileSync(path.join(directory, 'run.json'))).digest('hex');
  } catch { /* The source repository determines the generation even without hashes. */ }
  return result;
}
