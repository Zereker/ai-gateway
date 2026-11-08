import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import worker from '../src/index.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!crypto.subtle.timingSafeEqual) crypto.subtle.timingSafeEqual = timingSafeEqual;

const encryptionKey = webcrypto.getRandomValues(new Uint8Array(32));
const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');
async function encrypt(secret, providerName) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', encryptionKey, 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv,
    additionalData: new TextEncoder().encode(`ai-gateway:provider:${providerName}:v1`),
  }, key, new TextEncoder().encode(secret));
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

const records = {
  anthropic: { name: 'anthropic', protocol: 'anthropic-messages', base_url: 'https://api.anthropic.com', auth_type: 'x-api-key', encrypted_api_key: await encrypt('anthropic-secret', 'anthropic'), enabled: 1 },
  'openai-chat': { name: 'openai-chat', protocol: 'openai-chat-completions', base_url: 'https://api.openai.com', auth_type: 'bearer', encrypted_api_key: await encrypt('openai-chat-secret', 'openai-chat'), enabled: 1 },
  'openai-responses': { name: 'openai-responses', protocol: 'openai-responses', base_url: 'https://api.openai.com', auth_type: 'bearer', encrypted_api_key: await encrypt('openai-response-secret', 'openai-responses'), enabled: 1 },
  gemini: { name: 'gemini', protocol: 'gemini', base_url: 'https://generativelanguage.googleapis.com', auth_type: 'x-goog-api-key', encrypted_api_key: await encrypt('gemini-secret', 'gemini'), enabled: 1 },
};
const env = {
  PROXY_TOKEN: 'gateway-secret',
  CONFIG_ENCRYPTION_KEY: toBase64(encryptionKey),
  DB: { prepare() { return { bind(name) { return { first: async () => records[name] ?? null }; } }; } },
};
function request(path, { method = 'POST', headers = {}, body = '{}' } = {}) {
  return new Request(`https://gateway.example${path}`, {
    method,
    headers: { authorization: 'Bearer gateway-secret', 'content-type': 'application/json', ...headers },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
  });
}

test('authenticates gateway clients and rejects unknown routes/providers', async () => {
  assert.equal((await worker.fetch(request('/anthropic/v1/messages', { headers: { authorization: 'Bearer wrong' } }), env)).status, 401);
  assert.equal((await worker.fetch(request('/arbitrary/path'), env)).status, 404);
  assert.equal((await worker.fetch(request('/anthropic/v1/messages', { method: 'GET' }), env)).headers.get('allow'), 'POST');
  assert.equal((await worker.fetch(request('/anthropic/v1/messages'), { ...env, DB: null })).status, 503);
});

test('routes all supported protocols, installs upstream credentials and preserves response streams', async () => {
  const cases = [
    ['/anthropic/v1/messages', 'https://api.anthropic.com/v1/messages', 'x-api-key', 'anthropic-secret'],
    ['/openai/v1/chat/completions', 'https://api.openai.com/v1/chat/completions', 'authorization', 'Bearer openai-chat-secret'],
    ['/openai/v1/responses', 'https://api.openai.com/v1/responses', 'authorization', 'Bearer openai-response-secret'],
    ['/gemini/v1beta/models/gemini-2.5-pro:generateContent?alt=sse', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?alt=sse', 'x-goog-api-key', 'gemini-secret'],
  ];
  const calls = [];
  const stub = mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('streamed')); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    for (const [path, expectedUrl, authName, authValue] of cases) {
      const response = await worker.fetch(request(path, { headers: { 'x-custom': 'keep', connection: 'x-hop', 'x-hop': 'drop' } }), env);
      assert.equal(calls.at(-1).url, expectedUrl);
      assert.equal(await response.text(), 'streamed');
      assert.equal(calls.at(-1).init.headers.get('x-custom'), 'keep');
      assert.equal(calls.at(-1).init.headers.has('connection'), false);
      assert.equal(calls.at(-1).init.headers.has('x-hop'), false);
      if (authName) assert.equal(calls.at(-1).init.headers.get(authName), authValue);
      assert.equal(calls.at(-1).init.redirect, 'manual');
    }
  } finally { stub.mock.restore(); }
});

test('binds encrypted provider credentials to their database record', async () => {
  const original = records.gemini.encrypted_api_key;
  records.gemini.encrypted_api_key = records.anthropic.encrypted_api_key;
  try {
    const response = await worker.fetch(request('/gemini/v1beta/models/gemini-2.5-pro:generateContent'), env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { message: 'Provider credentials could not be read' } });
  } finally { records.gemini.encrypted_api_key = original; }
});

test('rejects invalid provider endpoints and hides upstream failures', async () => {
  records.anthropic.base_url = 'http://127.0.0.1';
  const invalid = await worker.fetch(request('/anthropic/v1/messages'), env);
  assert.equal(invalid.status, 503);
  records.anthropic.base_url = 'https://api.anthropic.com';
  const stub = mock.method(globalThis, 'fetch', async () => { throw new Error('private upstream detail'); });
  try {
    const response = await worker.fetch(request('/anthropic/v1/messages'), env);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: { message: 'Upstream request failed' } });
  } finally { stub.mock.restore(); }
});
