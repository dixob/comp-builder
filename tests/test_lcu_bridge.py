"""Bridge transport checks; gameplay fields are projected from a recorded match."""
from contextlib import ExitStack
import http.client
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import urllib.error

import lcu_bridge


MATCH = json.loads((Path(__file__).parent / "fixtures/recorded-flex-match.json").read_text())
PARTICIPANTS = MATCH["info"]["participants"]
DRAFT = {
    "active": True, "bans": [],
    "enemy": sorted(p["championId"] for p in PARTICIPANTS if p["teamId"] == 200),
    "ours": [{"championId": p["championId"], "position": p["teamPosition"],
              "riotId": p["riotIdGameName"] + "#" + p["riotIdTagline"]}
             for p in PARTICIPANTS if p["teamId"] == 100],
}


class StopPolling(BaseException):
    """End an otherwise persistent bridge after the intended iterations."""


class BridgeTests(unittest.TestCase):
    def run_until_sleeps(self, lcu_reads, post_results, count):
        # Transport-only settings; the LCU and all remote POSTs are intercepted.
        root = Mock()
        root.__truediv__ = Mock(return_value=Mock(
            read_text=Mock(return_value=json.dumps({"worker_url": "https://compy.example"}))))
        lock = Mock(read_text=Mock(return_value="LeagueClient:0:0:unused:https"))
        lcu = Mock()
        lcu.get.side_effect = lcu_reads
        sleeps = 0

        def sleep(_seconds):
            nonlocal sleeps
            sleeps += 1
            if sleeps == count:
                raise StopPolling()

        with ExitStack() as stack:
            stack.enter_context(patch.object(lcu_bridge, "ROOT", root))
            stack.enter_context(patch.object(lcu_bridge, "find_lockfile", return_value=lock))
            stack.enter_context(patch.object(lcu_bridge, "LCU", return_value=lcu))
            # Testing the poll/POST state machine, not the separately defined
            # LCU-to-draft conversion; the draft is real recorded evidence.
            stack.enter_context(patch.object(lcu_bridge, "extract_draft", side_effect=lambda _: dict(DRAFT)))
            post = stack.enter_context(patch.object(lcu_bridge, "post_draft", side_effect=post_results))
            stack.enter_context(patch.object(lcu_bridge.time, "sleep", side_effect=sleep))
            stack.enter_context(patch("builtins.print"))
            with self.assertRaises(StopPolling):
                lcu_bridge.main()
        return lcu, post

    def test_failed_close_is_retried_without_terminating_or_resetting_lcu(self):
        lcu, post = self.run_until_sleeps(
            [DRAFT, LookupError(), LookupError()],
            [{"ok": True}, urllib.error.URLError("offline"), {"ok": True}], 3)
        self.assertEqual([call.args[2]["active"] for call in post.call_args_list],
                         [True, False, False])
        lcu.close.assert_not_called()

    def test_failed_active_sync_retries_unchanged_state_without_resetting_lcu(self):
        lcu, post = self.run_until_sleeps(
            [DRAFT, DRAFT], [urllib.error.URLError("offline"), {"ok": True}], 2)
        self.assertEqual(post.call_count, 2)
        self.assertEqual(post.call_args_list[0].args[2], post.call_args_list[1].args[2])
        lcu.close.assert_not_called()

    def test_invalid_remote_response_and_http_transport_errors_are_retryable(self):
        for result in ([], {}, {"ok": False}, ValueError("invalid JSON"), http.client.BadStatusLine("")):
            with self.subTest(result=type(result).__name__):
                with patch.object(lcu_bridge, "post_draft", side_effect=[result]), patch("builtins.print"):
                    self.assertIsNone(lcu_bridge.sync_draft(None, None, DRAFT))


if __name__ == "__main__":
    unittest.main()
