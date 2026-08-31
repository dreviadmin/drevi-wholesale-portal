#!/usr/bin/env bash
# Rolling Shopify drainer — every 20 min, drafts any batch SKUs that have
# reached Tryon Done but don't yet have a shopify_product_id. Lets drafts
# trickle out as FASHN renders them instead of waiting for the whole batch.
#
# Exits cleanly when:
#   - the orchestrator is about to start its own shopify phase (avoids the
#     race window where both processes draft the same SKU), OR
#   - the chain has completed.
#
# Idempotency in test_shopify_draft.py guarantees no duplicate drafts even
# if a SKU somehow gets touched twice — but the exit-on-orchestrator-takeover
# is the primary safeguard.
#
# Launch:
#   cd /Users/anshsarawagi/Documents/drevi/pipeline/scripts
#   nohup ./shopify_drainer.sh > ~/drevi/logs/shopify_drainer.log 2>&1 &
set -uo pipefail
cd "$(dirname "$0")"
source ./.env
source ./.venv/bin/activate

CHAIN_LOG="$HOME/drevi/logs/autorun_chain.log"
INTERVAL="${DRAINER_INTERVAL_SEC:-1200}"  # 20 min default

ts() { date '+%Y-%m-%d %H:%M:%S'; }
echo "[$(ts)] drainer START (pid $$, interval ${INTERVAL}s)"

iteration=0
while true; do
  iteration=$((iteration+1))

  # 1. Hand-off check: if orchestrator is launching/done its own shopify, exit.
  if grep -q "launching shopify phase\|AUTORUN_CHAIN COMPLETE" "$CHAIN_LOG" 2>/dev/null; then
    echo "[$(ts)] orchestrator's shopify phase detected — drainer exiting cleanly"
    exit 0
  fi

  # 2. Query sheet for batch SKUs at Tryon Done WITHOUT shopify_product_id.
  READY=$(python3 - <<'PY' 2>/dev/null
import sys; sys.path.insert(0,'.')
from drevi_common import (get_sheets_client,get_master_ws,
    load_master_schema,read_master_rows)
BATCH=set("""DD-SAR-PRD-005 DD-IWS-DHT-002 DD-IWS-DHT-003 DD-IWS-DHT-006 DD-IWS-DHT-007 DD-IWS-DHT-010 DD-IWS-JKT-002 DD-IWS-JKT-003 DD-LEH-FLR-001 DD-LEH-FLR-006 DD-LEH-FLR-007 DD-LEH-FLR-009 DD-LEH-FLR-010 DD-LEH-FLR-011 DD-LEH-FLR-014 DD-LEH-FRL-015 DD-LEH-FRL-021 DD-LEH-MRM-003 DD-LEH-MRM-007 DD-LEH-MRM-009 DD-LEH-FLR-020 DD-SAR-PRD-002 DD-SAR-PRD-003 DD-SAR-PRD-006 DD-SAR-PRD-011 DD-SAR-PRD-013 DD-SAR-PRD-014 DD-SAR-PRD-015 DD-SAR-PRD-017 DD-SAR-PRD-018 DD-SAR-PRD-021 DD-SAR-PRD-029 DD-SAR-PRD-030 DD-SAR-RFL-001 DD-SEP-JKT-004 DD-IWS-DHT-001 DD-IWS-JKT-008 DD-IWS-PNT-003 DD-LEH-FLR-023 DD-LEH-FLR-029 DD-LEH-MRM-008 DD-LEH-MRM-010 DD-SAR-PRD-004 DD-SUT-PLZ-008 DD-SUT-PLZ-012""".split())
def b4(s):
    p=(s or '').upper().split('-'); return '-'.join(p[:4]) if len(p)>=4 else s
ws=get_master_ws(get_sheets_client()); schema=load_master_schema(ws)
seen=set()
for r in read_master_rows(ws,schema):
    b=b4(r.get('drevi_sku') or '')
    if b in BATCH and b not in seen:
        ps=(r.get('photo_status') or '').strip()
        sid=(r.get('shopify_product_id') or '').strip()
        if ps=='Tryon Done' and not sid:
            seen.add(b); print(b)
PY
)

  if [ -n "$READY" ]; then
    n=$(echo "$READY" | wc -l | tr -d ' ')
    echo "[$(ts)] iter#$iteration — drafting $n SKUs: $(echo $READY | tr '\n' ' ')"
    for s in $READY; do
      echo "[$(ts)]   -> $s"
      python test_shopify_draft.py --sku "$s" 2>&1 | grep -E "Created product|SKIP|DONE|error|fail" | head -5 || true
    done
  else
    echo "[$(ts)] iter#$iteration — no new Tryon-Done SKUs ready"
  fi

  sleep "$INTERVAL"
done
