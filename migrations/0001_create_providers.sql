CREATE TABLE IF NOT EXISTS providers (
  name TEXT PRIMARY KEY,
  protocol TEXT NOT NULL CHECK (protocol IN ('anthropic-messages', 'openai-chat-completions', 'openai-responses', 'gemini')),
  base_url TEXT NOT NULL CHECK (base_url LIKE 'https://%'),
  auth_type TEXT NOT NULL CHECK (auth_type IN ('bearer', 'x-api-key', 'x-goog-api-key')),
  encrypted_api_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
