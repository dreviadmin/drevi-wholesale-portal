#!/usr/bin/env bash
# Rolling vision drainer — re-runs vision_wholesale every 20 min while Arushi
# uploads photos into the new INPUT. Idempotent: named designs skip, so each
# pass only pays for newly-arrived photos. Stops after 18 passes (~6h) or when
# /tmp/stop_vision_drainer exists.
set -uo pipefail
cd "$(dirname "$0")"
source ./.env
source ./.venv/bin/activate
ts() { date '+%H:%M:%S'; }
for i in $(seq 1 18); do
  [ -f /tmp/stop_vision_drainer ] && { echo "[$(ts)] stop file — exiting"; break; }
  echo "[$(ts)] === drainer pass $i ==="
  python vision_wholesale.py 2>&1 | grep -E "DONE \| named=|sibling-match.*->" | tail -5
  [ "$i" -lt 18 ] && sleep 1200
done
echo "[$(ts)] VISION_DRAINER_DONE"
