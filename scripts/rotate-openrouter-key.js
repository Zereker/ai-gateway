#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const helper = path.join(root, 'scripts/provider-secret.js');
const config = fs.existsSync(path.join(root, 'wrangler.local.jsonc'))
  ? 'wrangler.local.jsonc'
  : 'wrangler.jsonc';

function readLocalVars() {
  const vars = {};
  const file = path.join(root, '.dev.vars');
  if (!fs.existsSync(file)) return vars;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) vars[line.slice(0, i)] = line.slice(i + 1);
  }
  return vars;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error('The provider key rotation command failed. Secret values were not printed.');
  }
  return result.stdout;
}

function executeD1(sql) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-rotate-'));
  const file = path.join(dir, 'providers.sql');
  fs.writeFileSync(file, sql, { mode: 0o600 });
  try {
    run(path.join(root, 'node_modules/.bin/wrangler'), [
      'd1', 'execute', 'DB', '--remote', '--config', config, '--file', file, '--json',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function readApiKey() {
  let value = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) value += chunk;
  return value.replace(/\r?\n$/, '');
}

if (!process.argv.includes('--apply')) {
  console.error('Usage: read -s OPENROUTER_API_KEY; printf \'%s\' "$OPENROUTER_API_KEY" | npm run provider:rotate -- --apply');
  process.exit(2);
}

const apiKey = await readApiKey();
const configKey = process.env.CONFIG_ENCRYPTION_KEY || readLocalVars().CONFIG_ENCRYPTION_KEY;
if (!/^sk-or-v1-[A-Za-z0-9]+$/.test(apiKey)) throw new Error('Expected an OpenRouter key on stdin.');
if (!configKey || Buffer.from(configKey, 'base64').length !== 32) {
  throw new Error('A valid CONFIG_ENCRYPTION_KEY is required in the environment or ignored .dev.vars.');
}

const rowsJson = run(path.join(root, 'node_modules/.bin/wrangler'), [
  'd1', 'execute', 'DB', '--remote', '--config', config,
  '--command', 'SELECT name, protocol, base_url, auth_type FROM providers ORDER BY name;', '--json',
]);
const results = JSON.parse(rowsJson);
const rows = (Array.isArray(results) ? results : [results]).flatMap((result) => result.results || []);
const providers = rows.filter((row) => row.base_url === 'https://openrouter.ai/api');
if (!providers.length || providers.some((row) => row.auth_type !== 'bearer')) {
  throw new Error('No OpenRouter Bearer providers found, or an OpenRouter provider uses a different auth type.');
}

const statements = [];
for (const provider of providers) {
  const sql = run(process.execPath, [helper, 'add', provider.name, provider.protocol, provider.base_url, provider.auth_type], {
    input: apiKey,
    env: { ...process.env, CONFIG_ENCRYPTION_KEY: configKey },
  });
  statements.push(sql.trim());
}
executeD1(`${statements.join('\n')}\n`);
console.log(JSON.stringify({ updatedProviders: providers.map((provider) => provider.name), apiKeyPrinted: false }));
