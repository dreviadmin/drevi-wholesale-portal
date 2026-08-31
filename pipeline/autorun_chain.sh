#!/usr/bin/env bash
# =============================================================================
# Fully unattended orchestrator: waits for the in-flight `prep` to finish,
# then runs `fashn`, then `shopify` — all in ONE detached process. No agent,
# no human, no watchers required. Survives terminal close (run via nohup).
#
# It does NOT re-run prep (the already-running prep continues); it only waits
# for prep's completion marker, then chains the remaining phases.
#
# Launch:
#   cd /Users/anshsarawagi/Documents/drevi/pipeline/scripts
#   nohup ./autorun_chain.sh > ~/drevi/logs/autorun_chain.log 2>&1 &
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")"

LOGS="$HOME/drevi/logs"
PREP_LOG="$LOGS/batch_prep.log"
FASHN_LOG="$LOGS/batch_fashn.log"
SHOP_LOG="$LOGS/batch_shopify.log"

# Load credentials + venv for this process AND all children.
source ./.env
source ./.venv/bin/activate
export BATCH_AUTO=1
export DREVI_FASHN_POLL_TIMEOUT_SEC="${DREVI_FASHN_POLL_TIMEOUT_SEC:-300}"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
echo "[$(ts)] autorun_chain START (pid $$)"

# ---- 1. Wait for the running prep phase to finish -------------------------
# Bounded wait (max 3h) so a hung prep can't wedge the chain forever.
echo "[$(ts)] waiting for prep completion marker in $PREP_LOG ..."
waited=0
until grep -q "PHASE 'prep' SUMMARY" "$PREP_LOG" 2>/dev/null; do
  sleep 30
  waited=$((waited+30))
  if [ "$waited" -ge 10800 ]; then
    echo "[$(ts)] ERROR: prep did not finish within 3h — aborting chain."
    exit 1
  fi
done
echo "[$(ts)] prep finished. Summary tail:"
grep -A4 "PHASE 'prep' SUMMARY" "$PREP_LOG" | tail -5

# ---- 1b. Follow-on prep for newly-added SKUs (10 not in original batch) --
NEW_SKUS="DD-IWS-DHT-001 DD-IWS-JKT-008 DD-IWS-PNT-003 DD-LEH-FLR-023 DD-LEH-FLR-029 DD-LEH-MRM-008 DD-LEH-MRM-010 DD-SAR-PRD-004 DD-SUT-PLZ-008 DD-SUT-PLZ-012"
NEW_PREP_LOG="$LOGS/batch_prep_addl.log"
echo "[$(ts)] running follow-on prep for 10 newly-added SKUs -> $NEW_PREP_LOG"
SKUS_OVERRIDE="$NEW_SKUS" ./run_batch_pipeline.sh prep > "$NEW_PREP_LOG" 2>&1
echo "[$(ts)] follow-on prep exited ($?). Summary:"
grep -A4 "PHASE 'prep' SUMMARY" "$NEW_PREP_LOG" | tail -5 || true

# ---- 2. FASHN (Stage 3) — unified, all 45 SKUs ---------------------------
echo "[$(ts)] launching fashn phase -> $FASHN_LOG"
./run_batch_pipeline.sh fashn > "$FASHN_LOG" 2>&1
echo "[$(ts)] fashn phase exited ($?). Summary:"
grep -A4 "PHASE 'fashn' SUMMARY" "$FASHN_LOG" | tail -5 || true

# ---- 3. Shopify (Stage 4) -------------------------------------------------
# Runs regardless of partial fashn failures: Stage 4 only drafts SKUs that
# actually have TRYON output + copy, and skips/fails the rest gracefully.
echo "[$(ts)] launching shopify phase -> $SHOP_LOG"
./run_batch_pipeline.sh shopify > "$SHOP_LOG" 2>&1
echo "[$(ts)] shopify phase exited ($?). Summary:"
grep -A4 "PHASE 'shopify' SUMMARY" "$SHOP_LOG" | tail -5 || true

# ---- 4. Final consolidated marker ----------------------------------------
echo "[$(ts)] ===== AUTORUN_CHAIN COMPLETE ====="
echo "PREP:"   ; grep -A3 "PHASE 'prep' SUMMARY"    "$PREP_LOG"  | tail -4
echo "FASHN:"  ; grep -A3 "PHASE 'fashn' SUMMARY"   "$FASHN_LOG" | tail -4
echo "SHOPIFY:"; grep -A3 "PHASE 'shopify' SUMMARY" "$SHOP_LOG"  | tail -4
echo "[$(ts)] DONE."
