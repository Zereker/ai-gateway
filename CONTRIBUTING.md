# Contributing

Thanks for helping improve AI Gateway. Keep changes focused and preserve the gateway's security boundaries.

## Development

- Use Node.js 22 or newer and the package lockfile.
- Install dependencies with `npm ci`.
- Run `npm test` and `npm run build` before opening a pull request.
- For Worker changes, add tests for routing, authentication, upstream headers, and error handling.
- For schema changes, add a new numbered SQL migration instead of editing a migration that has already shipped.

## Provider changes

- Add a fixed public route in `ProviderRegistry`; never accept an upstream host from the request.
- Store provider credentials encrypted with the existing AES-GCM envelope and keep the encryption key in a Worker Secret.
- Preserve streaming request and response bodies.
- Remove hop-by-hop headers and replace only the provider authentication header.
- Add tests for the protocol's route and authentication behavior.

## Security

Never commit API keys, gateway tokens, encryption keys, `.dev.vars`, or plaintext provider exports. Report vulnerabilities privately to the maintainer as described in `SECURITY.md`.
