const encoder = new TextEncoder();
const providerCacheByDatabase = new WeakMap();
const PROVIDER_CACHE_TTL_MS = 60_000;

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

class GatewayAuthenticator {
  async authenticate(request, expectedToken) {
    if (!expectedToken) throw new HttpError(503, 'Proxy is not configured');
    const token = /^Bearer (.+)$/i.exec(request.headers.get('authorization') || '')?.[1];
    if (!token || !(await this.#matches(token, expectedToken))) throw new HttpError(401, 'Unauthorized');
  }

  async #matches(left, right) {
    const [a, b] = await Promise.all([
      crypto.subtle.digest('SHA-256', encoder.encode(left)),
      crypto.subtle.digest('SHA-256', encoder.encode(right)),
    ]);
    return crypto.subtle.timingSafeEqual(a, b);
  }
}

class ProviderRepository {
  constructor(database, encryptionKey) {
    this.database = database;
    this.encryptionKey = encryptionKey;
  }

  async get(name) {
    if (!this.database || !this.encryptionKey) throw new HttpError(503, 'Provider store is not configured');

    let cache = providerCacheByDatabase.get(this.database);
    if (!cache) {
      cache = new Map();
      providerCacheByDatabase.set(this.database, cache);
    }

    const cached = cache.get(name);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;

    const entry = { expiresAt: Number.POSITIVE_INFINITY, promise: null };
    entry.promise = this.#load(name)
      .then((provider) => {
        entry.expiresAt = Date.now() + PROVIDER_CACHE_TTL_MS;
        return provider;
      })
      .catch((error) => {
        if (cache.get(name) === entry) cache.delete(name);
        throw error;
      });
    cache.set(name, entry);
    return entry.promise;
  }

  async #load(name) {
    const row = await this.database.prepare(
      'SELECT name, protocol, base_url, auth_type, encrypted_api_key, enabled FROM providers WHERE name = ? AND enabled = 1',
    ).bind(name).first();
    if (!row) throw new HttpError(404, 'Provider not found');
    return { ...row, apiKey: await this.#decrypt(row.encrypted_api_key, row.name) };
  }

  async #decrypt(value, providerName) {
    try {
      const [version, ivPart, dataPart, extra] = value.split('.');
      if (version !== 'v1' || !ivPart || !dataPart || extra) throw new Error('Malformed ciphertext');
      const decode = (part) => Uint8Array.from(atob(part), (char) => char.charCodeAt(0));
      const iv = decode(ivPart);
      const ciphertext = decode(dataPart);
      const rawKey = decode(this.encryptionKey);
      if (iv.byteLength !== 12 || rawKey.byteLength !== 32) throw new Error('Invalid key material');
      const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
      const plaintext = await crypto.subtle.decrypt({
        name: 'AES-GCM', iv, additionalData: encoder.encode(`ai-gateway:provider:${providerName}:v1`),
      }, key, ciphertext);
      return new TextDecoder().decode(plaintext);
    } catch {
      throw new HttpError(503, 'Provider credentials could not be read');
    }
  }
}

class ProviderRegistry {
  constructor() {
    this.providers = new Map([
      ['anthropic', { protocol: 'anthropic-messages', path: /^\/anthropic\/v1\/messages$/ }],
      ['openai-chat', { protocol: 'openai-chat-completions', path: /^\/openai\/(v1\/chat\/completions)$/ }],
      ['openai-responses', { protocol: 'openai-responses', path: /^\/openai\/(v1\/responses)$/ }],
      ['gemini', { protocol: 'gemini', path: /^\/gemini\/(v1beta\/models\/[^/:]+:(?:generateContent|streamGenerateContent))$/ }],
    ]);
  }

  resolve(pathname) {
    for (const [name, route] of this.providers) {
      const match = pathname.match(route.path);
      if (match) return { name, ...route, suffix: match[1] || pathname.slice(`/${name}`.length) };
    }
    throw new HttpError(404, 'Not found');
  }
}

class UpstreamRequestFactory {
  create(request, provider, route) {
    if (provider.protocol !== route.protocol) throw new HttpError(400, 'Provider protocol does not match route');
    let base;
    try {
      base = new URL(provider.base_url);
    } catch {
      throw new HttpError(503, 'Provider endpoint is invalid');
    }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
      throw new HttpError(503, 'Provider endpoint is invalid');
    }
    const upstreamUrl = new URL(base);
    upstreamUrl.pathname = `${base.pathname.replace(/\/$/, '')}/${route.suffix.replace(/^\//, '')}`.replace(/\/+/g, '/');
    upstreamUrl.search = new URL(request.url).search;

    const headers = new Headers(request.headers);
    const connectionTokens = (headers.get('connection') || '').split(',').map((item) => item.trim().toLowerCase());
    for (const name of ['connection', 'host', 'content-length', 'transfer-encoding', 'upgrade', ...connectionTokens]) {
      if (name) headers.delete(name);
    }
    if (provider.auth_type === 'bearer') {
      headers.set('authorization', `Bearer ${provider.apiKey}`);
    } else if (provider.auth_type === 'x-api-key') {
      headers.delete('authorization');
      headers.set('x-api-key', provider.apiKey);
    } else if (provider.auth_type === 'x-goog-api-key') {
      headers.delete('authorization');
      headers.set('x-goog-api-key', provider.apiKey);
    } else {
      throw new HttpError(503, 'Provider authentication type is unsupported');
    }
    return { url: upstreamUrl, init: { method: request.method, headers, body: request.body, redirect: 'manual' } };
  }
}

class ProxyService {
  constructor(env) {
    this.env = env;
    this.authenticator = new GatewayAuthenticator();
    this.providers = new ProviderRegistry();
    this.repository = new ProviderRepository(env.DB, env.CONFIG_ENCRYPTION_KEY);
    this.requestFactory = new UpstreamRequestFactory();
  }

  async fetch(request) {
    await this.authenticator.authenticate(request, this.env.PROXY_TOKEN);
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed', { allow: 'POST' });
    const route = this.providers.resolve(new URL(request.url).pathname);
    const provider = await this.repository.get(route.name);
    const { url, init } = this.requestFactory.create(request, provider, route);
    return fetch(url, init);
  }
}

export default {
  async fetch(request, env) {
    try {
      return await new ProxyService(env).fetch(request);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      const message = error instanceof HttpError ? error.message : 'Upstream request failed';
      const headers = { 'cache-control': 'no-store', ...(error instanceof HttpError ? error.headers : {}) };
      return Response.json({ error: { message } }, { status, headers });
    }
  },
};
