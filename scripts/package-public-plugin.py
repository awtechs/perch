from pathlib import Path
import json
import re
import zipfile

root = Path(__file__).resolve().parents[1]
source = root / 'plugins' / 'perch'
manifest = json.loads((source / 'plugin.json').read_text())
assert manifest['name'] == 'perch'
assert re.fullmatch(r'\d+\.\d+\.\d+', manifest['version'])
interface = manifest['extensions']['com.openai']['interface']
assert len(interface['shortDescription']) <= 30
assert manifest['extensions']['com.openai']['publication']['countries'] == []
for name in ('websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL'):
    assert interface[name].startswith('https://perch.awtechs.com/')
for name in ('logo', 'composerIcon'):
    path = (source / interface[name]).resolve()
    assert path.is_relative_to(source.resolve()) and path.is_file()
skill = (source / 'skills/perch-admin/SKILL.md').read_text()
assert skill.startswith('---\nname: perch-admin\ndescription: ')
assert 'execute_approved_command' in skill and 'get_command_result' in skill
files = sorted(p for p in source.rglob('*') if p.is_file())
assert not any(p.is_symlink() for p in source.rglob('*'))
assert not any(p.name in ('mcp.json', '.mcp.json', '.app.json') for p in files)
assert 'apps' not in manifest and 'apps' not in manifest['extensions']['com.openai']
assert len(files) == 3
output = root / 'artifacts/perch-plugin.zip'
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in files:
        archive.write(path, 'perch/' + path.relative_to(source).as_posix())
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    uploaded = json.loads(archive.read('perch/plugin.json'))
    assert uploaded == manifest
print(output)
