#!/usr/bin/env python3
"""
vision_wholesale.py — CMAI/wholesale vision pass.
For every SKU folder in INPUT, sends up to 4 raw photos (any filenames — no
front/back renaming needed) to Claude and writes product name, description,
tags, occasions, style, color and craft specs to the Wholesale Product Master
(via DREVI_SHEET_ID). Only fills EMPTY cells — human entries are never
overwritten. Idempotent: skips designs whose Product Name is already set.
"""
import base64
import io
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import requests
from PIL import Image
import pillow_heif
pillow_heif.register_heif_opener()
from googleapiclient.http import MediaIoBaseDownload

from drevi_common import (
    LOCAL_LOGS, get_drive_service, get_master_ws, get_sheets_client,
    list_drive_folder, list_drive_subfolders, load_master_schema,
    now_ist_iso, read_master_rows, setup_logger, update_cells,
)

MODEL = "claude-sonnet-5"
ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]
EXTS = (".png", ".jpg", ".jpeg", ".heic", ".heif", ".webp")
MAX_IMAGES = 4
LONG_EDGE = 1024

SYSTEM = """You are the product copywriter + cataloguer for Drevi, a premium Indian ethnic-wear label (Mumbai). You are given photos of ONE outfit (may be on a mannequin, dress form, or person; backgrounds are raw shop photos — ignore them).

Return STRICT JSON only (no markdown fences) with these keys:
  product_name       – purely DESCRIPTIVE, searchable name, 4-7 words, Title Case. Format: [Shade] [Key work] [Fabric if distinctive] [Garment type]. E.g. "Bottle Green Zari Pre-Draped Saree", "Blush Pink Mirror Work Lehenga Set". NO invented boutique/person names (no "Vanya", "Elara" etc.) — every word must describe the garment.
  description        – exactly 2 paragraphs separated by \\n\\n. Para 1: the outfit, its fabric, colour and craft. Para 2: occasions + styling. Wholesale-buyer friendly, no purple prose.
  color              – single dominant colour name (e.g. "Green", "Powder Blue").
  color_detail       – precise shade (e.g. "Bottle Green", "Blush Pink").
  primary_fabric     – main fabric best guess (e.g. "Net", "Georgette", "Crepe", "Shimmer Tissue", "Raw Silk").
  secondary_fabric   – or "" if none.
  primary_handwork   – main craft (e.g. "Sequin Work", "Zari Work", "Bead Work", "Mirror Work", "Chikankari", "Machine Embroidery").
  secondary_handwork – or "".
  style              – ONE of: Traditional, Contemporary, Fusion, Indo-Western, Minimalist, Maximalist.
  occasions          – 2-4 from: bridal, bridesmaid, wedding-guest, sangeet, mehendi, reception, cocktail, engagement, festive, haldi, everyday-festive.
  tags               – 4-8 kebab-case search tags like "fabric:net", "handwork:sequin-work", "color:green", "style:fusion". Prefix each with its axis.
Be accurate about what you can see; do not invent embellishment that isn't visible."""


def norm(s: str) -> str:
    return "".join((s or "").upper().split())


def base_color_key(sku: str):
    p = norm(sku).split("-")
    if len(p) >= 6:
        return "-".join(p[:4]), p[-1]
    if len(p) == 5:                      # no size segment (e.g. …-006-IVR)
        return "-".join(p[:4]), p[-1]
    return norm(sku), ""


def download_bytes(drive, fid):
    buf = io.BytesIO()
    dl = MediaIoBaseDownload(buf, drive.files().get_media(
        fileId=fid, supportsAllDrives=True))
    done = False
    while not done:
        _, done = dl.next_chunk()
    return buf.getvalue()


def to_jpeg_b64(raw: bytes) -> str:
    img = Image.open(io.BytesIO(raw))
    if img.mode != "RGB":
        img = img.convert("RGB")
    if max(img.size) > LONG_EDGE:
        img.thumbnail((LONG_EDGE, LONG_EDGE))
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=85)
    return base64.b64encode(out.getvalue()).decode()


