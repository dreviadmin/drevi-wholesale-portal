#!/usr/bin/env python3
"""
test_shopify_draft.py
======================
PoC for Stage 4 (Shopify draft creation). Takes one base SKU, reads product
copy + variant data from the Master sheet, downloads catalog images from the
TRYON Drive folder, and creates a DRAFT product on Shopify.

One Shopify product per base_sku. Variants = sizes × colors (cross-product
of all sibling rows for that base SKU). Vendor = "Drevi" (hardcoded).

Writes back Shopify Product ID + Shopify Product URL to the sheet on all
sibling rows. Photo Status advances to "Shopify Draft Created".

Usage:
    cd /Users/anshsarawagi/Documents/drevi/pipeline/scripts
    source .env && source .venv/bin/activate

    # See the payload without touching Shopify
    python test_shopify_draft.py --sku DD-LEH-FLR-004 --dry-run

    # Skip image upload (faster for product-data testing)
    python test_shopify_draft.py --sku DD-LEH-FLR-004 --no-images

    # Full PoC: create draft + upload images + writeback to sheet
    python test_shopify_draft.py --sku DD-LEH-FLR-004

Required env vars (add to .env):
    GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
    DREVI_TRYON_FOLDER_ID=<drive folder id>
    SHOPIFY_STORE_DOMAIN=drevi-fashion.myshopify.com   (your store slug + .myshopify.com)
    SHOPIFY_CLIENT_ID=<client id from Dev Dashboard>   (NOT the automation token)
    SHOPIFY_CLIENT_SECRET=<client secret from Dev Dashboard>
    SHOPIFY_API_VERSION=2024-10                         (default if unset)

How the auth works (May 2026 Shopify model):
    Dev Dashboard apps no longer give you a static `shpat_` token. Instead, the
    script fetches a fresh Admin API access token at runtime via OAuth
    client_credentials grant:
        POST https://{store}.myshopify.com/admin/oauth/access_token
            grant_type=client_credentials&client_id=...&client_secret=...
    The returned access_token is short-lived (24h) and used in the standard
    X-Shopify-Access-Token header for subsequent Admin API calls.

How to get the Client ID + Secret (~3 min):
    1. Open https://dev.shopify.com → your Drevi Fashion organization → Apps
    2. Open your existing app (or create a new API-only app)
    3. In the app's left sidebar → Settings → Credentials
    4. Copy the Client ID (visible)
    5. Click the eye icon next to Secret to reveal, then copy
    6. Configuration → Admin API scopes → ensure write_products + read_products
       are enabled (Activity and Permissions screen in store admin should show
       Products: View + Edit)
    7. Make sure the app is INSTALLED on Drevi Fashion store (it is, per your
       earlier screenshot)

Defaults / behaviour:
    - Images are downsampled to max 2400px long edge and converted to JPEG q92
      before base64 upload (keeps payload <1 MB per image).
    - Product order in Shopify: front, back, side, lifestyle, detail, detail2,
      then any extras alphabetically.
    - Inventory management: unset on variants (Drevi tracks manually).
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

# Make the script runnable from any cwd
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from drevi_common import (  # noqa: E402
    COLS, LOCAL_LOGS, PHOTO_STATUS, SheetSchema,
    download_drive_file, get_drive_service, get_master_ws,
    get_sheets_client, group_master_rows_by_base_color,
    list_drive_folder, load_master_schema, parse_drive_folder_id,
    read_master_rows, setup_logger, update_cells,
)


SHOPIFY_API_VERSION_DEFAULT = "2024-10"

# Canonical image order in the Shopify product gallery
ANGLE_ORDER = ["front", "back", "side", "lifestyle", "detail", "detail2"]

# Drevi cat_code → Shopify standard taxonomy search term. Used at runtime by
# find_shopify_category_gid() to look up the actual taxonomy node ID via the
# Shopify GraphQL API. Falls back to Shopify's auto-suggest if no match found.
DREVI_CAT_TO_SHOPIFY_SEARCH = {
    "SAR": "Saris",                  # → "Saris & Lehengas" likely
    "LEH": "Lehengas",               # → "Saris & Lehengas" likely
    "IWS": "Salwar Kameez",          # Indo-western dhoti / suit set
    "SEP": "Traditional & Ceremonial",  # generic ethnic separates
}

# Image upload sizing.
# Shopify's documented limit is 20MB per image. In practice, base64-attachment
# uploads in API 2024-10 are reliable up to ~10–15MB; well above that they can
# fail or stall.
#
# Drevi's FASHN output is 4K (4096px) and typically 3–5MB per PNG/JPEG. That's
# well within the safe range, so we DO NOT downsample by default — preserving
# FASHN's full resolution matters for luxury embellishment shots (mirror work,
# sequins, zardozi) where customers zoom in.
#
# A safety-net downsample only kicks in if a raw file exceeds
# SHOPIFY_IMAGE_DOWNSAMPLE_BYTES (default 8MB). When triggered it resizes to
# SHOPIFY_IMAGE_FALLBACK_LONG_EDGE @ JPEG quality SHOPIFY_IMAGE_JPEG_QUALITY.
# These can be overridden via .env:
#   DREVI_SHOPIFY_IMAGE_DOWNSAMPLE_BYTES=8388608     # 8 MB
#   DREVI_SHOPIFY_IMAGE_FALLBACK_LONG_EDGE=4096      # px
#   DREVI_SHOPIFY_IMAGE_JPEG_QUALITY=95              # 1–100
SHOPIFY_IMAGE_DOWNSAMPLE_BYTES   = int(os.environ.get(
    "DREVI_SHOPIFY_IMAGE_DOWNSAMPLE_BYTES", 8 * 1024 * 1024,
))
SHOPIFY_IMAGE_FALLBACK_LONG_EDGE = int(os.environ.get(
    "DREVI_SHOPIFY_IMAGE_FALLBACK_LONG_EDGE", 4096,
))
SHOPIFY_IMAGE_JPEG_QUALITY = int(os.environ.get(
    "DREVI_SHOPIFY_IMAGE_JPEG_QUALITY", 95,
))


# =============================================================================
# Category metafield mappings (Shopify Standard Taxonomy → Drevi defaults)
# =============================================================================
# When you assign a product to a Shopify standard taxonomy category, Shopify
# attaches a category-specific schema of "category metafields" — references
# to standardized metaobjects under namespace `shopify`. For Indo-western
# ethnic wear ("Saris & Lehengas" and siblings), the relevant ones are:
#
#   shopify.age-group       (list.metaobject_reference → shopify--age-group)
#   shopify.target-gender   (list.metaobject_reference → shopify--target-gender)
#   shopify.fabric          (list.metaobject_reference → shopify--fabric)
#   shopify.color-pattern   (list.metaobject_reference → shopify--color-pattern)
#
# (Size is also a category metafield but Shopify auto-derives it from the
# variant Size option, so we don't push it explicitly.)
#
# Each metaobject reference is by GID; we look up GIDs at runtime via
# metaobjectByHandle and cache them in-process.

# Drevi-wide defaults (true for the entire catalog — women's adult ethnic wear)
DREVI_AGE_GROUP_HANDLE     = "adults"
DREVI_TARGET_GENDER_HANDLE = "female"

# Drevi primary_fabric values → Shopify standard fabric metaobject handles.
# Substring match is used: "shimmer tissue net" matches "tissue" → "synthetic".
DREVI_FABRIC_TO_SHOPIFY_HANDLE: Dict[str, str] = {
    "shimmer tissue":  "synthetic",
    "tissue":          "synthetic",
    "net":             "net",
    "georgette":       "polyester",
    "chiffon":         "chiffon",
    "velvet":          "velvet",
    "satin":           "satin",
    "organza":         "organza",
    "silk":            "silk",
    "raw silk":        "silk",
    "pure silk":       "silk",
    "cotton":          "cotton",
    "linen":           "linen",
    "crepe":           "polyester",
    "brocade":         "synthetic",
    "banarasi":        "silk",
    "synthetic":       "synthetic",
    "polyester":       "polyester",
}

# Colour token → Shopify color-pattern metaobject handle. Used for both
# ai_tags entries like "color:green" AND word-by-word parsing of color_detail
# free text ("lemon green" → ["yellow", "green"]).
DREVI_COLOR_TO_SHOPIFY_HANDLE: Dict[str, str] = {
    "red":        "red",
    "maroon":     "maroon",
    "burgundy":   "maroon",
    "wine":       "maroon",
    "rust":       "orange",
    "orange":     "orange",
    "peach":      "orange",
    "coral":      "pink",
    "pink":       "pink",
    "rose":       "pink",
    "fuchsia":    "pink",
    "magenta":    "pink",
    "purple":     "purple",
    "lavender":   "purple",
    "violet":     "purple",
    "blue":       "blue",
    "navy":       "navy",
    "teal":       "blue",
    "turquoise":  "blue",
    "green":      "green",
    "mint":       "green",
    "olive":      "green",
    "lime":       "green",
    "yellow":     "yellow",
    "lemon":      "yellow",
    "mustard":    "yellow",
    "gold":       "gold",
    "silver":     "silver",
    "white":      "white",
    "ivory":      "white",
    "cream":      "beige",
    "beige":      "beige",
    "nude":       "beige",
    "tan":        "brown",
    "brown":      "brown",
    "black":      "black",
    "grey":       "gray",
    "gray":       "gray",
    "multi":      "multicolor",
    "multicolor": "multicolor",
    "rainbow":    "multicolor",
}


# =============================================================================
# Shopify HTTP helpers
# =============================================================================

def shopify_url(store_domain: str, api_version: str, path: str) -> str:
    return f"https://{store_domain}/admin/api/{api_version}/{path.lstrip('/')}"


def fetch_admin_token(
    store_domain: str,
    client_id: str,
    client_secret: str,
    log,
) -> str:
    """OAuth client_credentials grant: exchange Dev Dashboard Client ID +
    Secret for a 24h Admin API access token. This is the new (May 2026)
    Shopify auth model for Dev Dashboard apps — replaces the static
    `shpat_...` tokens from the deprecated custom-app-in-store-admin flow.

    Returns the access_token string (no shpat_ prefix anymore; it's a plain
    32-char hex string). Used in the X-Shopify-Access-Token header.
    """
    url = f"https://{store_domain}/admin/oauth/access_token"
    body = {
        "grant_type":    "client_credentials",
        "client_id":     client_id,
        "client_secret": client_secret,
    }
    log.info("Fetching Admin API token via OAuth client_credentials...")
    log.info("  POST %s", url)
    r = requests.post(
        url, data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(
            f"Shopify OAuth token fetch failed {r.status_code}: {r.text[:400]}"
        )
    body = r.json()
    token = body.get("access_token")
    if not token:
        raise RuntimeError(f"Shopify OAuth response missing access_token: {body}")
    log.info("  ✓ Token acquired (scope=%s, expires_in=%ss)",
             body.get("scope", "?"), body.get("expires_in", "?"))
    return token


def shopify_session(token: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
        "Accept": "application/json",
    })
    return s


# In-process cache so we only query Shopify's taxonomy once per cat_code per run.
_taxonomy_cache: Dict[str, Optional[str]] = {}


def find_shopify_category_gid(
    session: requests.Session,
    store_domain: str,
    api_version: str,
    search_term: str,
    log,
) -> Optional[str]:
    """Query Shopify's standard product taxonomy via GraphQL and return the GID
    of the best matching category for `search_term`. Returns None if no
    match — caller should fall back to Shopify's auto-suggest (which kicks in
    based on product_type).
    """
    if not search_term:
        return None
    if search_term in _taxonomy_cache:
        return _taxonomy_cache[search_term]

    url = f"https://{store_domain}/admin/api/{api_version}/graphql.json"
    query = """
    query($q: String!) {
      taxonomy {
        categories(first: 5, search: $q) {
          edges { node { id name fullName } }
        }
      }
    }
    """
    try:
        r = session.post(
            url,
            json={"query": query, "variables": {"q": search_term}},
            timeout=30,
        )
        if r.status_code != 200:
            log.warning("  Taxonomy query for %r returned %d: %s",
                        search_term, r.status_code, r.text[:160])
            _taxonomy_cache[search_term] = None
            return None
        body = r.json()
        edges = (
            body.get("data", {})
                .get("taxonomy", {})
                .get("categories", {})
                .get("edges", [])
        )
        if not edges:
            log.warning("  No Shopify taxonomy match for %r", search_term)
            _taxonomy_cache[search_term] = None
            return None
        best = edges[0]["node"]
        log.info("  Taxonomy match for %r: %r (%s)",
                 search_term, best["fullName"], best["id"])
        _taxonomy_cache[search_term] = best["id"]
        return best["id"]
    except Exception as e:
        log.warning("  Taxonomy query for %r failed: %s", search_term, e)
        _taxonomy_cache[search_term] = None
        return None


# =============================================================================
# Payload construction
# =============================================================================

def description_to_html(desc: str) -> str:
    """Convert vision's 3-paragraph plain text (separated by \\n\\n) to HTML."""
    if not desc:
        return ""
    paragraphs = [p.strip() for p in desc.split("\n\n") if p.strip()]
    return "".join(f"<p>{p}</p>" for p in paragraphs)


