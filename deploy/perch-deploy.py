#!/usr/bin/python3
"""Restricted SSH receiver. stdin is a release archive; no general shell access."""
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

ROOT = pathlib.Path('/opt/perch')

def run(*args: str) -> None:
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL)

def activate(target: pathlib.Path) -> None:
    link = ROOT / '.current-next'
    link.unlink(missing_ok=True)
    link.symlink_to(target)
    link.replace(ROOT / 'current')

def healthy(version: str) -> bool:
    try:
        with urllib.request.urlopen('http://127.0.0.1:8787/health', timeout=2) as response:
            body = json.load(response)
        return body.get('status') == 'ok' and body.get('version') == version
    except (OSError, ValueError):
        return False

def wait_health(version: str) -> bool:
    for _ in range(20):
        if healthy(version):
            return True
        time.sleep(1)
    return False

def main() -> None:
    command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
    match = re.fullmatch(r'deploy (v\d+\.\d+\.\d+) ([a-f0-9]{64}) ([a-f0-9]{40})', command)
    if not match:
        raise RuntimeError('Only deploy <version> <sha256> <commit> is allowed')
    tag, digest, commit = match.groups()
    ROOT.mkdir(mode=0o700, exist_ok=True)
    with (ROOT / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        releases = ROOT / 'releases'
        releases.mkdir(mode=0o700, exist_ok=True)
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
            staged.mkdir(mode=0o700)
            with tarfile.open(archive, 'r:gz') as package:
                if sum(member.size for member in package.getmembers()) > 1024 * 1024 * 1024:
                    raise RuntimeError('Extracted release exceeds 1 GiB')
                for member in package.getmembers():
                    if member.isdev() or member.isfifo() or member.mode & 0o6000:
                        raise RuntimeError('Archive contains a forbidden file type or mode')
                package.extractall(staged, filter='data')
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
            run('systemctl', 'stop', 'perch')
            try:
                import sqlite3
                data = pathlib.Path('/var/lib/awtechs-vps-mcp/state.sqlite')
                if data.exists():
                    backups = ROOT / 'backups'
                    backups.mkdir(mode=0o700, exist_ok=True)
                    with sqlite3.connect(data) as source, sqlite3.connect(backups / f'{tag}-{commit[:12]}.sqlite') as backup:
                        source.backup(backup)
                staged.replace(release)
                activate(release)
                run('systemctl', 'start', 'perch')
                if not wait_health(tag[1:]):
                    raise RuntimeError('New release failed its health check')
            except BaseException:
                run('systemctl', 'stop', 'perch')
                if previous:
                    activate(previous)
                    run('systemctl', 'start', 'perch')
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
