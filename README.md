# AI Gateway

Cloudflare Worker proxy with path-based provider selection. It forwards requests in their native protocol; it does not convert request or response formats.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FZereker%2Fai-gateway)

| Worker path | Provider record | Protocol |
| --- | --- | --- |
| `/anthropic/v1/messages` | `anthropic` | Anthropic Messages |
| `/openai/v1/chat/completions` | `openai-chat` | OpenAI Chat Completions |
| `/openai/v1/responses` | `openai-responses` | OpenAI Responses |
| `/gemini/v1beta/models/{model}:generateContent` | `gemini` | Gemini generateContent |
| `/gemini/v1beta/models/{model}:streamGenerateContent` | `gemini` | Gemini streaming |

Every request uses `Authorization: Bearer <PROXY_TOKEN>`. Provider credentials are encrypted with AES-GCM before insertion into D1. The 32-byte encryption key and gateway token are Worker Secrets; neither belongs in the database. Provider base URLs must use HTTPS and are stored in D1. The Worker never accepts an upstream host from the request. Decrypted provider settings are cached in each Worker isolate for 60 seconds, so ordinary requests do not query D1 every time; configuration edits take up to one minute to appear, and cold isolates load from D1.

## Deploy with Cloudflare

Click **Deploy to Cloudflare** above. Cloudflare will create a copy of this repository in your GitHub account, provision the D1 database, run the configured deployment command (including the schema migration), and deploy the Worker. Enter values for both secrets when prompted:

- `PROXY_TOKEN`: a random gateway token used by clients.
- `CONFIG_ENCRYPTION_KEY`: a separate random 32-byte base64 key used to encrypt provider API keys.

Generate a key with `npm run provider:secret -- generate-key`. Keep the encryption key in a password manager; losing it makes stored provider credentials unrecoverable.

## Add provider credentials

After deployment, clone your Cloudflare-created repository and install dependencies:

```sh
npm ci
```

Use the same `CONFIG_ENCRYPTION_KEY` value entered during deployment. Create an encrypted provider upsert statement; the API key is read from stdin and never printed:

```sh
read -s CONFIG_ENCRYPTION_KEY
export CONFIG_ENCRYPTION_KEY
read -s UPSTREAM_API_KEY
printf '%s' "$UPSTREAM_API_KEY" | npm run provider:secret -- add anthropic anthropic-messages https://api.anthropic.com x-api-key > provider.sql
unset CONFIG_ENCRYPTION_KEY UPSTREAM_API_KEY
npx wrangler d1 execute DB --remote --file ./provider.sql
rm provider.sql
```

Repeat with these provider values as needed:

| Name | Protocol | Base URL | Auth type |
| --- | --- | --- | --- |
| `anthropic` | `anthropic-messages` | `https://api.anthropic.com` | `x-api-key` |
| `openai-chat` | `openai-chat-completions` | `https://api.openai.com` | `bearer` |
| `openai-responses` | `openai-responses` | `https://api.openai.com` | `bearer` |
| `gemini` | `gemini` | `https://generativelanguage.googleapis.com` | `x-goog-api-key` |

The upsert operation lets you rotate keys or update provider configuration. Gemini streaming requests can include `alt=sse`; its key is sent in the `x-goog-api-key` header.

## Rotate the OpenRouter key

The script updates every provider record using `https://openrouter.ai/api` and Bearer authentication. It reads the current `CONFIG_ENCRYPTION_KEY` from ignored `.dev.vars` and the new OpenRouter key from stdin; the key is stored encrypted in D1.

```sh
read -s OPENROUTER_API_KEY
printf '%s' "$OPENROUTER_API_KEY" | npm run provider:rotate -- --apply
unset OPENROUTER_API_KEY
```

## Use the gateway

Send an Anthropic Messages request to `https://<worker-domain>/anthropic/v1/messages` with `Authorization: Bearer <PROXY_TOKEN>` and `anthropic-version: 2023-06-01`. OpenAI-compatible clients use the `/openai` path prefix; Gemini clients use `/gemini`. Request bodies remain in each provider's native format.

## Personal local deployment

Keep account-specific settings such as your custom domain and D1 database ID in the ignored `wrangler.local.jsonc`. The tracked `wrangler.jsonc` remains the generic Cloudflare deployment config. Do not store secret values in either file. Apply migrations and deploy your personal Worker with:

```sh
npx wrangler d1 migrations apply DB --remote --config wrangler.local.jsonc
npx wrangler deploy --config wrangler.local.jsonc
```

## Verify a deployed Worker

After deployment, run the end-to-end smoke test. It checks gateway authentication and method handling, then sends short non-streaming and streaming requests through all four protocol routes. It needs `curl`, `jq`, and `PROXY_TOKEN` in ignored `.dev.vars` (or the environment). The default OpenRouter model is `nvidia/nemotron-3-ultra-550b-a55b:free`; free endpoints can still be rate limited.

```sh
./scripts/verify-deployment.sh
```

Set `WORKER_URL` to check another deployment. Override models with `VERIFY_MODEL`, `VERIFY_ANTHROPIC_MODEL`, `VERIFY_OPENAI_CHAT_MODEL`, `VERIFY_OPENAI_RESPONSES_MODEL`, and `VERIFY_GEMINI_MODEL`. Gemini uses its native Google protocol and therefore needs an enabled `gemini` provider configured in D1; a free OpenRouter model alone does not configure that provider.

## Development

Use Node.js 22 or newer.

```sh
npm ci
npm test
npm run build
```

Protect the gateway token: anyone holding it can spend against every configured provider. See [SECURITY.md](SECURITY.md) for reporting security issues.
