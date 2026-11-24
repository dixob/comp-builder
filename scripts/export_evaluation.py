#!/usr/bin/env python3
"""Download automatically captured predictions and their real match evidence."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlencode, urlparse


def export(worker_url, token, output):
    if urlparse(worker_url).scheme != "https" or not token or any(c in token for c in "\r\n"):
        raise ValueError("an HTTPS worker URL and admin token are required")
    records, matches, collection, seen = {}, {}, {}, set()
    cursor = None
    while True:
        url = worker_url.rstrip("/") + "/evaluation"
        if cursor:
            url += "?" + urlencode({"cursor": cursor})
        # Keep credentials out of process arguments, logs, and output files.
        result = subprocess.run(
            ["curl", "-fsS", "--proto", "=https", "--max-time", "60", "--header", "@-", url],
            input="x-admin-token: " + token + "\n", text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError("evaluation download failed; check worker URL and admin token")
        page = json.loads(result.stdout)
        if page.get("schemaVersion") != 1:
            raise ValueError("unsupported evaluation export")
        for record in page["records"]:
            records[record["id"]] = record
        for match in page["matches"]:
            match_id = match["metadata"]["matchId"]
            if not re.fullmatch(r"[A-Za-z0-9_-]+", match_id):
                raise ValueError("invalid match ID in export")
            matches[match_id] = match
        for row in page["collection"]:
            collection[row["id"]] = row
        cursor = page.get("nextCursor")
        if not cursor:
            break
        if cursor in seen:
            raise ValueError("repeated export cursor")
        seen.add(cursor)
    output = Path(output)
    (output / "matches").mkdir(parents=True, exist_ok=True)
    (output / "records.json").write_text(json.dumps({"schemaVersion": 1, "records": list(records.values())}, indent=2))
    (output / "collection.json").write_text(json.dumps(list(collection.values()), indent=2))
    for match_id, match in matches.items():
        (output / "matches" / (match_id + ".json")).write_text(json.dumps(match))
    return len(records), len(matches)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path(__file__).resolve().parents[1] / "config.json")
    parser.add_argument("--output", type=Path, default=Path("evaluation-output"))
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    count, matches = export(config.get("worker_url", ""),
                            os.environ.get("COMPY_ADMIN_TOKEN") or config.get("admin_token"), args.output)
    print(f"Exported {count} pregame records and {matches} candidate match outcomes to {args.output}")


if __name__ == "__main__":
    main()
