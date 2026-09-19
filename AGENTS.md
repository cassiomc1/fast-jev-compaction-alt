# Repository guidance

This repository is a TypeScript library with structural adapters for Claude
Code, OpenCode, and Responses/Codex-style tool items. Keep host integrations
dependency-light: the core and host adapters must not require a provider SDK at
runtime unless that host explicitly loads it.

## Working agreements

- Preserve unrelated working-tree changes.
- Do not commit credentials, API keys, generated local logs, or temporary npm
  tarballs.
- Keep compaction fail-open at host boundaries: a Jev/network/parse failure
  must leave the host transcript unchanged and let the host's normal fallback
  continue.
- Treat tool call IDs as opaque strings and preserve unknown host fields when
  adapting items.
- Update tests and package smoke coverage when adding a public export or
  package entrypoint.

## Validation

Run the focused checks while iterating, then the complete local gate:

```sh
npm run typecheck
npm test
npm run test:programming
npm run check
npm run validate:manifests
npm run version:check
npm run smoke:pack
```

The live demo is the only command that contacts TypeSafe and requires
`TYPESAFE_API_KEY`; normal tests use injected transports.
