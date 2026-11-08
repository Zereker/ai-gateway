#!/usr/bin/env node
import { webcrypto } from 'node:crypto';

const usage = `Usage:
  CONFIG_ENCRYPTION_KEY=<base64-32-byte-key> node scripts/provider-secret.js encrypt <provider-name>
  CONFIG_ENCRYPTION_KEY=<base64-32-byte-key> node scripts/provider-secret.js add <name> <protocol> <base-url> <auth-type>
  node scripts/provider-secret.js generate-key
  node scripts/provider-secret.js sql <provider> <protocol> <base-url> <auth-type> <encrypted-key>

The encrypt command prints AES-256-GCM ciphertext as base64(iv).base64(ciphertext).
`;

const [command, ...args] = process.argv.slice(2);
const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');
const protocols = new Set(['anthropic-messages', 'openai-chat-completions', 'openai-responses', 'gemini']);
const authTypes = new Set(['bearer', 'x-api-key', 'x-goog-api-key']);

async function readSecret() {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { value += chunk; });
    process.stdin.on('end', () => resolve(value.replace(/\r?\n$/, '')));
    process.stdin.on('error', reject);
  });
}

async function encryptSecret(secret, providerName, encodedKey) {
  const keyBytes = Buffer.from(encodedKey, 'base64');
  if (keyBytes.length !== 32) throw new Error('CONFIG_ENCRYPTION_KEY must decode to exactly 32 bytes');
  const key = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await webcrypto.subtle.encrypt({
    name: 'AES-GCM', iv,
    additionalData: new TextEncoder().encode(`ai-gateway:provider:${providerName}:v1`),
  }, key, new TextEncoder().encode(secret));
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

function createSql(name, protocol, baseUrl, authType, encryptedKey) {
  const values = [name, protocol, baseUrl, authType, encryptedKey];
  return `INSERT INTO providers (name, protocol, base_url, auth_type, encrypted_api_key) VALUES (${values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ')}) ON CONFLICT(name) DO UPDATE SET protocol = excluded.protocol, base_url = excluded.base_url, auth_type = excluded.auth_type, encrypted_api_key = excluded.encrypted_api_key, enabled = 1, updated_at = CURRENT_TIMESTAMP;`;
}

if (command === 'generate-key') {
  console.log(toBase64(webcrypto.getRandomValues(new Uint8Array(32))));
} else if (command === 'encrypt') {
  const [providerName] = args;
  const secret = await readSecret();
  const encodedKey = process.env.CONFIG_ENCRYPTION_KEY;
  if (!secret || !encodedKey || !providerName) {
    console.error('Provide a provider name, pipe the API key to stdin, and set CONFIG_ENCRYPTION_KEY.');
    process.exitCode = 2;
  } else {
    console.log(await encryptSecret(secret, providerName, encodedKey));
  }
} else if (command === 'add') {
  const [name, protocol, baseUrl, authType] = args;
  const secret = await readSecret();
  const encodedKey = process.env.CONFIG_ENCRYPTION_KEY;
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch {}
  if (!name || !protocols.has(protocol) || !endpoint || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !authTypes.has(authType) || !secret || !encodedKey) {
    console.error('Invalid provider details, missing API key on stdin, or missing CONFIG_ENCRYPTION_KEY.');
    process.exitCode = 2;
  } else {
    const encryptedKey = await encryptSecret(secret, name, encodedKey);
    console.log(createSql(name, protocol, baseUrl, authType, encryptedKey));
  }
} else if (command === 'sql') {
  const [name, protocol, baseUrl, authType, encryptedKey] = args;
  if (![name, protocol, baseUrl, authType, encryptedKey].every(Boolean) || !protocols.has(protocol) || !authTypes.has(authType)) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    console.log(createSql(name, protocol, baseUrl, authType, encryptedKey));
  }
} else {
  console.error(usage);
  process.exitCode = 2;
}
