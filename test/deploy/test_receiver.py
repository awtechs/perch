import importlib.util
import io
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('perch_receiver', pathlib.Path(__file__).parents[2] / 'deploy/perch-deploy.py')
receiver = importlib.util.module_from_spec(spec)
with tempfile.TemporaryDirectory() as config_dir:
    config = pathlib.Path(config_dir) / 'deploy.json'
    config.write_text('{}')
    with patch.dict(os.environ, {'PERCH_DEPLOY_CONFIG': str(config)}):
        spec.loader.exec_module(receiver)

class ReceiverTests(unittest.TestCase):
    def test_restricted_receiver_rejects_shell_commands(self):
        with patch.dict(os.environ, {'SSH_ORIGINAL_COMMAND':'id'}, clear=False):
            with self.assertRaisesRegex(RuntimeError, 'Only deploy'):
                receiver.main()

    def test_activation_switches_symlink_without_removing_previous_release(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = pathlib.Path(scratch)
            first = root / 'first'; second = root / 'second'
            first.mkdir(); second.mkdir()
            with patch.object(receiver, 'ROOT', root):
                receiver.activate(first)
                self.assertEqual((root / 'current').resolve(), first)
                receiver.activate(second)
                self.assertEqual((root / 'current').resolve(), second)
                self.assertTrue(first.exists())

    def test_health_requires_exact_commit(self):
        class Response:
            def __enter__(self): return io.BytesIO(json.dumps({'status':'ok','version':'1.2.3','commit':'a'*40}).encode())
            def __exit__(self, *args): return False
        with patch.object(receiver.urllib.request, 'urlopen', return_value=Response()):
            self.assertTrue(receiver.healthy('1.2.3','a'*40))
            self.assertFalse(receiver.healthy('1.2.3','b'*40))
            self.assertFalse(receiver.healthy('1.2.4','a'*40))

if __name__ == '__main__':
    unittest.main()

class ArchiveTests(unittest.TestCase):
    def archive(self, files):
        import tarfile
        payload = io.BytesIO()
        with tarfile.open(fileobj=payload, mode='w:gz') as archive:
            for name, data in files.items():
                entry = tarfile.TarInfo(name); entry.size = len(data); entry.mode = 0o644
                archive.addfile(entry, io.BytesIO(data))
        return payload.getvalue()

    def invoke(self, root, payload, checksum=None):
        import hashlib
        from types import SimpleNamespace
        command = 'deploy v0.2.0 ' + (checksum or hashlib.sha256(payload).hexdigest()) + ' ' + 'a'*40
        return patch.multiple(receiver, ROOT=root, DATA_DIR=root/'state'), patch.dict(os.environ, {'SSH_ORIGINAL_COMMAND':command}), patch.object(receiver.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(payload)))

    def test_checksum_failure_cannot_stop_running_service(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = pathlib.Path(scratch)
            roots, environment, stream = self.invoke(root, b'invalid', '0'*64)
            with roots, environment, stream, patch.object(receiver, 'run') as service:
                with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'): receiver.main()
                service.assert_not_called()

    def test_archive_traversal_is_rejected_before_activation(self):
        import tarfile
        with tempfile.TemporaryDirectory() as scratch:
            root = pathlib.Path(scratch); payload = self.archive({'../escaped':b'unsafe'})
            roots, environment, stream = self.invoke(root, payload)
            with roots, environment, stream, patch.object(receiver, 'run') as service:
                with self.assertRaises(tarfile.FilterError): receiver.main()
                service.assert_not_called()
            self.assertFalse(list(root.rglob('escaped')))

    def test_failed_activation_restores_previous_release(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = pathlib.Path(scratch); previous = root/'previous'; previous.mkdir()
            (previous/'package.json').write_text(json.dumps({'name':'perch','version':'0.1.0'}))
            (root/'current').symlink_to(previous)
            payload = self.archive({'package.json':json.dumps({'name':'perch','version':'0.2.0'}).encode(),'COMMIT':b'a'*40,'dist/server.js':b'process.exit(1)'})
            roots, environment, stream = self.invoke(root, payload)
            with roots, environment, stream, patch.object(receiver, 'run') as service, patch.object(receiver, 'wait_health', side_effect=lambda version,commit=None:version=='0.1.0'):
                with self.assertRaisesRegex(RuntimeError, 'health check'): receiver.main()
                self.assertEqual((root/'current').resolve(), previous)
                self.assertEqual(service.call_count,4)
