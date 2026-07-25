#!/usr/bin/env python3
"""
refresh_product_images.py --sku DD-XXX-...
Resync an EXISTING Shopify product's image gallery from its TRYON folder:
deletes all current product images, re-uploads every TRYON image in canonical
order. Used after a FASHN re-render fills in missing angles. Idempotent and
safe to re-run (gallery always ends up == TRYON contents).

Does nothing if the SKU has no shopify_product_id on the sheet (not drafted).
"""
from __future__ import annotations
import argparse, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from drevi_common import (
    get_sheets_client, get_master_ws, load_master_schema, read_master_rows,
    get_drive_service, setup_logger, LOCAL_LOGS,
)
from test_shopify_draft import (
    fetch_admin_token, shopify_session, shopify_url,
    get_tryon_images, upload_image_to_shopify,
)


def b4(s: str) -> str:
    p = (s or "").upper().split("-")
    return "-".join(p[:4]) if len(p) >= 4 else s


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sku", required=True)
    args = ap.parse_args()
    log = setup_logger("drevi.imgrefresh", LOCAL_LOGS / "refresh_images.log")

    store = os.environ["SHOPIFY_STORE_DOMAIN"].strip()
    ver   = os.environ.get("SHOPIFY_API_VERSION", "2024-10").strip()

    ws = get_master_ws(get_sheets_client()); schema = load_master_schema(ws)
    rows = read_master_rows(ws, schema)
    sibs = [r for r in rows if b4(r.get("drevi_sku") or "") == args.sku.upper()]
    if not sibs:
        log.error("no rows for %s", args.sku); return 1
    first = sibs[0]
    pid = (first.get("shopify_product_id") or "").strip()
    turl = (first.get("output_folder_url") or "").strip()
    if not pid:
        log.warning("%s has no shopify_product_id — not drafted; skip", args.sku)
        return 0
    if not turl:
        log.warning("%s has no output_folder_url; skip", args.sku); return 0

    tok = fetch_admin_token(store, os.environ["SHOPIFY_CLIENT_ID"].strip(),
                            os.environ["SHOPIFY_CLIENT_SECRET"].strip(), log)
    s = shopify_session(tok)
    drive = get_drive_service()

    # 1. fetch TRYON images
    try:
        imgs = get_tryon_images(drive, turl, log)
    except Exception as e:
        log.error("%s tryon fetch failed: %s", args.sku, e); return 1
    log.info("%s: TRYON has %d images", args.sku, len(imgs))
    if not imgs:
        log.warning("%s: TRYON empty — nothing to upload (render still failed)", args.sku)
        return 0

    # 2. delete existing product images
    r = s.get(shopify_url(store, ver, f"products/{pid}.json?fields=id,images"), timeout=30)
    existing = r.json().get("product", {}).get("images", [])
    for im in existing:
        try:
            s.delete(shopify_url(store, ver, f"products/{pid}/images/{im['id']}.json"), timeout=30)
        except Exception as e:
            log.warning("  delete image %s failed: %s", im.get("id"), e)
    log.info("%s: cleared %d existing images", args.sku, len(existing))

    # 3. upload all TRYON images in canonical order
    up = 0
    for i, (name, content) in enumerate(imgs, start=1):
        try:
            upload_image_to_shopify(s, store, ver, int(pid), name, content, position=i, log=log)
            up += 1
        except Exception as e:
            log.warning("  upload %s failed: %s", name, e)
    log.info("%s: uploaded %d/%d images to product %s", args.sku, up, len(imgs), pid)
    return 0


if __name__ == "__main__":
    sys.exit(main())
