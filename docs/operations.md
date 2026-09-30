# Operations

## First installation

Use Linux with systemd, Node.js 24 and Python 3.12 or later. Keep SSH or another independent administration channel available. Build and test the project as a normal user before installing production files. Do not run an unreviewed contributor's installer or dependency scripts as root.

The supplied service runs as the dedicated `perch` user by default. Create that account, give it a private `/var/lib/perch` data directory, install the compiled application and production dependencies under `/opt/perch/releases/<version>`, and point `/opt/perch/current` at that release. Code directories must be readable by the service account; credentials and data must be private.

Install `deploy/perch.service` as `/etc/systemd/system/perch.service`. The root-owned, mode-0600 `/etc/perch.env` provides configuration:

```dotenv
ADMIN_PASSWORD=replace-with-a-long-random-owner-password
DATA_DIR=/var/lib/perch
HOST=127.0.0.1
PORT=8787
PUBLIC_URL=https://perch.example.com
MAX_CONCURRENCY=4
TRUST_PROXY=127.0.0.1,::1
```

`ADMIN_PASSWORD` requires at least 24 characters. `CLIENT_TOKEN`, `CLIENT_ID` and `CLIENT_NAME` optionally provision a separate bootstrap client. Omit them when using OAuth and owner-created clients. Never give the owner password to the MCP client.

`PUBLIC_URL` must be an HTTPS origin with no path, query, fragment or credentials, except for loopback HTTP development. Configure TLS on a trusted reverse proxy. Forward the correct Host header, replace forwarded client-address headers, and list only the proxy's actual IPs/CIDRs in `TRUST_PROXY`. A Docker proxy cannot necessarily reach a service bound to host loopback; choose a private reachable bind address and block direct external access to that port.

Run `systemctl daemon-reload`, `systemctl enable --now perch` and inspect `journalctl -u perch`. Verify the health endpoint, OAuth discovery, unauthenticated rejection, owner login, client consent and a harmless command before using administrative commands.

## Root administration

A dedicated unprivileged service account cannot perform every VPS action. When root execution is required, explicitly override the service account using `systemctl edit perch`:

```ini
[Service]
User=root
Group=root
```

Then restart the service. This grants approved commands root access, including access to Perch's own data and credentials. It is an operator choice, not an enforced sandbox. Do not assume approval rules remain tamper-proof after granting root commands.

The initial development VPS installation used root. That installation-specific choice must not be copied silently to public users.

## Backup

State is in `DATA_DIR/state.sqlite`; OAuth client secrets are encrypted using `DATA_DIR/oauth.key`. Back up both, with permissions that prevent other users reading them. The encryption key is required to restore OAuth clients. Use SQLite's backup API or stop Perch before copying live state. Copying only a live SQLite main file can omit WAL transactions.

Test a restore to a separate directory on disposable infrastructure. Keep the production issuer unchanged if clients must keep their audience binding. Restarts invalidate owner browser sessions and mark unfinished commands interrupted.

## Revocation and retention

Revoke saved rules from `/approvals`. Disable compromised clients from `/clients`, then issue new credentials. Do not reuse a credential across applications. Disabling cancels active process groups, but cannot undo completed work or independent services started by an approved command.

Commands and captured output are retained in SQLite; arbitrary output can contain secrets. Configure backups accordingly. This alpha does not yet have automatic retention deletion. Monitor database size and disk space, and plan deliberate export/deletion rather than silently discarding audit history.

## Before retiring RDC

Complete a real client connection, exercise normal maintenance tasks, test disconnect/reconnect and reboot, revoke a client and a rule, test a failed release and recovery, restore a backup, and observe normal operation for an agreed period. A passing local test or one successful release does not satisfy that stability requirement.
