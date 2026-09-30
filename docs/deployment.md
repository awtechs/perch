# Deployment and tagged updates

The running bootstrap installation predates the hardened architecture. Installing these components is a separate step; a merged pull request alone does not prove they are running.

## Trust boundary

Public contribution checks run on disposable GitHub-hosted runners. Production must not be registered as a self-hosted runner for a public repository. The updater is a narrow tag consumer, not a GitHub Actions runner: it downloads only stable tags in the configured repository, verifies that the tagged commit is already on `main`, and builds that exact source.

Maintainers with permission to merge and tag are trusted to deploy executable code. Protect those permissions, use account MFA, review `.github`, `deploy`, authentication and approval changes carefully, and never tag an unreviewed contributor branch. A GitHub token for a private repository should have read-only contents access to that one repository.

## Bootstrap components

Install the reviewed `perch-deploy.py`, `perch-build.sh` and `perch-update.py` as `/usr/local/libexec/perch-deploy`, `/usr/local/libexec/perch-build` and `/usr/local/libexec/perch-update`, owned by root and mode 0755. They are not updated by application archives.

Create a separate `perch-build` system user with home `/var/lib/perch-build`, no sudo or Docker privileges, and no production group membership. Install `perch-update.service` and `perch-update.timer` under `/etc/systemd/system`.

The root-owned, mode-0600 `/etc/perch-updater.env` contains:

```dotenv
PERCH_REPOSITORY=Lordeagle4/perch
# Optional for a public repository; required for a private one.
GITHUB_TOKEN=replace-with-a-read-only-repository-token
```

A root-owned `/etc/perch-deploy.json` configures installation-specific paths:

```json
{
  "root": "/opt/perch",
  "data_dir": "/var/lib/perch",
  "service": "perch",
  "health_url": "http://127.0.0.1:8787/health"
}
```

These are the defaults when no receiver config is present. Existing installations with another data directory must set it explicitly before upgrading. Match the receiver data directory to `DATA_DIR` in the application environment.

Enable the timer with `systemctl enable --now perch-update.timer`. It checks approximately once a minute. Review `journalctl -u perch-update` for build, test and activation results. The tagged source must use Node.js 24, and the VPS must have that version available to the build user.

## Activation

The build uses a systemd sandbox with a separate UID, fixed non-secret environment, filesystem restrictions and private temporary storage. It runs the application's dependency installation, type checks, build and meaningful tests before packaging production dependencies. Those scripts are trusted release code, not public pull-request code.

The receiver validates stable tag syntax, checksum, archive limits, archive paths, package name/version, compiled entrypoint and exact commit. It stops the service, backs up SQLite through its backup API and copies the OAuth encryption key, then activates a separate release directory. The health check must report the expected version and commit.

A failed activation restores the preceding code and restarts it. It does not automatically replace the current database. New schema changes must preserve backward compatibility; otherwise an explicit migration/rollback plan is required. Backups and credentials stay outside application releases.

Completed installation metadata is recorded in `/opt/perch/deployed.json`. A failed tagged update is recorded in `updater-failed.json` and is not retried repeatedly. Fix the issue and publish a new tag. Remove a failure record only after inspecting the cause and checking whether a release directory already exists.

## Publishing assets

GitHub's tagged-release workflow builds and tests on a hosted runner, then publishes an archive and checksum. It has no production SSH key and does not deploy directly. Hosted-runner billing or availability therefore does not block the separate VPS tag updater.

Public forks cannot enqueue builds on the VPS through a GitHub workflow. Do not keep the bootstrap public-repository self-hosted runner or deployment credentials after switching to this architecture. Revoke the bootstrap restricted deployment SSH key, remove its GitHub secrets, unregister the runner, and verify no other project shares that runner before stopping its service.

## Recovery and limits

Keep prior release directories and test rollback on disposable infrastructure. Use SSH/RDC to inspect failed health checks. If an update cannot be recovered, stop Perch, inspect the database backup and encryption key, and restore a compatible code/database pair deliberately. Never overwrite live approvals merely to make a health check green.

Source builds need dependency-network access and may fail when upstream services are unavailable. The existing release remains running during build; it is briefly unavailable during activation. Active shell commands are interrupted when the service stops. Apply updates outside critical maintenance windows.
