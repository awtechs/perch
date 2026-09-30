# Contributing to Perch

Keep changes focused and explain the behaviour they change. Open an issue first for changes to the approval model, protocol, persistent schema or privileged deployment infrastructure.

## Development checks

Use Linux and Node.js 24. Run `npm ci`, `npm run typecheck`, `npm run build`, `npm test` and `npm run test:deploy`. HTTP integration tests use loopback ports 18787 and 18788 and temporary databases; do not point them at a production state directory.

TypeScript must remain strict. Avoid `any`, type assertions that conceal unvalidated input, unbounded collections, silent execution failures and generic shell execution in the HTTP owner interface. Validate external input at boundaries. MCP clients must not gain an owner approval tool.

Tests should verify meaningful behaviour: ownership, consent, replay, revocation, concurrency, migration, recovery or deployment. Keep documentation and `.env.example` consistent with configuration changes.

## Releases and migrations

Use a new stable version tag on a commit already merged to `main`. Do not move or reuse published tags. The tag determines the installed package version. Review dependency and deployment changes explicitly.

Schema changes must remain readable by the preceding application release when code rollback is expected. Never discard user approval records during an automatic update. Explain any manual migration or rollback restriction before release.

## Public CI

Run public pull requests on disposable hosted runners. Never register a production server as a runner for this public repository. Fork workflows must have no deployment credentials. Avoid `pull_request_target` for running contributor code.

Do not include real owner passwords, client tokens, OAuth codes, private keys, state databases, infrastructure addresses or personal configuration in issues, screenshots, test fixtures or commits.
