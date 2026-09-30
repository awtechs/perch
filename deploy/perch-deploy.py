#!/usr/bin/python3
"""Restricted SSH receiver. stdin is a release archive; no general shell access."""
import fcntl
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

CONFIG_PATH = pathlib.Path(os.environ.get('PERCH_DEPLOY_CONFIG', '/etc/perch-deploy.json'))
CONFIG = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
ROOT = pathlib.Path(CONFIG.get('root', '/opt/perch'))
DATA_DIR = pathlib.Path(CONFIG.get('data_dir', '/var/lib/perch'))
SERVICE = CONFIG.get('service', 'perch')
HEALTH_URL = CONFIG.get('health_url', 'http://127.0.0.1:8787/health')

def run(*args: str) -> None:
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL)

def activate(target: pathlib.Path) -> None:
    link = ROOT / '.current-next'
    link.unlink(missing_ok=True)
    link.symlink_to(target)
    link.replace(ROOT / 'current')

def healthy(version: str, commit: str | None = None) -> bool:
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=2) as response:
            body = json.load(response)
        return body.get('status') == 'ok' and body.get('version') == version and (commit is None or body.get('commit') == commit)
    except (OSError, ValueError):
        return False

def wait_health(version: str, commit: str | None = None) -> bool:
    for _ in range(20):
        if healthy(version, commit):
            return True
        time.sleep(1)
    return False

def main() -> None:
    command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
    match = re.fullmatch(r'deploy (v\d+\.\d+\.\d+) ([a-f0-9]{64}) ([a-f0-9]{40})', command)
    if not match:
        raise RuntimeError('Only deploy <version> <sha256> <commit> is allowed')
    tag, digest, commit = match.groups()
    ROOT.mkdir(mode=0o755, exist_ok=True)
    with (ROOT / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        releases = ROOT / 'releases'
        releases.mkdir(mode=0o755, exist_ok=True)
        release = releases / f'{tag}-{commit[:12]}'
        if release.exists():
            raise RuntimeError('This release already exists; use a new version tag')
        with tempfile.TemporaryDirectory(prefix='.deploy-', dir=ROOT) as scratch:
            archive = pathlib.Path(scratch) / 'release.tar.gz'
            checksum = hashlib.sha256()
            total = 0
            with archive.open('wb') as output:
                while chunk := sys.stdin.buffer.read(1024 * 1024):
                    total += len(chunk)
                    if total > 256 * 1024 * 1024:
                        raise RuntimeError('Archive exceeds 256 MiB')
                    checksum.update(chunk)
                    output.write(chunk)
            if checksum.hexdigest() != digest:
                raise RuntimeError('Archive checksum mismatch')
            staged = pathlib.Path(scratch) / 'staged'
            staged.mkdir(mode=0o755)
            with tarfile.open(archive, 'r:gz') as package:
                members = []
                total_size = 0
                for member in package:
                    members.append(member)
                    total_size += member.size
                    if len(members) > 100000 or total_size > 1024 * 1024 * 1024:
                        raise RuntimeError('Extracted release exceeds limits')
                    if member.isdev() or member.isfifo() or member.mode & 0o6000:
                        raise RuntimeError('Archive contains a forbidden file type or mode')
                package.extractall(staged, members=members, filter='data')
            metadata = json.loads((staged / 'package.json').read_text())
            if metadata.get('name') != 'perch' or metadata.get('version') != tag[1:]:
                raise RuntimeError('Package does not match release tag')
            if (staged / 'COMMIT').read_text().strip() != commit:
                raise RuntimeError('Commit does not match archive')
            if not (staged / 'dist/server.js').is_file():
                raise RuntimeError('Release has no compiled server')
            current = ROOT / 'current'
            previous = current.resolve(strict=True) if current.exists() else None
            previous_version = json.loads((previous / 'package.json').read_text())['version'] if previous else None
            # SQLite must not change while the backup API reads its state.
            run('systemctl', 'stop', SERVICE)
            try:
                import sqlite3
                data = DATA_DIR / 'state.sqlite'
                if data.exists():
                    backups = ROOT / 'backups'
                    backups.mkdir(mode=0o700, exist_ok=True)
                    snapshot = backups / f'{tag}-{commit[:12]}'
                    snapshot.mkdir(mode=0o700)
                    with sqlite3.connect(data) as source, sqlite3.connect(snapshot / 'state.sqlite') as backup:
                        source.backup(backup)
                    key = DATA_DIR / 'oauth.key'
                    if key.exists():
                        (snapshot / 'oauth.key').write_bytes(key.read_bytes())
                        (snapshot / 'oauth.key').chmod(0o600)
                staged.replace(release)
                activate(release)
                run('systemctl', 'start', SERVICE)
                if not wait_health(tag[1:], commit):
                    raise RuntimeError('New release failed its health check')
            except BaseException:
                run('systemctl', 'stop', SERVICE)
                if previous:
                    activate(previous)
                    run('systemctl', 'start', SERVICE)
                    if not wait_health(previous_version):
                        raise RuntimeError('Deployment failed and rollback is unhealthy')
                    print('Previous release restored', flush=True)
                raise
            (ROOT / 'deployed.json').write_text(json.dumps({'tag': tag, 'commit': commit, 'sha256': digest, 'deployed_at': int(time.time())}) + '\n')
            print(f'Deployed Perch {tag} ({commit[:12]}); health check passed', flush=True)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Deployment failed: {error}', file=sys.stderr)
        sys.exit(1)
