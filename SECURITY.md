# Security Policy

AI Gateway is intended for personal self-hosting. Do not expose it publicly without protecting the gateway token and reviewing your Cloudflare access controls.

Provider API keys are stored in D1 as AES-256-GCM ciphertext. Keep `CONFIG_ENCRYPTION_KEY` outside the database and back it up securely. Losing it makes stored provider keys unrecoverable. Rotate the affected provider key if the encryption key is exposed.

Please report security vulnerabilities privately to the repository maintainer rather than opening a public issue. Include affected versions, impact, and reproducible steps. Do not include live API keys or personal data.
