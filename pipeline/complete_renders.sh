#!/usr/bin/env bash
# Bucket B remediation: re-render missing FASHN angles (idempotency skips the
# completed ones), then resync the Shopify gallery from TRYON. SKUs ordered
# cheapest-first (fewest missing angles) so we complete the most before the
# ~340-credit budget runs out. Stops gracefully on OutOfCredits per the
# patched runner; final summary lists what completed vs what's left.
#
# Excludes the 3 zero-TRYON SKUs (PRD-003/018/SEP-JKT-004) — those need a
# Stage 1 PROCESSED re-check first, handled separately.
set -uo pipefail
cd "$(dirname "$0")"
source ./.env
source ./.venv/bin/activate
export DREVI_FASHN_POLL_TIMEOUT_SEC=300

ts() { date '+%Y-%m-%d %H:%M:%S'; }
bal() { python3 -c "import os,requests;print(requests.get('https://api.fashn.ai/v1/credits',headers={'Authorization':'Bearer '+os.environ['FASHN_API_KEY']},timeout=20).json().get('credits',{}).get('total','?'))" 2>/dev/null; }

# cheapest-first: need-1, need-2, need-3, need-4, need-5
SKUS=(
  DD-IWS-DHT-001 DD-IWS-DHT-003 DD-LEH-FLR-010 DD-LEH-FLR-014 DD-LEH-MRM-003 DD-LEH-MRM-008 DD-SUT-PLZ-008
  DD-IWS-JKT-008 DD-LEH-MRM-010 DD-SAR-PRD-004 DD-SAR-PRD-006
  DD-IWS-JKT-003 DD-LEH-FLR-020
  DD-SAR-PRD-015 DD-SAR-PRD-021 DD-SAR-PRD-029
  DD-SAR-PRD-014 DD-SAR-PRD-017
)

echo "[$(ts)] complete_renders START (pid $$) | FASHN balance=$(bal)"
done_ok=(); left=()
for sku in "${SKUS[@]}"; do
  b=$(bal)
  echo "[$(ts)] === $sku === (balance=$b)"
  if [ "$b" != "?" ] && [ "$b" -lt 6 ] 2>/dev/null; then
    echo "[$(ts)]   balance < 6 cr — stopping; remaining SKUs left for top-up"
    left+=("$sku"); continue
  fi
  echo "[$(ts)]   fashn --force"
  python 03_fashn_runner.py --sku "$sku" --force 2>&1 \
    | grep -E "OK \(\+|SKIP|FAIL|DONE.*processed|finalised|OutOfCredits|did not complete" | tail -10 || true
  echo "[$(ts)]   refresh shopify gallery"
  python refresh_product_images.py --sku "$sku" 2>&1 \
    | grep -E "TRYON has|uploaded|cleared|skip|failed" | tail -6 || true
  done_ok+=("$sku")
done

echo
echo "================ COMPLETE_RENDERS SUMMARY ================"
echo "  processed (${#done_ok[@]}): ${done_ok[*]:-none}"
echo "  skipped-low-credit (${#left[@]}): ${left[*]:-none}"
echo "  final FASHN balance: $(bal)"
echo "=========================================================="
echo "[$(ts)] COMPLETE_RENDERS_DONE"