def call_claude(b64s, log):
    content = [{"type": "image",
                "source": {"type": "base64", "media_type": "image/jpeg",
                           "data": b}} for b in b64s]
    content.append({"type": "text",
                    "text": "Catalogue this outfit. STRICT JSON only."})
    body = {"model": MODEL, "max_tokens": 1500, "system": SYSTEM,
            "messages": [{"role": "user", "content": content}]}
    for attempt in range(1, 4):
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": ANTHROPIC_KEY,
                     "anthropic-version": "2023-06-01",
                     "content-type": "application/json"},
            json=body, timeout=180)
        if r.status_code == 200:
            txt = "".join(blk.get("text", "")
                          for blk in r.json().get("content", []))
            m = re.search(r"\{.*\}", txt, re.S)
            if m:
                # strict=False: the description field legitimately contains
                # raw newlines (2-paragraph format) which strict JSON rejects.
                return json.loads(m.group(0), strict=False)
            raise RuntimeError(f"no JSON in response: {txt[:200]}")
        if r.status_code in (429, 500, 502, 503, 529):
            log.warning("    claude %d — retry %d", r.status_code, attempt)
            time.sleep(15 * attempt)
            continue
        raise RuntimeError(f"claude HTTP {r.status_code}: {r.text[:300]}")
    raise RuntimeError("claude retries exhausted")