def _val(row: Dict, key: str) -> str:
    v = (row.get(key) or "").strip()
    # Filter out "N.A" / "N/A" placeholders the sheet uses for empty fields
    if v.upper() in ("N.A", "N/A", "N/A.", "NA", "(NONE)", "-"):
        return ""
    return v


# Labels whose values should be displayed verbatim (no title-casing).
# Everything else runs through str.title() so "lemon green" → "Lemon Green",
# "shimmer tissue" → "Shimmer Tissue", etc.
_PRESERVE_CASE_LABELS = {"Style No", "Available Sizes"}


def build_product_details_html(first: Dict, siblings: List[Dict]) -> str:
    """Build a structured 'Product Details' section to append after the
    vision-generated description. Matches the style of KALKI / Sabyasachi /
    Anita Dongre product pages — label : value pairs, grouped by theme.

    Drevi-specific groupings:
      Identifiers : Style No (Vendor SKU intentionally not shown)
      Materials   : Color, Primary Fabric, Secondary Fabric
      Craft       : Primary Work, Secondary Work, Authenticity
      Origin/Care : Origin, Care Level
      Pack        : Pack Contents (inferred from category), Available Sizes

    Value casing rules:
      - Style No and Available Sizes preserve original case (SKU strings + size
        codes like XL/XXL would be mangled by .title()).
      - All other values get str.title() so lowercase free-text from the sheet
        ("lemon green") becomes title case ("Lemon Green").
    """
    rows: List[Tuple[str, str]] = []

    # Identifiers — base SKU only (size-agnostic). Vendor SKU intentionally
    # omitted per Drevi catalog policy.
    drevi_sku = _val(first, "drevi_sku")
    base_sku = drevi_sku.rsplit("-", 2)[0] if drevi_sku.count("-") >= 5 else drevi_sku
    if base_sku:
        rows.append(("Style No", base_sku))

    # Color — prefer color_detail when present (it's the precise free-text
    # value). When the controlled-vocab `Color` is "Other" / "OTH", that's a
    # bucket value and `Color Detail` carries the real name — show just the
    # detail with no parentheses. When `Color` is a real name and there's no
    # detail, show the name. When both exist and `Color` isn't "Other",
    # color_detail still wins (it's typically more specific).
    color = _val(first, "color")
    color_detail = _val(first, "color_detail")
    if color_detail:
        rows.append(("Color", color_detail))
    elif color and color.lower() not in ("other", "oth"):
        rows.append(("Color", color))

    # Materials
    primary_fabric = _val(first, "primary_fabric")
    if primary_fabric:
        rows.append(("Primary Fabric", primary_fabric))
    secondary_fabric = _val(first, "secondary_fabric")
    if secondary_fabric:
        rows.append(("Secondary Fabric", secondary_fabric))

    # Craft
    primary_handwork = _val(first, "primary_handwork")
    if primary_handwork:
        rows.append(("Primary Work", primary_handwork))
    secondary_handwork = _val(first, "secondary_handwork")
    if secondary_handwork:
        rows.append(("Secondary Work", secondary_handwork))
    authenticity = _val(first, "authenticity")
    if authenticity:
        rows.append(("Authenticity", authenticity))

    # Provenance + Care
    origin = _val(first, "origin")
    if origin:
        rows.append(("Origin", origin))
    care = _val(first, "care_level")
    if care:
        rows.append(("Care", care))

    # Pack Contents — inferred from sub-category
    sub_code = _val(first, "sub_code").upper()
    pack_map = {
        "FLR": "1 Lehenga, 1 Choli, 1 Dupatta",
        "MRM": "1 Lehenga, 1 Choli, 1 Dupatta",
        "PRD": "1 Pre-Draped Saree, 1 Blouse",
        "RFL": "1 Ruffled Saree, 1 Blouse",
        "DHT": "1 Dhoti, 1 Top, 1 Dupatta",
        "JKT": "1 Jacket",
    }
    pack = pack_map.get(sub_code, "")
    if pack:
        rows.append(("Pack Contents", pack))

    # NOTE: Available Sizes intentionally omitted from Product Details.
    # Sizes are surfaced via the Shopify variant selector instead — duplicating
    # them in the description is redundant and adds visual clutter.

    if not rows:
        return ""

    parts = [
        '<hr/>',
        '<h3 style="margin-top:1.5em;margin-bottom:0.5em;">Product Details</h3>',
        '<ul style="list-style:none;padding-left:0;line-height:1.8;">',
    ]
    for label, value in rows:
        display = value if label in _PRESERVE_CASE_LABELS else value.title()
        parts.append(
            f'<li><strong>{label}:</strong> {display}</li>'
        )
    parts.append('</ul>')
    return "".join(parts)


