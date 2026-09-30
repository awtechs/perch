import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('perch_updater', pathlib.Path(__file__).parents[2] / 'deploy/perch-update.py')
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)

class UpdaterTests(unittest.TestCase):
    def test_version_parser_accepts_only_stable_tags(self):
        self.assertEqual(updater.version('v1.2.3'), (1,2,3))
        for tag in ['v1.2.3-beta','main','v1.2','v1.2.3; id','v1.2.3/other']:
            self.assertIsNone(updater.version(tag))

    def test_tags_outside_main_cannot_trigger_a_build(self):
        class API:
            def json(self, path):
                if path.startswith('/tags'):return [{'name':'v0.2.0','commit':{'sha':'a'*40}}]
                return {'merge_base_commit':{'sha':'b'*40},'ahead_by':1}
        with tempfile.TemporaryDirectory() as scratch:
            with patch.object(updater, 'ROOT', pathlib.Path(scratch)), patch.object(updater, 'GitHub', return_value=API()), patch.object(updater.subprocess, 'run') as build:
                with self.assertRaisesRegex(ValueError, 'not an ancestor'):updater.update()
                build.assert_not_called()

    def test_repository_input_does_not_allow_paths_or_urls(self):
        for value in ['https://github.com/Lordeagle4/perch','Lordeagle4/perch/other','Lordeagle4/perch?x=y']:
            with self.assertRaisesRegex(ValueError, 'Invalid'):updater.GitHub(value, '')
