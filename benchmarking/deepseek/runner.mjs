import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { finished } from 'node:stream/promises';
import { environment, toolNames } from './policy.mjs';

export function runDeepSeekTurn({ directory, metadata, frozen, prompt, control, onSession }) {
  return new Promise((resolve, reject) => {
    const cwd = realpathSync(path.join(directory, 'agent-cwd'));
    const args = [frozen.deepseek_executable, 'headless', '--json',
      ...(metadata.deepseek_session_id ? ['--session-id', metadata.deepseek_session_id] : []), '-'];
    const child = spawn(process.execPath, args, { cwd, env: environment(frozen.deepseek_home, frozen.model_connection), stdio: ['pipe', 'pipe', 'pipe'] });
    control.child = child;
    const raw = createWriteStream(path.join(directory, 'deepseek-events.jsonl'), { flags: 'a', mode: 0o600 });
    const feed = createWriteStream(path.join(directory, 'agent-events.jsonl'), { flags: 'a', mode: 0o600 });
    const stderr = createWriteStream(path.join(directory, 'agent-stderr.log'), { flags: 'a', mode: 0o600 });
    const turnId = randomUUID(), calls = new Map();
    const allowed = new Set(toolNames(metadata.tools_enabled).map(name => 'mcp__mazebench__' + name));
    let sessionId = metadata.deepseek_session_id, sessionSeen = false, buffer = '', persistence = Promise.resolve(), boundaryError = null;
    let lastActivity = Date.now(), reason, final = false, failure, killTimer;
    const decoder = new StringDecoder('utf8');
    const fail = error => { failure ||= error.message; child.kill('SIGKILL'); };
    const streams = [raw, feed, stderr], closed = streams.map(stream => finished(stream).catch(fail));
    const persist = task => { persistence = persistence.then(task).catch(fail); };
    const item = value => feed.write(JSON.stringify({ type: 'item.completed', item: value, _received_at: new Date().toISOString(), _turn_id: turnId }) + '\n');
    const invalidate = message => {
      boundaryError ||= message;
      writeFileSync(path.join(directory, 'integrity-violation.json'), JSON.stringify({ error: boundaryError, at: new Date().toISOString() }), { mode: 0o600 });
      child.kill('SIGKILL');
    };
    function receive(line) {
      if (!line.trim() || boundaryError) return;
      let event;
      try { event = JSON.parse(line); } catch { invalidate('DeepSeek Harness emitted invalid JSON.'); return; }
      raw.write(JSON.stringify({ ...event, _received_at: new Date().toISOString(), _turn_id: turnId }) + '\n');
      if (event.type === 'session') {
        if (sessionSeen || !/^session-[a-f0-9-]{36}$/.test(event.sessionId) || sessionId && sessionId !== event.sessionId || event.cwd !== cwd) {
          invalidate('DeepSeek Harness changed the session or working directory.'); return;
        }
        sessionSeen = true; sessionId = event.sessionId; control.threadId = sessionId;
        persist(() => onSession(sessionId));
      } else if (!sessionSeen && event.type !== 'error') {
        invalidate('DeepSeek Harness emitted activity before its session identity.'); return;
      }
      if (event.type === 'tool_call') {
        if (!allowed.has(event.tool) || event.truncated) { invalidate('DeepSeek Harness requested an unavailable or truncated tool call.'); return; }
        const call = { type: 'mcp_tool_call', id: event.callId, server: 'mazebench', tool: event.tool.slice('mcp__mazebench__'.length), arguments: event.input };
        calls.set(event.callId, call); item({ ...call, status: 'requested' });
      }
      if (event.type === 'tool_result' && calls.has(event.callId)) item({ ...calls.get(event.callId), status: event.status,
        result: { content: [{ type: 'text', text: event.result || '' }] } });
      if (event.type === 'text' || event.type === 'thinking') item({ type: event.type === 'text' ? 'agent_message' : 'reasoning', text: event.text });
      if (event.type === 'status' && event.phase === 'turn_end') reason = event.reason;
      if (event.type === 'final') {
        final = true;
        persist(() => writeFile(path.join(directory, 'last-message.txt'), event.text || '', { mode: 0o600 }));
      }
      if (event.type === 'error') failure = event.message;
    }
    const monitor = setInterval(() => {
      if (existsSync(path.join(directory, 'integrity-violation.json'))) invalidate('DeepSeek run was invalidated.');
      if (!killTimer && (control.pauseRequested || control.stopRequested || Date.now() - lastActivity > 15 * 60_000)) {
        child.kill('SIGINT'); killTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
      }
    }, 500);
    child.stdout.on('data', chunk => {
      lastActivity = Date.now(); buffer += decoder.write(chunk);
      const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(receive);
      if (buffer.length > 8 * 1024 * 1024) invalidate('DeepSeek event exceeds the stream limit.');
    });
    child.stderr.on('data', chunk => { lastActivity = Date.now(); stderr.write(chunk); });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.once('error', error => { failure = error.message; });
    child.once('close', async (code, signal) => {
      clearInterval(monitor); clearTimeout(killTimer); control.child = null;
      buffer += decoder.end();
      if (buffer.trim()) receive(buffer);
      streams.forEach(stream => stream.end());
      await Promise.all(closed);
      try { await persistence; } catch (error) { reject(error); return; }
      resolve({ code, signal, sessionId, boundaryError, success: !failure && !boundaryError && code === 0 && final && reason?.kind === 'completed',
        error: failure || reason?.message || reason?.error?.message || 'DeepSeek Harness could not complete the turn. See the run’s private agent-stderr.log.' });
    });
  });
}