def collect_tags(first_row: Dict[str, str]) -> str:
    """Tags = AI Suggested Tags + AI Suggested Occasions + Style + Category/Sub.
    Comma-joined, deduplicated, trimmed."""
    raw: List[str] = []
    for k in ("ai_tags", "ai_occasions"):
        v = (first_row.get(k) or "").strip()
        if v:
            raw.extend(t.strip() for t in v.split(",") if t.strip())
    for k in ("style", "category", "sub_category"):
        v = (first_row.get(k) or "").strip()
        if v:
            raw.append(v)
    seen, out = set(), []
    for t in raw:
        if t.lower() in seen:
            continue
        seen.add(t.lower())
        out.append(t)
    return ", ".join(out)


def build_variants_and_options(siblings: List[Dict]) -> Tuple[List[Dict], List[Dict]]:
    """Build Shopify variants[] + options[] from sibling rows.

    Rules:
      - Size is ALWAYS emitted as a variant option when any sibling has a
        size_code, even if all siblings share one size. Customers expect a
        size selector on ethnic-wear product pages — a "Default Title" variant
        with no size picker looks broken.
      - Color is emitted as a second option only when there are ≥2 distinct
        colors. With a single color, the color is already shown in Product
        Details, so adding a one-value selector is just noise.
      - If neither dimension applies (no sizes anywhere), Shopify gets a
        single default variant with no options.
    """
    sizes = sorted({(r.get("size_code") or "").strip()
                    for r in siblings if (r.get("size_code") or "").strip()})
    # Use the human-readable Color (not the code) for the variant option label
    colors = sorted({(r.get("color") or "").strip()
                     for r in siblings if (r.get("color") or "").strip()})

    has_size  = len(sizes)  >= 1
    has_color = len(colors) >= 2

    options: List[Dict[str, Any]] = []
    if has_size:
        options.append({"name": "Size",  "values": sizes})
    if has_color:
        options.append({"name": "Color", "values": colors})

    variants: List[Dict[str, Any]] = []
    for r in siblings:
        # Inventory tracking is per-variant. Blank Current Qty → no tracking
        # (Shopify shows "Inventory not tracked", variant is always
        # purchasable). Numeric Current Qty (including 0) → Shopify-tracked,
        # quantity pushed post-creation via /inventory_levels/set.json.
        qty = _parse_qty(r.get("current_qty"))
        track = qty is not None
        v: Dict[str, Any] = {
            "sku":   (r.get("drevi_sku") or "").strip(),
            "price": (r.get("final_mrp") or "").strip() or "0",
            "inventory_management": "shopify" if track else None,
            "inventory_policy":     "deny",
            "requires_shipping":    True,
            "taxable":              True,
            # "_drevi_qty" is stripped from the payload before POST.
            # None → skip the inventory_levels push for this variant.
            "_drevi_qty":           qty,
        }
        size  = (r.get("size_code") or "").strip()
        color = (r.get("color") or "").strip()
        if has_size and has_color:
            v["option1"] = size  or "Default"
            v["option2"] = color or "Default"
        elif has_size:
            v["option1"] = size  or "Default"
        elif has_color:
            v["option1"] = color or "Default"
        # else: no option1 set; Shopify uses "Default Title"
        variants.append(v)

    return variants, options


def _parse_qty(raw: Any) -> Optional[int]:
    """Coerce sheet 'Current Qty' to an inventory level.

    Returns:
      None  → cell is blank / N.A. / unparseable. Caller should leave
              inventory_management unset (Shopify won't track this variant).
      int   → cell has a real number (including 0). Caller should set
              inventory_management='shopify' and push this value via
              /inventory_levels/set.json. Negative values clamped to 0.
    """
    if raw is None:
        return None
    s = str(raw).strip()
    if not s or s.upper() in ("N.A", "N/A", "NA", "-"):
        return None
    try:
        n = int(float(s))
    except (TypeError, ValueError):
        return None
    return max(0, n)


