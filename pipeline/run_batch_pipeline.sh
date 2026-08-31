#!/usr/bin/env bash
# =============================================================================
# Drevi batch pipeline rerun — 35 SKUs (the 3 already-complete excluded:
#   DD-SAR-PRD-001, DD-LEH-FLR-005, DD-LEH-FLR-004)
#
# STAGED ON PURPOSE. Run the phases in order. Stages 1-2 are cheap; Stage 3
# is the expensive FASHN step (~30 credits/SKU → ~1000+ for the full batch);
# Stage 4 is free. Each SKU is isolated with `|| true` so one failure never
# aborts the run — a summary prints at the end of every phase.
#
# Usage:
#   cd /Users/anshsarawagi/Documents/drevi/pipeline/scripts
#   source .env && source .venv/bin/activate
#   ./run_batch_pipeline.sh prep      # Stage 1+2 for all (cheap)
#   ./run_batch_pipeline.sh fashn     # Stage 3 for all (BIG credit spend)
#   ./run_batch_pipeline.sh shopify   # Stage 4 for all (free)
#   ./run_batch_pipeline.sh status    # show photo_status for the batch
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")"

# Original 35 + 10 newly-added (Arushi uploaded photos for these too).
# If SKUS_OVERRIDE is set (space-separated), it replaces this list — used by
# the orchestrator to run prep on just the newly-added subset.
DEFAULT_SKUS=(
  DD-SAR-PRD-005 DD-IWS-DHT-002 DD-IWS-DHT-003 DD-IWS-DHT-006 DD-IWS-DHT-007
  DD-IWS-DHT-010 DD-IWS-JKT-002 DD-IWS-JKT-003 DD-LEH-FLR-001 DD-LEH-FLR-006
  DD-LEH-FLR-007 DD-LEH-FLR-009 DD-LEH-FLR-010 DD-LEH-FLR-011 DD-LEH-FLR-014
  DD-LEH-FRL-015 DD-LEH-FRL-021 DD-LEH-MRM-003 DD-LEH-MRM-007 DD-LEH-MRM-009
  DD-LEH-FLR-020 DD-SAR-PRD-002 DD-SAR-PRD-003 DD-SAR-PRD-006 DD-SAR-PRD-011
  DD-SAR-PRD-013 DD-SAR-PRD-014 DD-SAR-PRD-015 DD-SAR-PRD-017 DD-SAR-PRD-018
  DD-SAR-PRD-021 DD-SAR-PRD-029 DD-SAR-PRD-030 DD-SAR-RFL-001 DD-SEP-JKT-004
  # ----- added later (10 new SKUs with INPUT folders ready) -----
  DD-IWS-DHT-001 DD-IWS-JKT-008 DD-IWS-PNT-003 DD-LEH-FLR-023 DD-LEH-FLR-029
  DD-LEH-MRM-008 DD-LEH-MRM-010 DD-SAR-PRD-004 DD-SUT-PLZ-008 DD-SUT-PLZ-012
)
if [ -n "${SKUS_OVERRIDE:-}" ]; then
  read -r -a SKUS <<< "$SKUS_OVERRIDE"
else
  SKUS=("${DEFAULT_SKUS[@]}")
fi

export DREVI_FASHN_POLL_TIMEOUT_SEC="${DREVI_FASHN_POLL_TIMEOUT_SEC:-300}"

phase="${1:-}"
ok=(); fail=()

run_one() {  # $1=script  $2..=args (last arg = sku for logging)
  local sku="${@: -1}"
  if python "$@"; then ok+=("$sku"); else fail+=("$sku"); fi
}

summary() {
  echo; echo "================ PHASE '$phase' SUMMARY ================"
  echo "  OK   (${#ok[@]}): ${ok[*]:-none}"
  echo "  FAIL (${#fail[@]}): ${fail[*]:-none}"
  echo "======================================================="
}

