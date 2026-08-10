#!/usr/bin/env python3
"""Relay live champ-select state from the League client to the Comp Builder.

Run this on the machine where League is open (before or during champ select):

    python3 lcu_bridge.py

It finds the client's lockfile, polls the champ-select session a few times a
second, and POSTs bans + picks to the Cloudflare worker whenever they change.
With Draft mode on, the web page polls the worker and updates itself — bans
and enemy picks drop out of candidate lists as they happen.

Reads worker_url + admin_token from config.json (same directory); no
third-party dependencies. The LCU API only listens on 127.0.0.1, so this must
run locally — the web page cannot reach the client directly.
"""
import base64
import http.client
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent

LOCKFILE_CANDIDATES = [
    Path("/Applications/League of Legends.app/Contents/LoL/lockfile"),
    Path.home() / "Applications/League of Legends.app/Contents/LoL/lockfile",
    Path("C:/Riot Games/League of Legends/lockfile"),
]

# Localhost polling at 2 Hz on a kept-alive connection: the stdlib has no
# WebSocket client, and half a second of detection latency matches what an
# LCU event subscription would buy without adding a dependency.
POLL_S = 0.5        # champ-select poll cadence
SESSION_WAIT_S = 3  # cadence while waiting for a champ select to start

# The client's TLS cert is self-signed — that's expected for the LCU API.
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE


def find_lockfile():
    for p in LOCKFILE_CANDIDATES:
        if p.exists():
            return p
    return None


class LCU:
    """Tiny keep-alive client for the local League API."""

    def __init__(self, port, password):
        self.port = int(port)
        self.auth = "Basic " + base64.b64encode(f"riot:{password}".encode()).decode()
        self.conn = None

    def get(self, path):
        if self.conn is None:
            self.conn = http.client.HTTPSConnection("127.0.0.1", self.port,
                                                    timeout=5, context=SSL_CTX)
        try:
            self.conn.request("GET", path, headers={"Authorization": self.auth})
            r = self.conn.getresponse()
            body = r.read()
        except (http.client.HTTPException, OSError):
            self.close()  # stale keep-alive — caller retries on a fresh socket
            raise
        if r.status == 404:
            raise LookupError(path)
        if r.status >= 400:
            raise RuntimeError(f"LCU {r.status} {path}")
        return json.loads(body)

    def close(self):
        if self.conn is not None:
            try:
                self.conn.close()
            finally:
                self.conn = None


def extract_draft(session):
    """Bans + both teams' picks from a champ-select session payload."""
    bans, enemy, ours = set(), set(), []
    for group in session.get("actions", []):
        for a in group:
            if not a.get("completed") or not a.get("championId"):
                continue
            if a.get("type") == "ban":
                bans.add(a["championId"])
            elif a.get("type") == "pick" and not a.get("isAllyAction"):
                enemy.add(a["championId"])
    for team, sink in (("theirTeam", enemy), ("myTeam", None)):
        for p in session.get(team, []):
            cid = p.get("championId")
            if not cid:
                continue
            if sink is not None:
                sink.add(cid)
            else:
                ours.append({"championId": cid,
                             "position": (p.get("assignedPosition") or "").upper()})
    b = session.get("bans", {})
    bans.update(x for x in b.get("myTeamBans", []) + b.get("theirTeamBans", []) if x)
    return {"active": True, "bans": sorted(bans), "enemy": sorted(enemy), "ours": ours}


def post_draft(worker_url, token, payload):
    req = urllib.request.Request(
        worker_url.rstrip("/") + "/draft",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json", "x-admin-token": token},
        method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def main():
    cfg = json.loads((ROOT / "config.json").read_text())
    worker_url = cfg.get("worker_url")
    token = cfg.get("admin_token")
    if not worker_url or not token:
        sys.exit("config.json needs worker_url and admin_token for the bridge.")

    lock = find_lockfile()
    while not lock:
        print("Waiting for the League client to start...")
        time.sleep(SESSION_WAIT_S)
        lock = find_lockfile()
    _, _, port, password, _ = lock.read_text().split(":")
    lcu = LCU(port, password)
    print(f"Connected to League client on port {port}. Waiting for champ select...")

    last_sent = None
    in_session = False
    while True:
        try:
            session = lcu.get("/lol-champ-select/v1/session")
            payload = extract_draft(session)
            if not in_session:
                print("Champ select started.")
                in_session = True
            if payload != last_sent:
                post_draft(worker_url, token, payload)
                last_sent = payload
                print(f"  synced: {len(payload['bans'])} bans, "
                      f"{len(payload['enemy'])} enemy picks, {len(payload['ours'])} ours")
            time.sleep(POLL_S)
        except LookupError:  # 404 — not in champ select
            if in_session:
                print("Champ select ended.")
                post_draft(worker_url, token, {"active": False})
                in_session = False
                last_sent = None
            time.sleep(SESSION_WAIT_S)
        except RuntimeError as e:
            print(f"{e}, retrying...")
            time.sleep(POLL_S)
        except (urllib.error.URLError, OSError):
            print("League client gone; waiting for it to come back...")
            lcu.close()
            in_session = False
            last_sent = None
            time.sleep(SESSION_WAIT_S)
            lock = find_lockfile()
            if lock:
                _, _, port, password, _ = lock.read_text().split(":")
                lcu = LCU(port, password)


if __name__ == "__main__":
    main()