def build_product_payload(siblings: List[Dict], vendor: str = "Drevi") -> Tuple[Dict, Dict[str, int]]:
    """Assemble the full {"product": {...}} payload for POST /products.json.

    Returns:
      (payload_dict, sku_to_qty)
        payload_dict — ready to POST. The internal "_drevi_qty" field has
                       been stripped from every variant so Shopify accepts it.
        sku_to_qty   — { variant SKU : inventory qty } map. Used after the
                       product is created to push initial stock via
                       /inventory_levels/set.json (since variant payloads
                       can't carry inventory_quantity in API 2024-10).
    """
    first = siblings[0]
    title = (first.get("product_name") or first.get("drevi_sku", "")).strip()
    body_html = description_to_html(first.get("description", ""))
    # Append structured product-details section (KALKI/Sabyasachi style)
    body_html += build_product_details_html(first, siblings)
    product_type = (first.get("category") or "").strip()
    tags = collect_tags(first)

    variants, options = build_variants_and_options(siblings)

    # Extract & strip qty before it goes over the wire. Only SKUs with a
    # numeric Current Qty on the sheet land in sku_to_qty — variants with
    # blank Current Qty get inventory_management=None (untracked) and are
    # skipped during the inventory push.
    sku_to_qty: Dict[str, int] = {}
    for v in variants:
        sku = v.get("sku") or ""
        qty = v.pop("_drevi_qty", None)
        if sku and qty is not None:
            sku_to_qty[sku] = qty

    product: Dict[str, Any] = {
        "title":        title,
        "body_html":    body_html,
        "vendor":       vendor,
        "product_type": product_type,
        "tags":         tags,
        "status":       "draft",
        "variants":     variants,
    }
    if options:
        product["options"] = options

    # SEO metafields. Shopify expects these under the 'global' namespace.
    metafields: List[Dict[str, Any]] = []
    meta_title = (first.get("meta_title") or "").strip()
    meta_desc  = (first.get("meta_description") or "").strip()
    if meta_title:
        metafields.append({
            "namespace": "global",
            "key":       "title_tag",
            "value":     meta_title,
            "type":      "single_line_text_field",
        })
    if meta_desc:
        metafields.append({
            "namespace": "global",
            "key":       "description_tag",
            "value":     meta_desc,
            "type":      "multi_line_text_field",
        })
    if metafields:
        product["metafields"] = metafields

    return {"product": product}, sku_to_qty


# =============================================================================
# Category assignment (post-creation, GraphQL only)
# =============================================================================

def set_product_category(
    session: requests.Session,
    store_domain: str,
    api_version: str,
    product_id: int,
    category_gid: str,
    log,
) -> bool:
    """Assign a Shopify standard product taxonomy category to an existing
    product via GraphQL productUpdate. Returns True on success.

    Why this exists: REST POST /products.json silently ignores the `category`
    field (it's read-only in REST as of 2024-10). The standard taxonomy can
    only be WRITTEN via GraphQL. Without this call, Shopify falls back to
    its auto-suggest based on product_type, which is unreliable and surfaces
    a yellow 'Category suggested' banner in admin instead of a locked-in
    category.
    """
    url = f"https://{store_domain}/admin/api/{api_version}/graphql.json"
    mutation = """
    mutation setCategory($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id category { id fullName } }
        userErrors { field message }
      }
    }
    """
    variables = {
        "input": {
            "id":       f"gid://shopify/Product/{product_id}",
            "category": category_gid,
        }
    }
    try:
        r = session.post(
            url, json={"query": mutation, "variables": variables}, timeout=30,
        )
    except Exception as e:
        log.warning("  Category set failed (network): %s", e)
        return False
    if r.status_code != 200:
        log.warning("  Category set failed %d: %s", r.status_code, r.text[:200])
        return False
    body = r.json()
    errors = body.get("data", {}).get("productUpdate", {}).get("userErrors") or []
    if errors:
        log.warning("  Category set userErrors: %s", errors)
        return False
    cat = (body.get("data", {})
               .get("productUpdate", {})
               .get("product", {})
               .get("category"))
    if cat:
        log.info("  ✓ Category locked in: %s", cat.get("fullName", cat.get("id")))
        return True
    log.warning("  Category set returned no category on product (raw=%s)",
                json.dumps(body)[:200])
    return False


# =============================================================================
# Category metafields (post-creation, GraphQL only)
# =============================================================================
# Resolved metaobject GIDs cached per (type, handle) for the run.
_metaobject_gid_cache: Dict[Tuple[str, str], Optional[str]] = {}


def resolve_metaobject_gid(
    session: requests.Session,
    store_domain: str,
    api_version: str,
    type_name: str,
    handle: str,
    log,
) -> Optional[str]:
    """Look up a Shopify metaobject by (type, handle) and return its GID.

    type_name examples (Shopify Standard Taxonomy):
      'shopify--age-group', 'shopify--target-gender',
      'shopify--fabric', 'shopify--color-pattern'

    Returns None on miss / error so the caller skips that metafield."""
    key = (type_name, handle)
    if key in _metaobject_gid_cache:
        return _metaobject_gid_cache[key]
    url = f"https://{store_domain}/admin/api/{api_version}/graphql.json"
    query = """
    query lookup($handle: MetaobjectHandleInput!) {
      metaobjectByHandle(handle: $handle) { id }
    }
    """
    variables = {"handle": {"type": type_name, "handle": handle}}
    try:
        r = session.post(
            url, json={"query": query, "variables": variables}, timeout=20,
        )
    except Exception as e:
        log.warning("    metaobject lookup %s/%s failed: %s",
                    type_name, handle, e)
        _metaobject_gid_cache[key] = None
        return None
    if r.status_code != 200:
        log.warning("    metaobject lookup %s/%s HTTP %d: %s",
                    type_name, handle, r.status_code, r.text[:200])
        if r.status_code == 403:
            log.warning(
                "    → Likely missing the 'read_metaobjects' scope. Add it in "
                "Dev Dashboard → Configuration → Admin API access scopes, "
                "reauthorize the app on the store, then re-run."
            )
        _metaobject_gid_cache[key] = None
        return None
    body = r.json()
    mo = (body.get("data") or {}).get("metaobjectByHandle")
    if not mo:
        log.info("    metaobject not found in store taxonomy: %s/%s",
                 type_name, handle)
        _metaobject_gid_cache[key] = None
        return None
    gid = mo["id"]
    _metaobject_gid_cache[key] = gid
    return gid


def _extract_color_handles(row: Dict) -> List[str]:
    """Derive Shopify color-pattern handles for one row. Sources, in order:
      1. ai_tags entries starting with 'color:'   (vision-generated)
      2. Words inside color_detail               (free text, e.g. 'lemon green')
      3. color                                   (controlled vocab)
    De-duplicates, preserving first-seen order."""
    handles: List[str] = []
    seen: set = set()

    def _add(token: str) -> None:
        mapped = DREVI_COLOR_TO_SHOPIFY_HANDLE.get(token)
        if mapped and mapped not in seen:
            seen.add(mapped)
            handles.append(mapped)

    # 1. ai_tags color:*
    for tag in (row.get("ai_tags") or "").split(","):
        t = tag.strip().lower()
        if t.startswith("color:"):
            _add(t[len("color:"):].strip())

    # 2. color_detail words (split on whitespace, hyphen, comma, slash)
    cd = (row.get("color_detail") or "").strip().lower()
    for word in re.split(r"[\s\-,/]+", cd):
        if word:
            _add(word)

    # 3. controlled color (skip "Other" bucket)
    c = (row.get("color") or "").strip().lower()
    if c not in ("", "other", "oth"):
        _add(c)

    return handles


