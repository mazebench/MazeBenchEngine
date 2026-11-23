// Protocol compatibility only: Grok owns the prompt, agent loop, tools, and
// conversation. The public ChatGPT token-sharing endpoint requires developer
// messages and excludes several API-only request options.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { connectionToken } from '../connections/credentials.mjs';

export function chatgptRequest(body, model) {
  if (body.model !== model || !Array.isArray(body.input)) throw new Error('Unexpected model or conversation request.');
  const result = { ...body, store: false, stream: true,
    input: body.input.map(item => item.role === 'system' ? { ...item, role: 'developer' } : item) };
  for (const key of ['max_output_tokens', 'temperature', 'top_p', 'prompt_cache_retention', 'prompt_cache_options']) delete result[key];
  result.include = [...new Set([...(body.include || []), 'reasoning.encrypted_content'])];
  return result;
}

export async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function startChatGPTTransport({ port, connection, model, fetcher = fetch, token = () => connectionToken(connection), onFailure = () => {} }) {
  if (connection.auth !== 'chatgpt' || connection.api !== 'openai-responses' || connection.base_url !== 'https://api.openai.com/v1') throw new Error('ChatGPT transport requires the public Responses endpoint.');
  const secret = randomBytes(32).toString('hex'), expected = Buffer.from('Bearer ' + secret);
  const inflight = new Set();
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || req.headers.origin) { res.writeHead(403); return res.end(); }
    if (req.method === 'GET' && req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: model, object: 'model' }] })); }
    if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404); return res.end(); }
    const controller = new AbortController(); inflight.add(controller);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      let bytes = '', length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 16 * 1024 * 1024) throw new Error('Inference request exceeds the transport limit.'); bytes += chunk; }
      const body = chatgptRequest(JSON.parse(bytes), model);
      const upstream = await fetcher(connection.base_url + '/responses', { method: 'POST', redirect: 'error',
        headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
      if (!upstream.ok) { res.end(await upstream.text()); return; }
      const decoder = new TextDecoder(), output = new Map(); let pending = '', completed = false, failed = null;
      const forward = frame => {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        let event; try { event = JSON.parse(data); } catch { res.write(frame + '\n\n'); return; }
        // Public Responses adds out-of-band account metadata which Grok's
        // versioned SSE enum predates. It is not model text, tools, or usage.
        if (event.type === 'response.metadata') return;
        if (event.type === 'response.output_item.done' && event.item) output.set(event.output_index, event.item);
        if (event.type === 'response.completed') {
          completed = true;
          // Some public plan streams omit output from the terminal envelope.
          // Grok expects it there; replay only the exact completed stream items.
          if (!event.response?.output?.length && output.size) {
            event.response = { ...event.response, output: [...output].sort(([a], [b]) => a - b).map(([, item]) => item) };
            res.write('data: ' + JSON.stringify(event) + '\n\n'); return;
          }
        }
        if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') failed = event.response?.error?.code || event.error?.code || event.type;
        res.write(frame + '\n\n');
      };
      // A plan quota failure is terminal; Grok must not retry it as a 500.
      for await (const chunk of upstream.body) {
        pending += decoder.decode(chunk, { stream: true });
        const frames = pending.split(/\r?\n\r?\n/); pending = frames.pop();
        for (const frame of frames) forward(frame);
        if (failed) break;
      }
      if (pending.trim() && !failed) forward(pending);
      if (failed) onFailure('ChatGPT response failed: ' + String(failed).slice(0,160));
      if (!completed && !failed && !controller.signal.aborted) onFailure('ChatGPT response ended without response.completed.');
      res.end();
    } catch (error) {
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'MazeBench ChatGPT transport failed.' } })); }
      else res.destroy();
      if (!controller.signal.aborted) onFailure('ChatGPT transport could not complete the request.');
    } finally { inflight.delete(controller); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { secret, port: server.address().port, async close() {
    for (const controller of inflight) controller.abort();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}
