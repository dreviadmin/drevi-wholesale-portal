#!/usr/bin/env bash
# Watchdog: kills any 03_fashn_runner.py or test_shopify_draft.py that's been
# running > 30 min (per-SKU upper bound — normal is 5-10 min). Prevents a
# single hung SKU from wedging the batch for hours (as PRD-002 just did).
# Exits cleanly when the autorun chain completes.
set -uo pipefail
CHAIN_LOG="$HOME/drevi/logs/autorun_chain.log"
TIMEOUT_SEC="${WATCHDOG_TIMEOUT_SEC:-1800}"   # 30 min
POLL_SEC="${WATCHDOG_POLL_SEC:-300}"          # check every 5 min

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# Convert ps etime ("MM:SS", "HH:MM:SS", "D-HH:MM:SS") to seconds
to_sec() {
  awk -F'[:-]' '{
    if (NF==2) { print $1*60 + $2 }
    else if (NF==3) { print $1*3600 + $2*60 + $3 }
    else if (NF==4) { print $1*86400 + $2*3600 + $3*60 + $4 }
    else { print 0 }
  }'
}

echo "[$(ts)] watchdog START (pid $$, timeout=${TIMEOUT_SEC}s, poll=${POLL_SEC}s)"
while true; do
  if grep -q "AUTORUN_CHAIN COMPLETE" "$CHAIN_LOG" 2>/dev/null; then
    echo "[$(ts)] chain complete — watchdog exiting"
    exit 0
  fi
  for p in $(pgrep -f "03_fashn_runner.py|test_shopify_draft.py" 2>/dev/null); do
    et=$(ps -o etime= -p "$p" 2>/dev/null | tr -d ' ')
    [ -z "$et" ] && continue
    sec=$(echo "$et" | to_sec)
    if [ -n "$sec" ] && [ "$sec" -gt "$TIMEOUT_SEC" ] 2>/dev/null; then
      cmd=$(ps -o command= -p "$p" 2>/dev/null | cut -c1-140)
      echo "[$(ts)] KILL pid=$p elapsed=${et} (>${TIMEOUT_SEC}s) :: $cmd"
      kill "$p" 2>/dev/null && sleep 3 && kill -9 "$p" 2>/dev/null || true
    fi
  done
  sleep "$POLL_SEC"
done
