#!/usr/bin/python3
"""Poll trusted repository tags. No pull-request code or GitHub runner runs on production."""
import fcntl
import hashlib
import io
import json
import os
import pathlib
import pwd
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path('/opt/perch')
VERSION = re.compile(r'^v(\d{1,9})\.(\d{1,9})\.(\d{1,9})$')

class GitHub:
    def __init__(self, repository: str, token: str):
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
            raise ValueError('Invalid PERCH_REPOSITORY')
        self.base = f'https://api.github.com/repos/{repository}'
        self.token = token

    def request(self, path: str) -> urllib.response.addinfourl:
        headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'Perch-updater', 'X-GitHub-Api-Version': '2022-11-28'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        request = urllib.request.Request(self.base + path, headers=headers)
        return urllib.request.urlopen(request, timeout=30)

    def json(self, path: str):
        with self.request(path) as response:
            return json.load(response)

    def source(self, commit: str, target: pathlib.Path) -> None:
        # urllib strips no sensitive credentials automatically. api.github.com tarball redirects
        # to codeload.github.com; explicitly follow that one trusted host without the API token.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        headers = {'User-Agent': 'Perch-updater', 'Accept': 'application/vnd.github+json'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        request = urllib.request.Request(self.base + '/tarball/' + commit, headers=headers)
        try:
            response = urllib.request.build_opener(NoRedirect).open(request, timeout=30)
        except urllib.error.HTTPError as error:
            if error.code not in (301, 302, 303, 307, 308):
                raise
            location = error.headers['Location']
            uri = urllib.parse.urlparse(location)
            if uri.scheme != 'https' or uri.hostname != 'codeload.github.com' or uri.username or uri.password:
                raise ValueError('Unexpected source archive redirect')
            response = urllib.request.urlopen(urllib.request.Request(location, headers={'User-Agent':'Perch-updater'}), timeout=30)
        with response, target.open('wb') as output:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > 32 * 1024 * 1024:
                    raise ValueError('Source archive exceeds 32 MiB')
                output.write(chunk)

def version(tag: str) -> tuple[int, int, int] | None:
    match = VERSION.fullmatch(tag)
    return tuple(map(int, match.groups())) if match else None

def update() -> None:
    repository = os.environ.get('PERCH_REPOSITORY', '')
    api = GitHub(repository, os.environ.get('GITHUB_TOKEN', ''))
    ROOT.mkdir(mode=0o755, exist_ok=True)
    with (ROOT / '.updater.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        deployed = json.loads((ROOT / 'deployed.json').read_text()) if (ROOT / 'deployed.json').exists() else {'tag':'v0.0.0'}
        current = version(deployed['tag'])
        if current is None:
            raise ValueError('Installed version is not a stable version tag')
        tags = api.json('/tags?per_page=100')
        candidates = [(version(tag['name']), tag['name'], tag['commit']['sha']) for tag in tags if version(tag['name']) is not None]
        candidates = [candidate for candidate in candidates if candidate[0] > current]
        if not candidates:
            return
        _, tag, commit = max(candidates)
        if not re.fullmatch(r'[a-f0-9]{40}', commit):
            raise ValueError('Invalid release commit')
        failed_path = ROOT / 'updater-failed.json'
        if failed_path.exists():
            failed = json.loads(failed_path.read_text())
            if failed.get('tag') == tag and failed.get('commit') == commit:
                return
        comparison = api.json('/compare/main...' + commit)
        if comparison['merge_base_commit']['sha'] != commit or comparison['ahead_by'] != 0:
            raise ValueError('Release tag is not an ancestor of main')
        # Only maintainers who can tag commits already on main can trigger this build.
        account = pwd.getpwnam('perch-build')
        workspace = pathlib.Path('/var/lib/perch-build')
        with tempfile.TemporaryDirectory(prefix='release-', dir=workspace) as scratch:
            scratch_path = pathlib.Path(scratch)
            archive = scratch_path / 'source.tar.gz'
            try:
                api.source(commit, archive)
                extracted = scratch_path / 'source'
                extracted.mkdir()
                with tarfile.open(archive, 'r:gz') as source:
                    members = source.getmembers()
                    if len(members) > 10000 or sum(member.size for member in members) > 128 * 1024 * 1024:
                        raise ValueError('Source archive exceeds extraction limits')
                    source.extractall(extracted, filter='data')
                folders = list(extracted.iterdir())
                if len(folders) != 1 or not folders[0].is_dir():
                    raise ValueError('Unexpected source archive layout')
                project = folders[0]
                for item in [scratch_path, *scratch_path.rglob('*')]:
                    os.chown(item, account.pw_uid, account.pw_gid, follow_symlinks=False)
                command = ['systemd-run', '--quiet', '--wait', '--collect', '--pipe', '--service-type=exec', '--uid=perch-build', '--working-directory='+str(project),
                    '--property=NoNewPrivileges=yes', '--property=ProtectSystem=strict', '--property=ProtectHome=yes', '--property=PrivateTmp=yes', '--property=ProtectProc=invisible',
                    '--property=ReadWritePaths='+str(scratch_path),
                    '--property=InaccessiblePaths=-/root -/etc/perch.env -/etc/awtechs-vps-mcp.env -/etc/perch-updater.env -/etc/perch-deploy -/opt/perch -/opt/awtechs-vps-mcp -/var/lib/awtechs-vps-mcp -/var/lib/perch -/run/docker.sock',
                    '--setenv=HOME='+str(scratch_path), '--setenv=CI=true', '--setenv=PATH=/usr/local/bin:/usr/bin:/bin', '--setenv=RELEASE_VERSION='+tag[1:], '--setenv=RELEASE_COMMIT='+commit,
                    '/bin/bash', '/usr/local/libexec/perch-build']
                subprocess.run(command, check=True, timeout=600, env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin'})
                package = project / 'perch.tar.gz'
                checksum = hashlib.sha256()
                with package.open('rb') as output:
                    while chunk := output.read(1024 * 1024):
                        checksum.update(chunk)
                environment = {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','SSH_ORIGINAL_COMMAND':f'deploy {tag} {checksum.hexdigest()} {commit}'}
                with package.open('rb') as output:
                    subprocess.run(['/usr/local/libexec/perch-deploy'], stdin=output, env=environment, check=True, timeout=180)
                failed_path.unlink(missing_ok=True)
                print(f'Trusted tag {tag} built, tested and deployed', flush=True)
            except Exception as error:
                failed_path.write_text(json.dumps({'tag':tag,'commit':commit,'error_type':type(error).__name__})+'\n')
                raise

if __name__ == '__main__':
    try:
        update()
    except BlockingIOError:
        pass
    except Exception as error:
        print('Perch updater failed: '+type(error).__name__, flush=True)
        raise SystemExit(1)
