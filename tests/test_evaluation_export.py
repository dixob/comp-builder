import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts.export_evaluation import export

MATCH = json.loads((Path(__file__).parent / 'fixtures/recorded-flex-match.json').read_text())


class ExportTests(unittest.TestCase):
    def test_paginated_download_preserves_real_evidence_and_keeps_token_out_of_args(self):
        # Mechanical transport envelopes around checked-in evidence.
        pages = [
            {'schemaVersion': 1, 'records': [], 'matches': [MATCH], 'collection': [], 'nextCursor': 'next-page'},
            {'schemaVersion': 1, 'records': [], 'matches': [MATCH], 'collection': [], 'nextCursor': None},
        ]
        with TemporaryDirectory() as output, patch('scripts.export_evaluation.subprocess.run') as run:
            run.side_effect = [SimpleNamespace(returncode=0, stdout=json.dumps(p)) for p in pages]
            self.assertEqual(export('https://compy.example', 'transport-only-token', output), (0, 1))
            saved = json.loads((Path(output) / 'matches' / (MATCH['metadata']['matchId'] + '.json')).read_text())
            self.assertEqual(saved, MATCH)
            self.assertIn('cursor=next-page', run.call_args_list[1].args[0][-1])
            self.assertNotIn('transport-only-token', str(run.call_args_list[0].args))
            self.assertIn('transport-only-token', run.call_args_list[0].kwargs['input'])

    def test_auth_failure_does_not_overwrite_prior_export(self):
        with TemporaryDirectory() as output, patch('scripts.export_evaluation.subprocess.run') as run:
            target = Path(output) / 'records.json'
            target.write_text('{"schemaVersion": 1, "records": []}')
            run.return_value = SimpleNamespace(returncode=22, stdout='')
            with self.assertRaises(RuntimeError):
                export('https://compy.example', 'transport-only-token', output)
            self.assertEqual(json.loads(target.read_text()), {'schemaVersion': 1, 'records': []})

    def test_rejects_header_injection_and_non_https(self):
        for url, token in [('http://compy.example', 'token'), ('https://compy.example', 'token\nextra: header')]:
            with self.assertRaises(ValueError):
                export(url, token, Path('/unused'))


if __name__ == '__main__':
    unittest.main()
