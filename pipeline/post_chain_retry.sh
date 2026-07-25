#!/usr/bin/env bash
# Runs after the autorun_chain marker fires. Identifies any batch SKU NOT
# already at 'Shopify Draft Created' (e.g. PRD-002 hang victim, FASHN-credit-
# exhausted stragglers, any other failures), retries fashn + shopify once
# for each. Both stages are idempotent (fashn skips existing angles, shopify
# skips already-drafted SKUs) — re-running is safe.
#
# Writes a POST_CHAIN_DONE marker so the agent's watcher fires when truly
# everything has been attempted.
set -uo pipefail
cd "$(dirname "$0")"
source ./.env
source ./.venv/bin/activate

CHAIN_LOG="$HOME/drevi/logs/autorun_chain.log"
export DREVI_FASHN_POLL_TIMEOUT_SEC="${DREVI_FASHN_POLL_TIMEOUT_SEC:-300}"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
echo "[$(ts)] post_chain_retry START (pid $$)"

# 1. Wait for chain completion (max 12h to allow for the long fashn loop)
echo "[$(ts)] waiting for AUTORUN_CHAIN COMPLETE marker..."
waited=0
until grep -q "AUTORUN_CHAIN COMPLETE" "$CHAIN_LOG" 2>/dev/null; do
  sleep 60
  waited=$((waited+60))
  if [ "$waited" -ge 43200 ]; then
    echo "[$(ts)] ERROR: chain did not complete within 12h — aborting"
    exit 1
  fi
done
echo "[$(ts)] chain complete. Querying sheet for stragglers..."

# 2. Pull any batch base SKU whose photo_status isn't 'Shopify Draft Created'.
STRAGGLERS=$(python3 - <<'PY' 2>/dev/null
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
        if ps != 'Shopify Draft Created':
            seen.add(b); print(b, ps, sep='|')
PY
)

if [ -z "$STRAGGLERS" ]; then
  echo "[$(ts)] no stragglers — all 45 drafted. POST_CHAIN_DONE"
  exit 0
fi
n=$(echo "$STRAGGLERS" | wc -l | tr -d ' ')
echo "[$(ts)] $n stragglers identified:"
echo "$STRAGGLERS"
echo

# 3. Retry each: fashn (idempotent skip on completed angles) + shopify
#    (idempotent skip if already drafted). Per-SKU isolation: || true.
while IFS='|' read -r sku ps; do
  [ -z "$sku" ] && continue
  echo "[$(ts)] === $sku (was: $ps) ==="
  # Skip fashn if already past Tryon Done (only shopify needed)
  case "$ps" in
    "Tryon Done")
      echo "[$(ts)]   skipping fashn (already Tryon Done), going straight to shopify"
      ;;
    *)
      echo "[$(ts)]   fashn retry"
      python 03_fashn_runner.py --sku "$sku" --force 2>&1 \
        | grep -E "Brand Model|---- DD|OK \(\+|SKIP|FAIL|DONE|finalised|OutOfCredits|Connection|timed out" \
        | tail -15 || true
      ;;
  esac
  echo "[$(ts)]   shopify retry"
  python test_shopify_draft.py --sku "$sku" 2>&1 \
    | grep -E "Created product|SKIP|Admin URL|DONE|error|fail" \
    | tail -5 || true
done <<< "$STRAGGLERS"

echo "[$(ts)] POST_CHAIN_DONE"
