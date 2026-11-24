import copy
import json
from pathlib import Path
import unittest
from history_policy import compact_match, match_exclusion

MATCH = json.loads((Path(__file__).parent / 'fixtures/recorded-flex-match.json').read_text())
START = MATCH['info']['gameStartTimestamp']
DAY = 86400000


class HistoryPolicyTests(unittest.TestCase):
    def test_ranked_and_specific_queue(self):
        self.assertIsNone(match_exclusion(MATCH, {'queue': 'ranked'}, START + DAY))
        self.assertIsNone(match_exclusion(MATCH, {'queue': 440}, START + DAY))
        self.assertEqual(match_exclusion(MATCH, {'queue': 420}, START + DAY), 'queue')

    def test_window_uses_match_time_not_fetch_time(self):
        self.assertIsNone(match_exclusion(MATCH, {'queue': 'ranked', 'max_match_age_days': 365}, START + 365 * DAY))
        self.assertEqual(match_exclusion(MATCH, {'queue': 'ranked', 'max_match_age_days': 365}, START + 365 * DAY + 1), 'expired')
        self.assertIsNone(match_exclusion(MATCH, {'max_match_age_days': 0}, START + 1000 * DAY))
        self.assertEqual(match_exclusion(MATCH, {'maxMatchAgeDays': 30}, START + 31 * DAY), 'expired')

    def test_incomplete_transport_is_not_a_game(self):
        incomplete = copy.deepcopy(MATCH)
        incomplete['info']['participants'] = []
        self.assertEqual(match_exclusion(incomplete, {}, START), 'invalid')

    def test_portable_ledger_keeps_real_attribution_and_outcomes(self):
        compact = compact_match(MATCH)
        self.assertEqual(compact, MATCH)
        self.assertEqual(len(compact['info']['participants']), 10)
        self.assertEqual(sum(bool(p['win']) for p in compact['info']['participants']), 5)


if __name__ == '__main__':
    unittest.main()