def _extract_fabric_handle(row: Dict) -> Optional[str]:
    """Map sheet primary_fabric (and fall back to secondary_fabric) to a
    Shopify fabric metaobject handle. Substring match — 'Shimmer Tissue Net'
    → 'synthetic' (via 'tissue' or 'shimmer tissue' first hit).
    Iteration order matches insertion order in the mapping dict, so put more
    specific keys first."""
    for field in ("primary_fabric", "secondary_fabric"):
        raw = (row.get(field) or "").strip().lower()
        if not raw:
            continue
        if raw in DREVI_FABRIC_TO_SHOPIFY_HANDLE:
            return DREVI_FABRIC_TO_SHOPIFY_HANDLE[raw]
        for key, handle in DREVI_FABRIC_TO_SHOPIFY_HANDLE.items():
            if key in raw:
                return handle
    return None


# Cache of "does this metaobject definition exist in the store" checks.
_metaobject_def_exists_cache: Dict[str, bool] = {}


def metaobject_definition_exists(
    session: requests.Session,
    store_domain: str,
    api_version: str,
    type_name: str,
    log,
) -> bool:
    """True if the store has a metaobject DEFINITION for `type_name`
    (e.g. 'shopify--fabric'). Standard-taxonomy definitions are only
    materialised in a store on first use — until then nothing of that
    type can be referenced. Cached per run."""
    if type_name in _metaobject_def_exists_cache:
        return _metaobject_def_exists_cache[type_name]
    url = f"https://{store_domain}/admin/api/{api_version}/graphql.json"
    q = """query($t:String!){ metaobjectDefinitionByType(type:$t){ id } }"""
    try:
        r = session.post(url, json={"query": q, "variables": {"t": type_name}},
                         timeout=20)
        ok = bool((r.json().get("data") or {})
                  .get("metaobjectDefinitionByType"))
    except Exception as e:
        log.warning("    def-exists check %s failed: %s", type_name, e)
        ok = False
    _metaobject_def_exists_cache[type_name] = ok
    return ok


def set_category_metafields(
    session: requests.Session,
    store_domain: str,
    api_version: str,
    product_id: int,
    first_row: Dict,
    siblings: List[Dict],
    log,
) -> None:
    """Push category-specific metafields via GraphQL productUpdate.

    Reality of Shopify standard-taxonomy metaobjects (empirically verified
    on this store):
      - A metaobject can only be referenced if BOTH its definition
        (e.g. 'shopify--size') AND the specific entry (e.g. handle 'xl')
        already exist in the store.
      - Definitions are materialised store-wide only on first use. Right
        now only 'shopify--size' and 'shopify--color-pattern' exist; the
        merchant provisions the rest by clicking "Accept all" on the
        category-metafields suggestion banner ONCE (Shopify's suggestions
        are already correct).

    Strategy: set everything that resolves (Size + Color), and for the
    rest emit ONE actionable line telling the merchant exactly what the
    one-time "Accept all" click will provision. Partial success is normal
    and fine — the product is already created."""
    log.info("Setting category metafields via GraphQL...")

    metafields: List[Dict[str, str]] = []
    needs_provisioning: List[str] = []

    # --- Size (multi — collect every sibling's size_code) ---
    size_codes = sorted({
        (r.get("size_code") or "").strip()
        for r in siblings if (r.get("size_code") or "").strip()
    })
    size_gids: List[str] = []
    resolved_sizes: List[str] = []
    if metaobject_definition_exists(
        session, store_domain, api_version, "shopify--size", log,
    ):
        for sc in size_codes:
            gid = resolve_metaobject_gid(
                session, store_domain, api_version,
                "shopify--size", sc.lower(), log,
            )
            if gid:
                size_gids.append(gid)
                resolved_sizes.append(sc)
            else:
                needs_provisioning.append(f"Size '{sc}'")
        if size_gids:
            metafields.append({
                "namespace": "shopify",
                "key":       "size",
                "type":      "list.metaobject_reference",
                "value":     json.dumps(size_gids),
            })
            log.info("  size          → %s", ", ".join(resolved_sizes))
    elif size_codes:
        needs_provisioning.append(f"Size ({', '.join(size_codes)})")

    # --- Color pattern (multi) ---
    color_handles = _extract_color_handles(first_row)
    color_gids: List[str] = []
    resolved_colors: List[str] = []
    if metaobject_definition_exists(
        session, store_domain, api_version, "shopify--color-pattern", log,
    ):
        for h in color_handles:
            gid = resolve_metaobject_gid(
                session, store_domain, api_version,
                "shopify--color-pattern", h, log,
            )
            if gid:
                color_gids.append(gid)
                resolved_colors.append(h)
            else:
                needs_provisioning.append(f"Color '{h}'")
        if color_gids:
            metafields.append({
                "namespace": "shopify",
                "key":       "color-pattern",
                "type":      "list.metaobject_reference",
                "value":     json.dumps(color_gids),
            })
            log.info("  color-pattern → %s", ", ".join(resolved_colors))
    elif color_handles:
        needs_provisioning.append(f"Color ({', '.join(color_handles)})")

    # --- Fabric / Age group / Target gender ---
    # These definitions are NOT provisioned in the store by default. We do
    # not recreate standard definitions by hand (fragile + risks corrupting
    # the taxonomy linkage). If/when the merchant clicks "Accept all" once,
    # the definition exists and these resolve automatically on every future
    # product — no code change needed.
    fabric_handle = _extract_fabric_handle(first_row)
    for key, type_name, handle, label in (
        ("fabric",        "shopify--fabric",        fabric_handle,
         f"Fabric ({fabric_handle})" if fabric_handle else None),
        ("age-group",     "shopify--age-group",     DREVI_AGE_GROUP_HANDLE,
         "Age group (Adults)"),
        ("target-gender", "shopify--target-gender", DREVI_TARGET_GENDER_HANDLE,
         "Target gender (Female)"),
    ):
        if not handle:
            continue
        if not metaobject_definition_exists(
            session, store_domain, api_version, type_name, log,
        ):
            if label:
                needs_provisioning.append(label)
            continue
        gid = resolve_metaobject_gid(
            session, store_domain, api_version, type_name, handle, log,
        )
        if gid:
            metafields.append({
                "namespace": "shopify",
                "key":       key,
                "type":      "list.metaobject_reference",
                "value":     json.dumps([gid]),
            })
            log.info("  %-13s → %s", key, handle)
        elif label:
            needs_provisioning.append(label)

    if needs_provisioning:
        log.info(
            "  ⓘ Not auto-set (Shopify hasn't provisioned these metaobject "
            "definitions in the store yet): %s",
            "; ".join(needs_provisioning),
        )
        log.info(
            "    One-time fix: open any product in Shopify admin → Category "
            "metafields → click 'Accept all' on the suggestions banner. That "
            "provisions the definitions store-wide; every future run then "
            "sets them automatically with no code change."
        )

    if not metafields:
        log.warning("  No category metafields could be resolved — nothing pushed.")
        return

    # Push the resolved set via productUpdate
    url = f"https://{store_domain}/admin/api/{api_version}/graphql.json"
    mutation = """
    mutation setCatMetafields($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id }
        userErrors { field message }
      }
    }
    """
    variables = {
        "input": {
            "id":         f"gid://shopify/Product/{product_id}",
            "metafields": metafields,
        }
    }
    try:
        r = session.post(
            url, json={"query": mutation, "variables": variables}, timeout=30,
        )
    except Exception as e:
        log.warning("  productUpdate metafields call failed: %s", e)
        return
    if r.status_code != 200:
        log.warning("  productUpdate metafields HTTP %d: %s",
                    r.status_code, r.text[:300])
        return
    body = r.json()
    errors = (body.get("data") or {}).get("productUpdate", {}).get("userErrors") or []
    if errors:
        log.warning("  productUpdate metafields userErrors: %s", errors)
        return
    log.info("  ✓ %d category metafield(s) saved.", len(metafields))


