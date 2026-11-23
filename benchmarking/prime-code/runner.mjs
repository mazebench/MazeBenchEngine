import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { evaluatorEnvironment } from './policy.mjs';

export async function runPrime({ root, directory, home, python, control, onEvent }) {
  const env = await evaluatorEnvironment(root, home);
  if (control.stopRequested) return { code: 0, complete: false };
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(root, 'benchmarking/prime-code/agent_runner.py'), path.join(home, 'runner.json')],
      { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    control.child = child;
    const errors = createWriteStream(path.join(home, 'stderr.log'), { flags: 'a', mode: 0o600 });
    const feed = createWriteStream(path.join(directory, 'agent-events.jsonl'), { flags: 'a', mode: 0o600 });
    child.stderr.pipe(errors);
    let persistence = Promise.resolve(), complete = false, error = null;
    const integrityMonitor = setInterval(() => {
      if (existsSync(path.join(directory, 'integrity-violation.json'))) child.kill('SIGINT');
    }, 1000);
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { return; } // framework progress belongs in the private log
      if (event.type === 'item') feed.write(JSON.stringify({ type: 'item.completed', item: event.item, _received_at: new Date().toISOString() }) + '\n');
      if (event.type === 'request_usage') feed.write(JSON.stringify({ ...event, _received_at: new Date().toISOString() }) + '\n');
      if (event.type === 'usage') feed.write(JSON.stringify({ type: 'turn.completed', usage: event.usage, _received_at: new Date().toISOString() }) + '\n');
      if (event.type === 'complete') {
        complete = true;
        persistence = persistence.then(() => writeFile(path.join(directory, 'last-message.txt'), event.message || '', { mode: 0o600 }));
      }
      if (event.type === 'failed') error = event.error;
      persistence = persistence.then(() => onEvent(event));
      // Observe failures immediately while still allowing graceful VM cleanup.
      persistence.catch(() => child.kill('SIGINT'));
    });
    child.once('error', error => { clearInterval(integrityMonitor); reject(error); });
    child.once('close', async code => {
      clearInterval(integrityMonitor);
      control.child = null;
      await Promise.all([errors, feed].map(stream => new Promise(done => stream.end(done))));
      try { await persistence; resolve({ code, complete, error }); } catch (error) { reject(error); }
    });
  });
}
