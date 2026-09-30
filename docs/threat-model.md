# Threat model

## Assets and actors

The assets are host administration privileges, owner credentials, MCP client credentials, OAuth grants, approval rules, command output, audit history and release integrity.

The owner controls the VPS and its Perch configuration. An MCP client has only its own registered identity and may request arbitrary commands. Internet visitors, public contributors and client-supplied command/output text are untrusted. Maintainers authorised to merge and tag release code are trusted deployment actors.

## Enforced boundaries

Pending commands do not run. One-time approvals are consumed atomically. Requests cannot change after approval. Saved rules match the exact client, command, canonical directory and timeout limit. Disabled clients cannot read or execute commands. A client cannot read another client's requests, and no MCP tool grants owner consent.

Bearer credentials are hashed. OAuth checks PKCE, redirect binding, resource binding, code expiry/replay and token revocation. Owner forms use authenticated sessions and CSRF protection. Reflected command text and output are escaped. HTTP input sizes, approval queues, execution concurrency, duration and stored output are bounded.

Public CI runs on hosted infrastructure. The VPS updater accepts only maintainers' stable tags whose commits are already on `main`. Builds run as an unprivileged user with production secrets excluded. Release activation verifies the archive checksum, package version and commit, then verifies the running version/commit; code rollback restores the previous release.

## Limits

Perch is not a command sandbox. A command runs with the service account's normal filesystem, network and process capabilities. Root can access or modify the same-host approval authority and credentials. Strong protection against an adversarial root runner would require a separate approval authority outside that host.

Exact command strings do not freeze script contents, executable binaries, files, mounts, DNS or external service state. Canonical directory checks narrow path confusion but are not a race-free filesystem sandbox. A command can deliberately daemonise or start independent services; process-group cleanup does not revoke every side effect.

The SQLite audit is an operational history, not an externally immutable log. Privileged users can modify it. Recorded commands and output may contain credentials if the user puts them there; Perch cannot promise to identify every secret in arbitrary shell output.

This version has one owner, one local runner and no multi-tenant isolation. It has no external security audit or availability SLA. Root-owned deployment infrastructure and systemd configuration must be reviewed separately from application code.

## Recovery

Keep a separate SSH/RDC path. Back up the database and OAuth key, test recovery on disposable infrastructure, revoke compromised clients and rules, and inspect audit history after an incident. Do not retire the recovery channel merely because a health check passed.