# =============================================================================
# Inventory push (post-creation)
# =============================================================================

# Cache the store's primary location_id so we don't refetch on every call.
_primary_location_id: Optional[int] = None


def get_primary_location_id(
    session: requests.Session,
    store_domain: str,
    api_version: str,
    log,
) -> Optional[int]:
    """Fetch the store's primary location ID. Single-location stores have
    exactly one — that's where inventory lives.

    Resolution order:
      1. SHOPIFY_LOCATION_ID env var (escape hatch for stores where the
         app can't get read_locations approval — copy the ID once from
         Shopify admin → Settings → Locations → click location → URL).
      2. GET /locations.json (requires read_locations scope).
      3. None → caller logs a warning and skips inventory push.
    """
    global _primary_location_id
    if _primary_location_id is not None:
        return _primary_location_id

    # Env override
    override = (os.environ.get("SHOPIFY_LOCATION_ID") or "").strip()
    if override:
        try:
            _primary_location_id = int(override)
            log.info("  Using SHOPIFY_LOCATION_ID from env: %d",
                     _primary_location_id)
            return _primary_location_id
        except ValueError:
            log.warning("  SHOPIFY_LOCATION_ID is not an integer: %r — "
                        "falling back to /locations.json", override)

    url = shopify_url(store_domain, api_version, "locations.json")
    r = session.get(url, timeout=30)
    if r.status_code != 200:
        body_snippet = r.text[:300]
        log.warning("  GET /locations.json returned %d: %s",
                    r.status_code, body_snippet)
        if r.status_code == 403 and "read_locations" in body_snippet:
            log.warning(
                "  → Your Dev Dashboard app is missing the 'read_locations' "
                "scope. Add it in: Dev Dashboard → your app → Configuration "
                "→ Admin API access scopes → enable read_locations (+ "
                "read_inventory). Save, reinstall the app on the store if "
                "prompted, then re-run. The script auto-fetches a fresh "
                "token each run, so no manual token refresh needed."
            )
        return None
    locs = r.json().get("locations", [])
    if not locs:
        log.warning("  No locations on this store — can't push inventory.")
        return None
    # Prefer the location flagged as primary; otherwise first active one
    primary = next((l for l in locs if l.get("primary")), None) \
              or next((l for l in locs if l.get("active")), None) \
              or locs[0]
    _primary_location_id = primary["id"]
    log.info("  Primary location: %s (id=%s)",
             primary.get("name", "?"), _primary_location_id)
    return _primary_location_id


def set_inventory_levels(
    session: requests.Session,
    store_domain: str,
    api_version: str,
    created_variants: List[Dict],
    sku_to_qty: Dict[str, int],
    log,
) -> None:
    """For each created variant, set its inventory level at the primary
    location to the sheet's Current Qty. Logs but does not raise on per-
    variant failures — the product is already created."""
    if not sku_to_qty:
        log.info("  (No inventory data on sheet — skipping qty push.)")
        return
    location_id = get_primary_location_id(
        session, store_domain, api_version, log,
    )
    if not location_id:
        log.warning("  Skipping inventory push — no primary location.")
        return
    url = shopify_url(store_domain, api_version, "inventory_levels/set.json")
    for v in created_variants:
        sku = (v.get("sku") or "").strip()
        inv_item_id = v.get("inventory_item_id")
        if not sku or not inv_item_id:
            continue
        qty = sku_to_qty.get(sku, 0)
        body = {
            "location_id":       location_id,
            "inventory_item_id": inv_item_id,
            "available":         qty,
        }
        try:
            r = session.post(url, json=body, timeout=30)
            if r.status_code in (200, 201):
                log.info("    %s → qty=%d ✓", sku, qty)
            else:
                log.warning("    %s qty push failed %d: %s",
                            sku, r.status_code, r.text[:160])
        except Exception as e:
            log.warning("    %s qty push exception: %s", sku, e)


# =============================================================================
# Image fetch + downsample
# =============================================================================

def _download_drive_to_bytes(drive, file_id: str) -> bytes:
    """In-memory download of a Drive file. Avoids tempdir for small images."""
    from googleapiclient.http import MediaIoBaseDownload
    req = drive.files().get_media(fileId=file_id, supportsAllDrives=True)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, req)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return buf.getvalue()


def prepare_image_for_shopify(
    raw: bytes,
    max_bytes: int = SHOPIFY_IMAGE_DOWNSAMPLE_BYTES,
    fallback_long_edge: int = SHOPIFY_IMAGE_FALLBACK_LONG_EDGE,
    quality: int = SHOPIFY_IMAGE_JPEG_QUALITY,
) -> Tuple[bytes, bool]:
    """Return image bytes ready for Shopify upload, preserving original
    resolution whenever it's safely uploadable.

    Behaviour:
      - If raw size ≤ max_bytes: passes through UNCHANGED. No re-encoding,
        no resize. FASHN's 4K detail shots reach Shopify at full quality.
      - If raw size > max_bytes: resizes the long edge to fallback_long_edge
        and re-encodes as JPEG at the given quality. PNG alpha is composited
        onto white.

    Returns:
      (bytes_to_upload, was_downsampled)
    """
    if len(raw) <= max_bytes:
        return raw, False

    from PIL import Image
    img = Image.open(io.BytesIO(raw))
    if img.mode == "RGBA":
        # Composite alpha onto white — JPEG has no transparency channel
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[3])
        img = bg
    elif img.mode != "RGB":
        img = img.convert("RGB")
    if max(img.size) > fallback_long_edge:
        img.thumbnail((fallback_long_edge, fallback_long_edge))
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=quality, optimize=True)
    return out.getvalue(), True


def get_tryon_images(drive, tryon_folder_url: str, log) -> List[Tuple[str, bytes]]:
    """List + download images from the TRYON folder. Returns
    [(filename, raw_bytes)] in the canonical angle order, then any extras."""
    folder_id = parse_drive_folder_id(tryon_folder_url)
    files = list_drive_folder(drive, folder_id)
    by_name = {(f.get("name") or "").lower(): f for f in files}

    ordered: List[Dict] = []
    for stem in ANGLE_ORDER:
        for ext in (".png", ".jpg", ".jpeg"):
            cand = f"{stem}{ext}"
            if cand in by_name:
                ordered.append(by_name[cand])
                break

    # Any other images not in canonical list — alphabetical
    seen_ids = {f["id"] for f in ordered}
    for f in sorted(files, key=lambda x: x.get("name", "")):
        name_lower = (f.get("name") or "").lower()
        if f["id"] in seen_ids:
            continue
        if not name_lower.endswith((".png", ".jpg", ".jpeg")):
            continue
        ordered.append(f)

    out: List[Tuple[str, bytes]] = []
    for f in ordered:
        name = f.get("name", "image.png")
        log.info("  Downloading %s...", name)
        raw = _download_drive_to_bytes(drive, f["id"])
        out.append((name, raw))
    return out


