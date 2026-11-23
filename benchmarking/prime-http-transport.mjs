import { Agent, fetch as undiciFetch } from 'undici';

// Prime's non-streaming reasoning responses may take longer than Node's
// default 300-second headers timeout. Let the signed runner's own 20-minute
// AbortSignal govern delivery. This changes no model request parameters.
export const PRIME_HTTP_TIMEOUT = 25 * 60 * 1000;
export const PRIME_COMPLETIONS_URL = 'https://api.pinference.ai/api/v1/chat/completions';
let installed = false;
export function createPrimeFetch({ fallback, send = undiciFetch, dispatcher }) {
  return (input, options) => {
    if (String(input) !== PRIME_COMPLETIONS_URL || options?.method !== 'POST') return fallback(input, options);
    return send(input, { ...options, dispatcher });
  };
}
export function installPrimeHttpTransport() {
  if (installed) return;
  const dispatcher = new Agent({ headersTimeout: PRIME_HTTP_TIMEOUT, bodyTimeout: PRIME_HTTP_TIMEOUT, connect: { timeout: 30000 } });
  globalThis.fetch = createPrimeFetch({ fallback: globalThis.fetch.bind(globalThis), dispatcher });
  installed = true;
}
