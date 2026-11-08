import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';

test('provider-secret encrypt output matches the Worker AES-GCM envelope', async () => {
  const keyBytes = webcrypto.getRandomValues(new Uint8Array(32));
  const encodedKey = Buffer.from(keyBytes).toString('base64');
  const encrypted = spawnSync(process.execPath, ['scripts/provider-secret.js', 'encrypt', 'anthropic'], {
    input: 'sample-upstream-key',
    encoding: 'utf8',
    env: { ...process.env, CONFIG_ENCRYPTION_KEY: encodedKey },
  });
  assert.equal(encrypted.status, 0, encrypted.stderr);
  const [version, ivPart, ciphertextPart] = encrypted.stdout.trim().split('.');
  assert.equal(version, 'v1');
  const rawKey = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const plaintext = await webcrypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: Buffer.from(ivPart, 'base64'),
    additionalData: new TextEncoder().encode('ai-gateway:provider:anthropic:v1'),
  }, rawKey, Buffer.from(ciphertextPart, 'base64'));
  assert.equal(new TextDecoder().decode(plaintext), 'sample-upstream-key');
});

test('provider-secret generates a 32-byte base64 encryption key', () => {
  const result = spawnSync(process.execPath, ['scripts/provider-secret.js', 'generate-key'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Buffer.from(result.stdout.trim(), 'base64').length, 32);
});

test('provider-secret add creates a safe SQL seed with encrypted credentials', async () => {
  const keyBytes = webcrypto.getRandomValues(new Uint8Array(32));
  const encodedKey = Buffer.from(keyBytes).toString('base64');
  const result = spawnSync(process.execPath, [
    'scripts/provider-secret.js', 'add', 'anthropic', 'anthropic-messages',
    'https://api.anthropic.com', 'x-api-key',
  ], { input: "secret-key'with-quote", encoding: 'utf8', env: { ...process.env, CONFIG_ENCRYPTION_KEY: encodedKey } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /VALUES \('anthropic', 'anthropic-messages', 'https:\/\/api\.anthropic\.com', 'x-api-key', 'v1\./);
  assert.doesNotMatch(result.stdout, /secret-key/);
  const ciphertext = /'(v1\.[^']+)'/.exec(result.stdout)?.[1];
  assert.ok(ciphertext);
  const [, ivPart, dataPart] = ciphertext.split('.');
  const importedKey = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const plaintext = await webcrypto.subtle.decrypt({
    name: 'AES-GCM', iv: Buffer.from(ivPart, 'base64'),
    additionalData: new TextEncoder().encode('ai-gateway:provider:anthropic:v1'),
  }, importedKey, Buffer.from(dataPart, 'base64'));
  assert.equal(new TextDecoder().decode(plaintext), "secret-key'with-quote");
});