def main() -> int:
    log = setup_logger("drevi.vision_ws", LOCAL_LOGS / "vision_wholesale.log")
    log.info("=" * 70)
    log.info("VISION WHOLESALE | model=%s | sheet=%s",
             MODEL, os.environ.get("DREVI_SHEET_ID", "(default)"))

    drive = get_drive_service()
    ws = get_master_ws(get_sheets_client())
    schema = load_master_schema(ws)
    rows = read_master_rows(ws, schema)

    by_bc = {}
    for r in rows:
        sku = (r.get("drevi_sku") or "").strip()
        if sku:
            by_bc.setdefault(base_color_key(sku), []).append(r)

    # --- sibling fallback (color-code drift between sheet and folders) ---
    # Arushi sometimes codes the same garment's colour differently in the
    # folder name vs the sheet (folder BLU vs sheet PBL "Powder Blue").
    # When a base SKU has EXACTLY ONE folder colour with no sheet row and
    # EXACTLY ONE unnamed sheet colour with no folder, they must be the same
    # garment — pair them. Anything ambiguous is skipped and logged.
    sheet_by_base = {}
    for (b, c), rr in by_bc.items():
        sheet_by_base.setdefault(b, {})[c] = rr

    # Writeback targets (sheet column key -> JSON key). Only fill EMPTY cells.
    FIELDS = [
        ("product_name",       "product_name"),
        ("description",        "description"),
        ("color_detail",       "color_detail"),
        ("primary_fabric",     "primary_fabric"),
        ("secondary_fabric",   "secondary_fabric"),
        ("primary_handwork",   "primary_handwork"),
        ("secondary_handwork", "secondary_handwork"),
        ("style",              "style"),
    ]

    folders = list_drive_subfolders(
        drive, os.environ["DREVI_INPUT_FOLDER_ID"])
    log.info("INPUT folders: %d | sheet rows: %d", len(folders), len(rows))

    folder_colors_by_base = {}
    for f in folders:
        b, c = base_color_key(f["name"])
        folder_colors_by_base.setdefault(b, set()).add(c)

    def resolve_rows(key):
        """Exact base+colour match, else unambiguous 1:1 sibling pairing."""
        rr = by_bc.get(key)
        if rr:
            return rr, None
        b, c = key
        scolors = sheet_by_base.get(b, {})
        fcolors = folder_colors_by_base.get(b, set())
        orphan_sheet = [sc for sc, srr in scolors.items()
                        if sc not in fcolors
                        and not (srr[0].get("product_name") or "").strip()]
        orphan_folders = [fc for fc in fcolors if fc not in scolors]
        if (c in orphan_folders and len(orphan_folders) == 1
                and len(orphan_sheet) == 1):
            return scolors[orphan_sheet[0]], (
                f"sibling-match: folder colour {c} -> sheet colour "
                f"{orphan_sheet[0]} (code drift)")
        if c in orphan_folders and (orphan_sheet or len(orphan_folders) > 1):
            return [], (f"AMBIGUOUS siblings for base {b}: folder orphans="
                        f"{sorted(orphan_folders)} sheet orphans="
                        f"{sorted(orphan_sheet)} — fix codes manually")
        return [], None

    done = skipped = failed = unmatched = 0
    unmatched_names = []
    for i, f in enumerate(sorted(folders, key=lambda x: x["name"]), 1):
        name = f["name"]
        key = base_color_key(name)
        sibs, note = resolve_rows(key)
        log.info("")
        log.info("[%d/%d] %s", i, len(folders), name)
        if note and sibs:
            log.info("  %s", note)
        if not sibs:
            log.warning("  %s — SKIP",
                        note or f"no sheet row for base+color {key}")
            unmatched += 1
            unmatched_names.append(name + (f"  [{note}]" if note else ""))
            continue
        if (sibs[0].get("product_name") or "").strip():
            log.info("  already has Product Name — SKIP (idempotent)")
            skipped += 1
            continue
        imgs = [x for x in list_drive_folder(drive, f["id"])
                if x["name"].lower().endswith(EXTS)]
        if not imgs:
            log.warning("  no images — SKIP")
            unmatched += 1
            unmatched_names.append(name + " (empty)")
            continue
        # Prefer canonical stems when present, else first files by name
        pref = {"front": 0, "detail": 1, "back": 2, "side": 3}
        imgs.sort(key=lambda x: (pref.get(
            x["name"].lower().rsplit(".", 1)[0], 9), x["name"]))
        use = imgs[:MAX_IMAGES]
        try:
            b64s = [to_jpeg_b64(download_bytes(drive, x["id"])) for x in use]
            data = call_claude(b64s, log)
        except Exception as e:
            log.error("  ✗ %s", e)
            failed += 1
            continue

        tags = data.get("tags") or []
        occ = data.get("occasions") or []
        tag_str = ", ".join(tags)
        occ_str = ", ".join(
            f"occasion:{o}" if not str(o).startswith("occasion:") else str(o)
            for o in occ)

        wrote = 0
        for row in sibs:
            updates = {}
            for col_key, json_key in FIELDS:
                val = (data.get(json_key) or "").strip()
                if not val:
                    continue
                if (row.get(col_key) or "").strip():
                    continue                       # never overwrite humans
                try:
                    updates[schema.col_letter(col_key)] = val
                except KeyError:
                    pass
            for col_key, val in (("ai_tags", tag_str),
                                 ("ai_occasions", occ_str),
                                 ("copy_generated_at", now_ist_iso())):
                if val and not (row.get(col_key) or "").strip():
                    try:
                        updates[schema.col_letter(col_key)] = val
                    except KeyError:
                        pass
            if updates:
                update_cells(ws, row["_row"], updates,
                             value_input_option="RAW")
                wrote += 1
        log.info("  ✓ %r | %s | %s | rows updated: %d",
                 data.get("product_name"), data.get("color_detail"),
                 data.get("primary_handwork"), wrote)
        done += 1
        time.sleep(1)

    log.info("")
    log.info("=" * 70)
    log.info("DONE | named=%d skipped=%d failed=%d unmatched=%d",
             done, skipped, failed, unmatched)
    for n in unmatched_names:
        log.info("  UNMATCHED: %s", n)
    log.info("VISION_WHOLESALE_DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
