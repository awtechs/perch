# Perch

An initial approval-gated arbitrary Bash command MCP for a Linux VPS. RDC remains installed as the fallback.

## Approval model

- `request_command` records the exact command, canonical absolute working directory and authenticated client identity. It does not execute a pending request.
- The owner signs into `/approvals` with a separate password and chooses **Approve now**, **Always approve this command for this client**, or **Deny**.
- A one-time approval permits one execution of that stored request, through `execute_approved_command`. The agent cannot substitute another command or directory.
- A saved approval matches the exact command and canonical directory for the same client. Future matches start automatically. Saved approvals can be revoked in the owner interface.
- Pending and unused one-time approvals expire after ten minutes. Requests, saved approvals and audit records survive restarts in SQLite. Owner sessions expire after one hour and are lost on restart.
- `get_command_result` returns bounded output and status only for the authenticated client's own requests.
- Bash receives a fixed environment without the MCP's client token or owner password. Execution is capped at five minutes, output at 256 KiB and concurrency at four commands. Commands are non-interactive; process groups are terminated at completion or timeout. This version does not support keeping background jobs alive.

## Running

Requires Node.js 24 on Linux. Run `npm ci`, `npm run build`, then `npm test`.

Set `ADMIN_PASSWORD` (at least 24 characters), `CLIENT_TOKEN` (at least 32 characters), `CLIENT_ID`, `CLIENT_NAME`, `DATA_DIR`, `HOST`, `PORT` and `PUBLIC_URL`, then run `npm start`. Defaults bind to loopback port 8787. Keep credentials out of source control and tool-call output. The supplied systemd unit reads `/etc/perch.env` and uses `/opt/perch/current`.

Connect an MCP client to `/mcp` using Streamable HTTP and `Authorization: Bearer <CLIENT_TOKEN>`. The initial client is provisioned from environment variables; displayed MCP client names do not establish identity. Each additional client must receive a separately provisioned token and ID. Client management and OAuth onboarding are not implemented yet.

## Deployment boundary

This is a bootstrap release, not a stable RDC replacement. Keep it on loopback until TLS and client onboarding are configured and checked. The owner password must be used only in the owner browser, never given to the agent. Reverse proxy deployment must preserve Origin checks and protect the owner login. It is not yet directly usable as a ChatGPT OAuth connector.

The runner executes with the service account's OS permissions. On the initial VPS installation that account is root. An approved root command can inspect or modify the approval service, its files and credentials. This approval workflow is not an OS security boundary against malicious privileged commands. Persistent approval is permission to re-run a command, not a guarantee that script contents, files or environment state remain unchanged. Review commands invoking mutable scripts carefully.

## Operations

Back up the state directory using SQLite's backup API or stop the service before copying the database and WAL files. Restarting the service marks unfinished jobs interrupted. The systemd control group terminates remaining command processes when the service stops. Revoking a saved approval blocks future matching requests; it does not undo completed commands or revoke already granted one-time requests.

Before retiring RDC: configure TLS and authenticated client onboarding, exercise real maintenance workflows with owner approvals, test restart/reconnect and recovery, test revocation and backup restoration, and run alongside RDC for an agreed period.

## Tagged updates

Pull requests and pushes to `main` run checks without updating production. Push a semantic version tag such as `v0.1.0` on a commit already merged into `main` to publish and deploy that version. Do not move or reuse release tags.

The release workflow builds and tests on Node.js 24, packages production dependencies, and publishes a GitHub release with the archive and its SHA-256 checksum. A dedicated SSH key streams that same archive to `deploy/perch-deploy.py` on the VPS. The forced-command key cannot open a general SSH shell, forward ports or allocate a terminal. Deployment requires repository secrets `PERCH_DEPLOY_HOST`, `PERCH_DEPLOY_PORT`, `PERCH_DEPLOY_KEY` and `PERCH_DEPLOY_KNOWN_HOSTS`.

The receiver validates tag, checksum, commit and archive paths; takes an SQLite backup with the service stopped; installs a separate release directory; atomically switches `/opt/perch/current`; and checks the running version. A failed health check restores the previous code and restarts it. Deployments are serialised on GitHub and with a VPS file lock.

Approval data remains at the existing `/var/lib/awtechs-vps-mcp` location and credentials in `/etc/perch.env`, outside release directories. Backups are retained in `/opt/perch/backups`. Database schema changes must remain compatible with the preceding release: code rollback does not automatically overwrite the current database. This prevents rollback from discarding new approvals or audit records. Background commands are stopped during updates; avoid tagging a release during active maintenance.

The deployment receiver and systemd unit are bootstrap infrastructure managed separately from application archives. To update either, explicitly install the reviewed version on the VPS. If deployment fails after the GitHub release was created, inspect the workflow logs; do not reuse the tag. Fix the issue and publish a new version.
