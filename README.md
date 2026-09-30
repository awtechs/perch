# Perch

Self-hosted VPS administration through MCP, with explicit owner approval for shell commands.

Perch lets an AI client request an arbitrary Bash command, shows the owner exactly what will run, and records the decision and result. It is designed for Linux servers. Desktop control is outside the current scope.

**Status: early alpha.** Keep an independent recovery path such as SSH or RDC while evaluating Perch. The bootstrap release is not a hardened sandbox for untrusted root commands.

## How approval works

1. An authenticated client calls `request_command` with a command, an absolute working directory and a timeout. Include an idempotency key to make retries safe.
2. The owner opens `/approvals` and chooses **Approve now**, **Always approve this command for this client**, or **Deny**.
3. The client calls `execute_approved_command` after approval, then polls `get_command_result` for live output and completion.

A one-time approval is consumed once. A saved rule matches the exact command bytes, canonical working directory, authenticated client ID and an approved maximum timeout. It is not a wildcard or command-prefix rule. Saved rules are revocable; revocation also blocks unstarted requests relying on that rule. Files and scripts invoked by an approved command can change, so approve repeated script execution deliberately.

A client name is only a display label. Identity comes from the registered OAuth client or separately provisioned Bearer credential. Token refresh preserves that identity. Disabling a client revokes its tokens, blocks pending commands and interrupts its running commands.

## Local development

Requirements: Linux, Node.js 24 and npm. Deployment tooling additionally requires systemd and Python 3.12 or later.

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:deploy
```

Create `.env` from [.env.example](.env.example), replace placeholder credentials, and run:

```bash
node --env-file=.env dist/server.js
```

Open `http://127.0.0.1:8787/login`. Keep the owner password out of agent context. An optional bootstrap token supports local MCP testing. Production clients can connect through OAuth or owner-created token clients.

## Connect an MCP client

The endpoint is `<PUBLIC_URL>/mcp`, using Streamable HTTP. OAuth discovery, dynamic client registration, owner consent and PKCE are supported. Access tokens are short-lived; refresh tokens rotate and reused refresh tokens revoke their token family. The requested resource must match this Perch instance.

For token clients, create a credential from the owner-only `/clients` page and send it as `Authorization: Bearer <token>`. Credentials are shown once. Client credentials cannot approve commands or create other clients through MCP tools.

See [authentication](docs/authentication.md) for client setup and [operations](docs/operations.md) for installation and recovery.

## Deployment and updates

Pull requests run on GitHub-hosted runners. **Do not attach a production VPS runner to a public Perch repository.** Public contribution workflows must have no production credentials or network access to the server.

The optional VPS updater polls stable version tags such as `v0.2.0`. It accepts only tagged commits already on `main`, downloads that exact source, and builds and tests it as a separate unprivileged user inside a systemd sandbox. It passes no GitHub credentials, owner password or client tokens to the build. Failed builds do not reach the running service. A successful build is checksum-verified, installed as a separate release, and activated only if its health endpoint reports the expected version and commit. Failed activation restores the previous code.

Public GitHub Actions can separately publish downloadable release assets. Production updates do not depend on GitHub-hosted runner billing, and do not execute public pull-request workflows on the VPS.

The updater, release receiver and service units are reviewed bootstrap infrastructure, installed separately from application releases. See [deployment](docs/deployment.md) for setup, limitations and rollback.

## Security boundary

Perch requires approval before executing commands; it does **not** make an approved privileged command harmless. Commands execute as the configured service account. A root command can inspect or change the server, Perch itself, its approval database and credentials. Running the owner approval authority on the same root-accessible machine cannot prevent this.

Use a dedicated unprivileged account where possible. Grant root execution only when needed for administration and retain a recovery channel. This release is for a single owner managing a trusted VPS, not a multi-tenant execution platform.

See the [threat model](docs/threat-model.md) and [security policy](SECURITY.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), open a focused issue or pull request, and include evidence for changed behaviour. Security issues should be reported privately. Perch is licensed under [MIT](LICENSE).
