# AI Gateway

Cloudflare Worker proxy with path-based provider selection. The first version forwards requests in their native protocol; it does not convert request or response formats.

| Worker path | Provider record | Protocol |
| --- | --- | --- |
| `/anthropic/v1/messages` | `anthropic` | Anthropic Messages |
| `/openai/v1/chat/completions` | `openai-chat` | OpenAI Chat Completions |
| `/openai/v1/responses` | `openai-responses` | OpenAI Responses |
| `/gemini/v1beta/models/{model}:generateContent` | `gemini` | Gemini generateContent |
| `/gemini/v1beta/models/{model}:streamGenerateContent` | `gemini` | Gemini streaming |

Every request uses `Authorization: Bearer <PROXY_TOKEN>`. Provider credentials are encrypted with AES-GCM before insertion into D1. The 32-byte encryption key and gateway token are Wrangler Secrets; neither belongs in the database. Provider base URLs must use HTTPS and are stored in D1. The Worker never accepts an upstream host from the request.

## Setup

Create the D1 database in the same Cloudflare account used by Wrangler:

```sh
npx wrangler d1 create ai-gateway
```

Copy the returned database ID into `wrangler.jsonc`, then initialize the schema:

```sh
npx wrangler d1 migrations apply ai-gateway --remote
```

Generate a random 32-byte encryption key and save it in your password manager:

```sh
npm run provider:secret -- generate-key
```

Set that value as the encryption Worker Secret, along with a separate gateway token. Wrangler prompts for the values interactively:

```sh
npx wrangler secret put PROXY_TOKEN
npx wrangler secret put CONFIG_ENCRYPTION_KEY
```

Use the built-in helper to create a provider seed statement. Enter the same key you saved as the `CONFIG_ENCRYPTION_KEY` Worker Secret, then enter the provider API key at the hidden prompt:

```sh
read -s CONFIG_ENCRYPTION_KEY
export CONFIG_ENCRYPTION_KEY
read -s UPSTREAM_API_KEY
printf '%s' "$UPSTREAM_API_KEY" | npm run provider:secret -- add anthropic anthropic-messages https://api.anthropic.com x-api-key > provider.sql
unset CONFIG_ENCRYPTION_KEY UPSTREAM_API_KEY
```

The helper writes only a SQL statement containing an AES-GCM ciphertext (`v1.base64(iv).base64(ciphertext)`) authenticated to the provider name; the plaintext API key is read from stdin and never printed. Repeat with each provider's settings. Apply the statement using `npx wrangler d1 execute ai-gateway --remote --file ./provider.sql`, then delete the local file. Supported `auth_type` values are `bearer`, `x-api-key`, and `x-goog-api-key`. Seed names, protocols, endpoints, and auth types:

```text
anthropic       anthropic-messages          x-api-key
openai-chat     openai-chat-completions     bearer
openai-responses openai-responses           bearer
gemini          gemini                      x-goog-api-key
```

Set each provider's base URL to its official API origin (or a trusted compatible origin). The worker appends the route suffix from the fixed path table. Gemini's query string is retained, including `alt=sse` for streaming; its API key is sent in the `x-goog-api-key` header.

After configuring the `anthropic` provider, send a normal Anthropic Messages request to `https://<worker-domain>/anthropic/v1/messages` with `Authorization: Bearer <PROXY_TOKEN>` and `anthropic-version: 2023-06-01`. For OpenAI compatible clients, set the base URL to `https://<worker-domain>/openai`; Gemini clients should use the `/gemini` path prefix. The gateway selects the upstream from the path and does not translate request bodies.

Run `npm test` for local tests, `npm run build` for packaging, and `npm run deploy` to deploy after database setup and provider seeding. Protect the gateway token: anyone holding it can spend against every configured provider.
