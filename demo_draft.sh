#!/bin/bash
# Plays a ~90s simulated champ select against the live worker, paced and
# ordered like a real flex draft: all bans land at once, then picks snake
# 1-2-2-2-2-1 (blue side = us, picking first).
#
# Setup: open the Comp Builder with Draft mode ON at
#   http://localhost:8788/?squad=gimly,secondcoming,smashbrother,lego1900,bigbellybobby
# start a screen recording (Cmd+Shift+5), then run:  bash demo_draft.sh
# The board fills and re-optimizes itself as the draft unfolds — don't touch it.
#
# Story: Viego ban forces a jungle re-optimize; enemy taking Shen forces a
# top-lane re-optimize; our locks pin roles as the optimizer keeps adapting.
cd "$(dirname "$0")"
TOKEN=$(python3 -c "import json; print(json.load(open('config.json'))['admin_token'])")
WORKER=$(python3 -c "import json; print(json.load(open('config.json'))['worker_url'].rstrip('/'))")

post() {
  curl -sS -o /dev/null -X POST "$WORKER/draft" \
    -H "content-type: application/json" -H "x-admin-token: $TOKEN" -d "$1"
  echo "$2"
}

BANS='[122, 234, 238, 53, 25, 24, 58, 17, 35, 777]'   # theirs: Darius Viego Zed Blitz Morgana · ours: Jax Renekton Teemo Shaco Yone

post '{"active": false}' "reset — start your recording, sim begins in 5s"
sleep 5

post '{"active": true, "bans": [], "enemy": [], "ours": []}' "champ select started — board auto-fills"
sleep 6
post "{\"active\": true, \"bans\": $BANS, \"enemy\": [], \"ours\": []}" "all 10 bans land (Viego banned -> jungle re-optimizes)"
sleep 8

post "{\"active\": true, \"bans\": $BANS, \"enemy\": [], \"ours\":
  [{\"championId\": 74, \"position\": \"MIDDLE\"}]}" "B1: we lock Heimerdinger mid"
sleep 6
post "{\"active\": true, \"bans\": $BANS, \"enemy\": [893, 51], \"ours\":
  [{\"championId\": 74, \"position\": \"MIDDLE\"}]}" "R1+R2: enemy picks Aurora, Caitlyn"
sleep 7
post "{\"active\": true, \"bans\": $BANS, \"enemy\": [893, 51], \"ours\":
  [{\"championId\": 74, \"position\": \"MIDDLE\"},
   {\"championId\": 18, \"position\": \"BOTTOM\"},
   {\"championId\": 412, \"position\": \"UTILITY\"}]}" "B2+B3: we lock Tristana bot, Thresh support"
sleep 7
post "{\"active\": true, \"bans\": $BANS, \"enemy\": [893, 51, 98, 89], \"ours\":
  [{\"championId\": 74, \"position\": \"MIDDLE\"},
   {\"championId\": 18, \"position\": \"BOTTOM\"},
   {\"championId\": 412, \"position\": \"UTILITY\"}]}" "R3+R4: enemy takes Shen (!), Leona -> top re-optimizes"
sleep 8
post "{\"active\": true, \"bans\": $BANS, \"enemy\": [893, 51, 98, 89], \"ours\":
  [{\"championId\": 74, \"position\": \"MIDDLE\"},
   {\"championId\": 18, \"position\": \"BOTTOM\"},
   {\"championId\": 412, \"position\": \"UTILITY\"},
   {\"championId\": 54, \"position\": \"TOP\"},
   {\"championId\": 131, \"position\": \"JUNGLE\"}]}" "B4+B5: we lock Malphite top, Diana jungle"
sleep 7
post "{\"active\": true, \"bans\": $BANS, \"enemy\": [893, 51, 98, 89, 887], \"ours\":
  [{\"championId\": 74, \"position\": \"MIDDLE\"},
   {\"championId\": 18, \"position\": \"BOTTOM\"},
   {\"championId\": 412, \"position\": \"UTILITY\"},
   {\"championId\": 54, \"position\": \"TOP\"},
   {\"championId\": 131, \"position\": \"JUNGLE\"}]}" "R5: enemy completes with Gwen (5/5)"
sleep 8

post '{"active": false}' "champ select ended — board kept; stop recording"