def upload_image_to_shopify(
    session: requests.Session,
    store_domain: str,
    api_version: str,
    product_id: int,
    name: str,
    content: bytes,
    position: int,
    log,
) -> Dict:
    """Upload one image to a product via base64 attachment. Returns the
    created image dict from Shopify."""
    raw_kb = len(content) // 1024
    payload_bytes, was_downsampled = prepare_image_for_shopify(content)
    out_kb = len(payload_bytes) // 1024
    b64 = base64.b64encode(payload_bytes).decode("ascii")
    url = shopify_url(store_domain, api_version,
                      f"products/{product_id}/images.json")
    payload = {
        "image": {
            "attachment": b64,
            "filename":   name,
            "position":   position,
        },
    }
    if was_downsampled:
        log.info("    Uploading %s (%d KB → %d KB after safety-net "
                 "downsample to %dpx q%d)...",
                 name, raw_kb, out_kb,
                 SHOPIFY_IMAGE_FALLBACK_LONG_EDGE,
                 SHOPIFY_IMAGE_JPEG_QUALITY)
    else:
        log.info("    Uploading %s (%d KB, original quality preserved)...",
                 name, out_kb)
    r = session.post(url, json=payload, timeout=180)
    if r.status_code not in (200, 201):
        raise RuntimeError(
            f"Shopify image upload failed {r.status_code}: {r.text[:300]}"
        )
    return r.json()["image"]


# =============================================================================
# Main
# =============================================================================

