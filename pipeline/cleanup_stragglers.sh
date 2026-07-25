#!/usr/bin/env bash
# Final cleanup for the 5 stragglers from the 45-SKU batch. Uses the patched
# poll_status() (60s timeout + retry on transient FASHN errors) and the
# idempotency in test_shopify_draft.py (already-drafted SKUs skip).
set -uo pipefail
cd "$(dirname "$0")"
source ./.env
source ./.venv/bin/activate
export DREVI_FASHN_POLL_TIMEOUT_SEC=300

ts() { date '+%Y-%m-%d %H:%M:%S'; }
echo "[$(ts)] cleanup_stragglers START (pid $$)"

STRAGGLERS=(DD-IWS-DHT-001 DD-LEH-FLR-007 DD-SAR-PRD-002 DD-SAR-PRD-006 DD-SAR-PRD-030)

ok=(); fail=()
for sku in "${STRAGGLERS[@]}"; do
  echo "[$(ts)] === $sku ==="
  echo "[$(ts)]   fashn retry"
  python 03_fashn_runner.py --sku "$sku" --force 2>&1 \
    | grep -E "Brand Model|---- DD|OK \(\+|SKIP|FAIL|DONE.*processed|finalised|OutOfCredits|Connection|timed out|Submitting" \
    | tail -15 || true
  echo "[$(ts)]   shopify retry"
  if python test_shopify_draft.py --sku "$sku" 2>&1 \
      | grep -E "Created product|SKIP|Admin URL|DONE — draft|error|fail" \
      | tail -5; then
    # Check if drafted by querying sheet
    drafted=$(python3 -c "
import sys; sys.path.insert(0,'.')
from drevi_common import (get_sheets_client,get_master_ws,
    load_master_schema,read_master_rows)
ws=get_master_ws(get_sheets_client()); s=load_master_schema(ws)
def b4(x):
    p=(x or '').upper().split('-'); return '-'.join(p[:4]) if len(p)>=4 else x
for r in read_master_rows(ws,s):
    if b4(r.get('drevi_sku') or '')=='$sku' and (r.get('shopify_product_id') or '').strip():
        print('Y'); break
" 2>/dev/null | head -1)
    if [ "$drafted" = "Y" ]; then ok+=("$sku"); else fail+=("$sku"); fi
  else
    fail+=("$sku")
  fi
done

echo
echo "================ CLEANUP SUMMARY ================"
echo "  OK   (${#ok[@]}): ${ok[*]:-none}"
echo "  FAIL (${#fail[@]}): ${fail[*]:-none}"
echo "================================================="
echo "[$(ts)] CLEANUP_DONE"