case "$phase" in
  prep)
    for s in "${SKUS[@]}"; do
      echo "### [$s] Stage 1 preprocess"
      python 01_preprocess.py --sku "$s" --force || true
      echo "### [$s] Stage 2 vision"
      run_one 02_vision_analyze.py --sku "$s" --force
    done
    summary ;;

  fashn)
    echo ">>> FASHN credit pre-check (each SKU ≈ 26-32 credits, ${#SKUS[@]} SKUs):"
    python - <<'PY'
import os,requests
k=os.environ["FASHN_API_KEY"]
r=requests.get("https://api.fashn.ai/v1/credits",headers={"Authorization":f"Bearer {k}"},timeout=20)
print("  balance:",r.json())
PY
    if [ "${BATCH_AUTO:-0}" = "1" ]; then
      echo ">>> BATCH_AUTO=1 — proceeding with Stage 3 unattended (no prompt)."
    else
      read -r -p ">>> Continue with Stage 3 for ${#SKUS[@]} SKUs? [y/N] " a
      [ "$a" = "y" ] || { echo "aborted"; exit 0; }
    fi
    # These had stale/partial TRYON output from earlier aborted runs (sheet
    # cleared but Drive images remained). Force a full re-render so they pick
    # up the new poses; upload_file_to_drive replaces same-named files in
    # place (no duplicates). Everything else uses plain --force, which stays
    # cheaply resumable (completed angles SKIP on a re-run).
    REGEN_SKUS=" DD-IWS-DHT-006 DD-IWS-DHT-010 "
    for s in "${SKUS[@]}"; do
      if [[ "$REGEN_SKUS" == *" $s "* ]]; then
        echo "### [$s] Stage 3 FASHN (--regenerate: stale TRYON)"
        run_one 03_fashn_runner.py --sku "$s" --force --regenerate
      else
        echo "### [$s] Stage 3 FASHN"
        run_one 03_fashn_runner.py --sku "$s" --force
      fi
    done
    summary ;;

  shopify)
    for s in "${SKUS[@]}"; do
      echo "### [$s] Stage 4 Shopify draft"
      run_one test_shopify_draft.py --sku "$s"
    done
    summary ;;

  status)
    python - <<'PY'
import sys; sys.path.insert(0,'.')
from drevi_common import (get_sheets_client,get_master_ws,load_master_schema,read_master_rows)
ws=get_master_ws(get_sheets_client()); s=load_master_schema(ws)
import collections
SK=set("""DD-SAR-PRD-005 DD-IWS-DHT-002 DD-IWS-DHT-003 DD-IWS-DHT-006 DD-IWS-DHT-007 DD-IWS-DHT-010 DD-IWS-JKT-002 DD-IWS-JKT-003 DD-LEH-FLR-001 DD-LEH-FLR-006 DD-LEH-FLR-007 DD-LEH-FLR-009 DD-LEH-FLR-010 DD-LEH-FLR-011 DD-LEH-FLR-014 DD-LEH-FRL-015 DD-LEH-FRL-021 DD-LEH-MRM-003 DD-LEH-MRM-007 DD-LEH-MRM-009 DD-LEH-FLR-020 DD-SAR-PRD-002 DD-SAR-PRD-003 DD-SAR-PRD-006 DD-SAR-PRD-011 DD-SAR-PRD-013 DD-SAR-PRD-014 DD-SAR-PRD-015 DD-SAR-PRD-017 DD-SAR-PRD-018 DD-SAR-PRD-021 DD-SAR-PRD-029 DD-SAR-PRD-030 DD-SAR-RFL-001 DD-SEP-JKT-004""".split())
def b4(x):
    p=(x or '').upper().split('-'); return '-'.join(p[:4]) if len(p)>=4 else x
c=collections.Counter()
for r in read_master_rows(ws,s):
    if b4(r.get('drevi_sku')) in SK: c[(b4(r.get('drevi_sku')),r.get('photo_status') or '(blank)')]+=1
for (sku,st),n in sorted(c.items()): print(f"  {sku:20s} {st}")
PY
    ;;

  *)
    echo "usage: ./run_batch_pipeline.sh {prep|fashn|shopify|status}"; exit 1 ;;
esac