def main() -> int:
    parser = argparse.ArgumentParser(description="Shopify draft creation PoC")
    parser.add_argument("--sku", required=True,
                        help="Base SKU (e.g., DD-LEH-FLR-004). All sibling "
                             "rows become variants of one Shopify product.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Build the payload and exit. No Shopify calls, "
                             "no sheet writeback. Best first run.")
    parser.add_argument("--no-images", action="store_true",
                        help="Create the product but skip the image upload "
                             "step. Faster for iterating on copy/tags/variants.")
    parser.add_argument("--no-writeback", action="store_true",
                        help="Skip writing Shopify Product ID/URL back to "
                             "Master. Useful for repeat tests where you'll "
                             "delete the draft afterward.")
    parser.add_argument("--redraft", action="store_true",
                        help="Bypass the idempotency skip — create a NEW "
                             "draft even if shopify_product_id is already "
                             "set on this SKU. Default behaviour is to SKIP "
                             "already-drafted SKUs so re-running shopify "
                             "across a large batch doesn't make duplicates.")
    args = parser.parse_args()

    log = setup_logger(
        "drevi.shopify_poc",
        LOCAL_LOGS / "shopify_poc.log",
    )
    log.info("=" * 70)
    log.info("Shopify draft PoC | base_sku=%s | dry_run=%s | no_images=%s",
             args.sku, args.dry_run, args.no_images)

    # ---- Env / config ----
    store_domain = (os.environ.get("SHOPIFY_STORE_DOMAIN") or "").strip()
    client_id    = (os.environ.get("SHOPIFY_CLIENT_ID") or "").strip()
    client_secret = (os.environ.get("SHOPIFY_CLIENT_SECRET") or "").strip()
    # Back-compat: if a static token is set, prefer it (skip OAuth dance)
    static_token = (os.environ.get("SHOPIFY_ADMIN_API_TOKEN") or "").strip()
    api_version  = (os.environ.get("SHOPIFY_API_VERSION")
                    or SHOPIFY_API_VERSION_DEFAULT).strip()

    if not args.dry_run:
        if not store_domain:
            log.error("SHOPIFY_STORE_DOMAIN must be set in .env.")
            return 1
        if not static_token and not (client_id and client_secret):
            log.error(
                "Either SHOPIFY_ADMIN_API_TOKEN (legacy shpat_/static token) OR "
                "both SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard "
                "OAuth) must be set in .env."
            )
            return 1

    # ---- Sheet + Drive ----
    log.info("Connecting to Sheets + Drive...")
    sheets_client = get_sheets_client()
    ws = get_master_ws(sheets_client)
    schema = load_master_schema(ws)
    drive = get_drive_service()
    rows = read_master_rows(ws, schema)
    groups = group_master_rows_by_base_color(rows)

    # All sibling rows for this base SKU, across colors
    siblings: List[Dict] = []
    for (base, color), rs in groups.items():
        if base == args.sku:
            siblings.extend(rs)
    if not siblings:
        log.error("No rows on Master for base SKU %r", args.sku)
        return 1
    log.info("Found %d sibling row(s) for %s", len(siblings), args.sku)

    # Sanity-check: vision + tryon should have run
    first = siblings[0]

    # Idempotency — skip if this SKU already has a Shopify draft. We check
    # MULTIPLE signals, not just shopify_product_id: that column historically
    # failed to persist (it didn't exist when early drafts were written), so
    # keying on it alone let the batch create 29 duplicate products. Any of
    # these reliably indicates "already drafted". Pass --redraft to override.
    existing_id  = (first.get("shopify_product_id")  or "").strip()
    existing_url = (first.get("shopify_product_url") or "").strip()
    drafted_status = (first.get("photo_status") or "").strip() == \
        PHOTO_STATUS["SHOPIFY_DRAFT"]
    if (existing_id or existing_url or drafted_status) and not args.redraft:
        log.info(
            "SKIP — %s already drafted (id=%s, url=%s, status_drafted=%s). "
            "Pass --redraft to force a new draft.",
            args.sku, existing_id or "(none)", existing_url or "(none)",
            drafted_status,
        )
        return 0

    if not (first.get("product_name") or "").strip():
        log.error("No Product Name on sheet — has Stage 2 (vision) run?")
        return 1
    tryon_url = (first.get("output_folder_url") or "").strip()
    if not tryon_url and not args.no_images:
        log.error("No Output Folder URL on sheet — has Stage 3 (FASHN) run? "
                  "Or pass --no-images to skip image upload.")
        return 1

    # Price sanity check: warn (don't block) if any sibling has 0/empty MRP
    missing_price = [
        r.get("drevi_sku", "?") for r in siblings
        if not (r.get("final_mrp") or "").strip()
        or (r.get("final_mrp") or "").strip() in ("0", "0.0", "0.00")
    ]
    if missing_price:
        log.warning(
            "Final MRP is missing/zero on %d row(s): %s. The Shopify draft "
            "will be created with ₹0.00 prices on those variants — fill the "
            "Final MRP column on Master and re-run, OR fix the price in "
            "Shopify admin after drafting.",
            len(missing_price), ", ".join(missing_price),
        )

    # ---- Build payload ----
    payload, sku_to_qty = build_product_payload(siblings, vendor="Drevi")
    p = payload["product"]
    log.info("")
    log.info("Built product payload:")
    log.info("  Title:        %s", p["title"])
    log.info("  Product type: %s", p["product_type"])
    log.info("  Vendor:       %s", p["vendor"])
    log.info("  Tags:         %s", p["tags"][:200])
    log.info("  Status:       %s", p["status"])
    log.info("  Variants:     %d", len(p["variants"]))
    for v in p["variants"]:
        qty_label = (f"qty={sku_to_qty[v['sku']]}"
                     if v["sku"] in sku_to_qty else "qty=untracked")
        bits = [f"sku={v['sku']}", f"price={v['price']}", qty_label]
        if "option1" in v:
            bits.append(f"opt1={v['option1']}")
        if "option2" in v:
            bits.append(f"opt2={v['option2']}")
        log.info("    %s", ", ".join(bits))
    if "options" in p:
        for opt in p["options"]:
            log.info("  Option:       %s = %s", opt["name"], opt["values"])
    if "metafields" in p:
        log.info("  Metafields:   %d", len(p["metafields"]))

    if args.dry_run:
        log.info("")
        log.info("=== DRY RUN — payload preview (body_html truncated) ===")
        preview = json.loads(json.dumps(payload))
        if len(preview["product"].get("body_html", "")) > 240:
            preview["product"]["body_html"] = \
                preview["product"]["body_html"][:240] + "..."
        log.info(json.dumps(preview, indent=2, ensure_ascii=False))
        log.info("")
        log.info("Dry run complete. Re-run without --dry-run to push.")
        return 0

    # ---- Acquire Admin API token ----
    # Filter out `atkn_` tokens — those are Dev Dashboard CI/CD automation
    # tokens, not Admin API tokens. They look superficially similar but
    # Shopify rejects them with 401 "Invalid API key".
    if static_token.startswith("atkn_"):
        log.warning(
            "Ignoring SHOPIFY_ADMIN_API_TOKEN — it starts with 'atkn_' which "
            "is a CI/CD automation token, not an Admin API token. Falling "
            "back to OAuth client_credentials. Remove the atkn_ line from "
            "your .env to silence this warning."
        )
        static_token = ""

    if static_token:
        log.info("Using static SHOPIFY_ADMIN_API_TOKEN from env.")
        admin_token = static_token
    else:
        if not (client_id and client_secret):
            log.error(
                "No usable token: SHOPIFY_ADMIN_API_TOKEN is unset or "
                "invalid (atkn_ tokens don't work for Admin API), and "
                "SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET aren't both set."
            )
            return 1
        try:
            admin_token = fetch_admin_token(
                store_domain, client_id, client_secret, log,
            )
        except Exception as e:
            log.error("OAuth token fetch failed: %s", e)
            return 1

    # ---- Create product ----
    session = shopify_session(admin_token)

    # Look up the Shopify standard taxonomy GID now so we can log it before
    # the REST create, but DON'T put it in the REST payload — REST silently
    # ignores `category`. The actual assignment happens via GraphQL
    # productUpdate immediately after the REST create succeeds.
    cat_code = (first.get("cat_code") or "").strip().upper()
    search_term = DREVI_CAT_TO_SHOPIFY_SEARCH.get(cat_code, "")
    category_gid: Optional[str] = None
    if search_term:
        category_gid = find_shopify_category_gid(
            session, store_domain, api_version, search_term, log,
        )
        if category_gid:
            log.info("  Category:     %s (will set via GraphQL post-create)",
                     category_gid)
        else:
            log.info("  Category:     <auto-suggest> (taxonomy lookup empty)")
    else:
        log.info("  Category:     <auto-suggest> (no search term for cat_code=%s)",
                 cat_code or "?")

    create_url = shopify_url(store_domain, api_version, "products.json")
    log.info("")
    log.info("POST %s", create_url)
    t0 = time.time()
    r = session.post(create_url, json=payload, timeout=60)
    log.info("  Response: %d in %.1fs", r.status_code, time.time() - t0)
    if r.status_code not in (200, 201):
        log.error("Shopify create failed: %s", r.text[:600])
        return 1
    product = r.json()["product"]
    product_id = product["id"]
    admin_url = f"https://{store_domain}/admin/products/{product_id}"
    log.info("  ✓ Created product id=%s", product_id)
    log.info("  Admin URL: %s", admin_url)

    # ---- Set standard taxonomy category (GraphQL — REST can't write this) ----
    if category_gid:
        log.info("")
        log.info("Assigning standard taxonomy category via GraphQL...")
        set_product_category(
            session, store_domain, api_version,
            product_id, category_gid, log,
        )

        # The category drives which metafields are attached. Push them in the
        # same step so the product lands fully populated (age-group, gender,
        # fabric, color-pattern).
        log.info("")
        set_category_metafields(
            session, store_domain, api_version,
            product_id, first, siblings, log,
        )

    # ---- Push inventory levels ----
    # API 2024-10 doesn't accept inventory_quantity in the variant create
    # payload. We have to set inventory_management='shopify' (done above) and
    # then push the actual qty via /inventory_levels/set.json keyed on
    # inventory_item_id (returned in the create response).
    log.info("")
    log.info("Pushing inventory levels to Shopify...")
    set_inventory_levels(
        session, store_domain, api_version,
        product.get("variants", []), sku_to_qty, log,
    )

    # ---- Upload images ----
    if not args.no_images:
        log.info("")
        log.info("Downloading images from TRYON folder...")
        try:
            images = get_tryon_images(drive, tryon_url, log)
        except Exception as e:
            log.warning("Image fetch failed: %s — product was created but "
                        "no images attached.", e)
            images = []
        log.info("  Got %d images", len(images))
        if images:
            log.info(
                "Uploading images to Shopify (original quality preserved up "
                "to %d MB; safety-net downsample to %dpx @ q%d above that)...",
                SHOPIFY_IMAGE_DOWNSAMPLE_BYTES // (1024 * 1024),
                SHOPIFY_IMAGE_FALLBACK_LONG_EDGE,
                SHOPIFY_IMAGE_JPEG_QUALITY,
            )
            for i, (name, content) in enumerate(images, start=1):
                try:
                    upload_image_to_shopify(
                        session, store_domain, api_version,
                        product_id, name, content,
                        position=i, log=log,
                    )
                except Exception as e:
                    log.warning("    Image %s failed: %s", name, e)

    # ---- Writeback to sheet ----
    if not args.no_writeback:
        log.info("")
        log.info("Writing Shopify Product ID + URL back to %d sibling row(s)...",
                 len(siblings))
        for row in siblings:
            updates: Dict[str, Any] = {}
            for key, val in (
                ("shopify_product_id",  str(product_id)),
                ("shopify_product_url", admin_url),
                ("photo_status",        PHOTO_STATUS["SHOPIFY_DRAFT"]),
            ):
                try:
                    col = schema.col_letter(key)
                    updates[col] = val
                except KeyError as e:
                    # Loud — a missing column here is exactly what silently
                    # dropped shopify_product_id and caused duplicate drafts.
                    log.error("  WRITEBACK COLUMN MISSING for %r: %s — value "
                              "%r NOT persisted. Add this column to the Master "
                              "sheet schema.", key, e, val)
            if updates:
                try:
                    # RAW — the product id is a long all-digit string; under
                    # USER_ENTERED Sheets number-parses it and it vanishes in
                    # the number-formatted ID column (the original dup bug).
                    update_cells(ws, row["_row"], updates,
                                 value_input_option="RAW")
                except Exception as e:
                    log.warning("  Writeback row %d failed: %s", row["_row"], e)

    log.info("")
    log.info("=" * 70)
    log.info("DONE — draft created at %s", admin_url)
    log.info("       Photo Status set to '%s' on %d sibling rows.",
             PHOTO_STATUS["SHOPIFY_DRAFT"], len(siblings))
    return 0


if __name__ == "__main__":
    sys.exit(main())
