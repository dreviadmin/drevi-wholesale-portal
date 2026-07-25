"""Stage 2 — Vision-driven analysis (Claude Opus 4.7).

Reads the mannequin and detail photos for a SKU, calls Claude Opus 4.7 with
vision, and writes back to the Master Sheet in one pass:

  - Per-angle FASHN prompts (front / back / side / lifestyle)
  - Garment analysis (silhouette, fabric, embellishment, color)
  - Product copy (name, description, meta title, meta description)
  - Suggested tags / occasions / style
  - Dominant color hex
  - Image quality tier recommendation

This replaces the old per-category Tryon Prompt Map for the prompt source and
absorbs the work of the deprecated 03_copy_generator.py.

Triggers
--------
default (no --sku):       Photo Status == "Photos Uploaded"
                          AND Tryon Prompt - Front empty
with --sku:               INPUT folder discoverable via
                          resolve_input_folder()
--force --sku ...:        Re-runs regardless of state. Sheet writeback always
                          touches every sibling row (L / XL stay in sync).

Group-based: all rows sharing (base_sku, color_code) are processed once and
the results are propagated to every sibling.

Outputs
-------
Sheet writes (per sibling row):
  - tryon_prompt_front / back / side / life
  - product_name, description, meta_title, meta_description
  - copy_generated_at  (timestamp)
  - dominant_hex
  - ai_occasions, ai_tags
  - image_quality_tier  (only if currently empty — never overrides Rakesh)

State transitions
-----------------
After successful vision: Photo Status stays at "Photos Uploaded".
Stage 3 (FASHN) reads the prompts off the sheet to do its work and is
responsible for advancing photo_status -> "AI Processing" -> "AI Done".

Cost note
---------
Opus 4.7 is $5/M input + $25/M output. Per SKU at ~6 images + ~2K input +
~1.5K output ≈ $0.15. Full ~155-SKU catalog ≈ $20-25 total.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Add same-dir to import drevi_common
sys.path.insert(0, str(Path(__file__).parent))

from drevi_common import (  # noqa: E402
    ANTHROPIC_MODEL, COLS, LOCAL_LOGS, PHOTO_STATUS, PIPELINE_STATUS,
    STAGE_FAILED, SheetSchema, base_sku_from_drevi_sku,
    build_vision_messages, collect_sku_vision_images, first_sibling_value,
    get_drive_service, get_master_ws, get_or_create_subfolder,
    get_sheets_client, group_master_rows_by_base_color,
    group_matches_sku_filter, list_drive_folder, load_master_schema,
    load_tag_vocabulary, now_ist_iso, parse_drive_folder_id,
    parse_vision_json, photo_folder_name, read_master_rows,
    resolve_input_folder, resolve_vision_logs_root,
    routing_for_embellishment, setup_logger, update_cells,
    upload_text_to_drive,
)


# =============================================================================
# 1. SYSTEM PROMPT
# =============================================================================

SYSTEM_PROMPT = """You are the Drevi Fashion AI assistant.

Drevi is a premium Indo-western and contemporary ethnic wear brand based in \
Mumbai (Dadar West). The brand combines Indian heritage with modern \
silhouettes: "Dream Forward, Root Deep" (the soul) and \
"The Devi Doesn't Choose" (the attitude). Target customer: modern Indian \
woman, 22-40.

For each garment, you will receive 4-6 photos — either shot on a white \
mannequin against a dark store backdrop with the gold "DREVI" sign visible, \
OR shot on a Drevi staff member in similar conditions — plus structured \
spec data from the sourcing team. Your job is to produce ONE JSON object \
containing per-angle FASHN prompts, garment analysis, product copy, \
merchandising metadata, AND routing decisions for the FASHN call.

CRITICAL RULES:

1. Match the EXACT JSON schema in the user message. No markdown fences, no \
   preamble, no commentary — JSON only.

2. Per-angle FASHN prompts must be SHORT (under 35 words) and SCENE-ONLY. \
   Drevi's pipeline routes EVERY garment through FASHN's `model-swap` \
   endpoint, which preserves the outfit pixel-accurate from the source \
   image and only swaps the person's identity. \
   \
   CRITICAL: Do NOT describe the garment in the prompt. Do NOT mention \
   silhouette, fabric, color, embellishment, drape, or any garment \
   detail. model-swap interprets garment descriptions as re-render \
   instructions, which destroys the embellishment work we're trying \
   to preserve. \
   \
   The prompt should ONLY contain background/scene instructions. Use \
   the SAME prompt for all four angles (front/back/side/lifestyle) — \
   there is no per-angle disambiguation to do because the source image \
   already shows each angle. \
   \
   Canonical prompt (use this verbatim for all four angles unless the \
   source has unusual scene issues you need to address): \
   \
     "Replace background with a plain warm light grey seamless studio \
      backdrop in tone #a8a4a0, soft even studio lighting, subtle natural \
      floor shadow under feet, no store fixtures or environmental \
      elements visible. Preserve the outfit exactly as in source." \
   \
   NOTE: Do NOT say "preserve body" or "preserve pose" in the prompt. \
   Focus the preservation instruction on the OUTFIT only. The model's \
   identity is swapped by face_reference, and model-swap handles pose \
   inheritance automatically — we don't want to over-constrain those.

3. Product copy follows Drevi's "Soul" voice: warm, sensory, aspirational. \
   3 paragraphs, 90-130 words total. Structure:
     P1: Sensory hook + heritage/craft anchor.
     P2: Design specifics — fabric, embellishment, technique. Use ONLY \
         what's verified in the spec sheet and what you can clearly see in \
         the photos.
     P3: Specific occasion + the woman wearing it.

   BANNED WORDS: stunning, gorgeous, vibrant, exquisite. NO exclamation \
   marks anywhere.

4. Product name: 5-8 words. Format:
     [Evocative word — craft / origin / mood]
     [Color]
     [Fabric or technique, if value-signaling]
     [Silhouette, if distinctive]
     [Garment type]
   No filler adjectives like "beautiful", "elegant", "classic". \
   Examples:
     - "Champagne Pearl Bustier Drape Skirt Set"
     - "Kashi Maroon Handloom Banarasi Silk Saree"
     - "Mehendi Green Mirror-Work Palazzo Suit"

5. PROVENANCE — do NOT invent origin, authenticity, or weave claims that \
   aren't in the spec sheet. If the spec sheet says "Authentic Handwork" \
   you can say "handworked" but NOT "handwoven" unless that's specified. \
   If origin is "Mumbai" don't claim "Banarasi" unless the fabric field \
   confirms it. Visual observations (e.g. "shimmer tissue") are fine \
   because you can see them.

6. ROUTING DECISIONS (these drive Stage 3 — pick carefully):

   embellishment_level: assess what's visible on the garment. Pick the
   LOWEST level that honestly describes it:
     light:   plain drape (simple saree, georgette suit), minimal trim, \
              NO beadwork / sequins / heavy embroidery
     medium:  decorative borders, embroidery panels, partial bead/sequin \
              work, printed motifs, contrast trim
     heavy:   zardozi, dabka, mirror work, heavy bead/sequin/embroidery \
              coverage across most of the garment
     bridal:  full bridal lehenga, all-over heavy embellishment, hero \
              campaign piece

   recommended_fashn_mode is ALWAYS "model-swap" (Drevi's locked endpoint, \
   May 2026). image_quality_tier follows from embellishment_level:
     light    -> model-swap + standard   (26 cr/SKU)
     medium   -> model-swap + standard   (26 cr/SKU)
     heavy    -> model-swap + hero       (30 cr/SKU)
     bridal   -> model-swap + bridal     (32 cr/SKU)

   You MUST output BOTH the level AND the derived tier. Do not \
   second-guess the mapping; the production pipeline depends on it.

   source_type: identify whether the source photo is on a 'dummy' (a \
   mannequin: no real face, smooth synthetic body, often white, rigid \
   posture) or on a 'staff' (real human Drevi team member). Mark 'mixed' \
   only if different angles in the same SKU were shot on different bodies. \
   Recorded for operational visibility — does NOT influence routing.

   reshoot_recommendation: default 'ok-as-is'. Only set \
   'should-reshoot-on-staff' if the source photo has a problem that hurts \
   output quality regardless of FASHN endpoint:
     - garment partially occluded
     - harsh shadows on embellishment
     - garment crumpled or badly fitted
     - bad framing (cropped feet, head out of frame)

7. Suggested occasions / tags / style — use the controlled vocabularies \
   provided in the user message. Don't invent new tag axes.

8. Dominant Color Hex — sample from the garment's PRIMARY fabric, not \
   the embellishment. e.g. for a champagne skirt with pearl embroidery, \
   the hex is the champagne fabric, not white pearls.

OUTPUT JSON SCHEMA:
{
  "fashn_prompts": {
    "front":     "string (under 30 words, includes embellishment + bg guardrails)",
    "back":      "string (under 30 words, includes embellishment + bg guardrails)",
    "side":      "string (under 30 words, includes embellishment + bg guardrails)",
    "lifestyle": "string (under 30 words, includes embellishment + bg guardrails)"
  },
  "garment_analysis": {
    "silhouette":           "string",
    "fabric_observations":  "string",
    "embellishment":        "string",
    "color_observations":   "string",
    "key_features":         ["string", ...]
  },
  "product_name":            "string (5-8 words)",
  "description":             "string (3 paragraphs, 90-130 words total, separated by \\n\\n)",
  "meta_title":              "string (under 60 chars, ends with ' | Drevi')",
  "meta_description":        "string (under 155 chars)",
  "suggested_tags":          ["string", ...],
  "suggested_occasions":     ["string", ...],
  "style":                   "string (one of the allowed Style values)",
  "dominant_color_hex":      "#RRGGBB",
  "image_quality_tier":      "standard | hero_lite | hero | bridal",

  "source_type":             "dummy | staff | mixed",
  "embellishment_level":     "light | medium | heavy | bridal",
  "recommended_fashn_mode":  "tryon-max | model-swap",
  "reshoot_recommendation":  "ok-as-is | should-reshoot-on-staff"
}

Output only this JSON object. Nothing else.
"""


# =============================================================================
# 2. ANTHROPIC CLIENT
# =============================================================================

def get_anthropic_client():
    """Build an Anthropic client. Requires ANTHROPIC_API_KEY env var."""
    try:
        import anthropic
    except ImportError:
        raise RuntimeError(
            "anthropic package not installed. Run: "
            "pip install anthropic --break-system-packages"
        )
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY env var is not set.")
    return anthropic.Anthropic(api_key=api_key)


def call_vision(
    client,
    angle_images: Dict[str, Tuple[str, str]],
    spec: Dict[str, str],
    tag_vocab_block: str,
    log,
    max_retries: int = 2,
) -> Tuple[Optional[Dict], Optional[str], Optional[Dict]]:
    """Call Claude with vision. Returns (parsed_json, raw_response_text, usage).

    `parsed_json` is the validated JSON dict, or None on parse/validation
    failure. `raw_response_text` is Claude's full response text — always
    populated when at least one attempt completed (used for backup logs).
    `usage` is the token-usage dict, or None if unavailable.
    """
    messages = build_vision_messages(angle_images, spec)
    messages[0]["content"].append({
        "type": "text",
        "text": "\n=== CONTROLLED VOCABULARY (use these exact tag values) ===\n" + tag_vocab_block,
    })
    messages[0]["content"].append({
        "type": "text",
        "text": (
            "\nNow output the JSON object per the schema in the system "
            "prompt. JSON only — no fences, no commentary."
        ),
    })

    last_raw: Optional[str] = None
    last_usage: Optional[Dict] = None
    last_err = None
    for attempt in range(max_retries + 1):
        try:
            log.info("    Vision call (attempt %d/%d, model=%s, %d images)...",
                     attempt + 1, max_retries + 1, ANTHROPIC_MODEL,
                     len(angle_images))
            t0 = time.time()
            resp = client.messages.create(
                model=ANTHROPIC_MODEL,
                max_tokens=4096,
                system=SYSTEM_PROMPT,
                messages=messages,
            )
            dt = time.time() - t0
            text_parts = []
            for block in resp.content:
                if hasattr(block, "text"):
                    text_parts.append(block.text)
                elif isinstance(block, dict) and block.get("type") == "text":
                    text_parts.append(block.get("text", ""))
            raw = "".join(text_parts).strip()
            last_raw = raw
            usage_obj = getattr(resp, "usage", None)
            usage_dict: Optional[Dict] = None
            if usage_obj is not None:
                usage_dict = {
                    "input_tokens":  getattr(usage_obj, "input_tokens", None),
                    "output_tokens": getattr(usage_obj, "output_tokens", None),
                }
            last_usage = usage_dict
            in_tok = (usage_dict or {}).get("input_tokens", "?")
            out_tok = (usage_dict or {}).get("output_tokens", "?")
            log.info("    Vision OK (%.1fs, in=%s tok, out=%s tok)",
                     dt, in_tok, out_tok)

            parsed = parse_vision_json(raw, log)
            if parsed is not None:
                return parsed, raw, usage_dict
            log.warning("    Vision JSON parse failed on attempt %d", attempt + 1)
            last_err = "JSON parse"
        except Exception as e:
            log.error("    Vision call failed: %s", e)
            last_err = str(e)
            time.sleep(2 ** attempt)

    log.error("    Vision call gave up after %d attempts: %s",
              max_retries + 1, last_err)
    return None, last_raw, last_usage


def _save_vision_log(
    drive,
    vision_logs_root: str,
    base_sku: str,
    color_code: str,
    *,
    spec: Dict[str, str],
    tag_vocab_block: str,
    raw_response: Optional[str],
    parsed: Optional[Dict],
    usage: Optional[Dict],
    log,
    suffix: str = "",
) -> None:
    """Persist a JSON backup of the vision call to
    VISION_LOGS/<base_sku>[-<color_code>]/<timestamp>[-<suffix>].json.

    Captures the spec block we sent, the controlled-vocabulary block, the
    raw Claude response, the parsed JSON (when valid), and token usage.
    Fail-soft: a backup-write error logs a warning but doesn't fail the SKU.
    """
    import datetime as _dt

    folder_label = f"{base_sku}-{color_code}" if color_code and color_code != "OTH" else base_sku
    ts = _dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    name = f"{ts}.json" if not suffix else f"{ts}-{suffix}.json"
    payload = {
        "model":        ANTHROPIC_MODEL,
        "timestamp_utc": ts,
        "base_sku":     base_sku,
        "color_code":   color_code,
        "spec":         spec,
        "tag_vocab":    tag_vocab_block,
        "raw_response": raw_response,
        "parsed":       parsed,
        "usage":        usage,
    }
    try:
        sku_log_folder = get_or_create_subfolder(
            drive, vision_logs_root, folder_label,
        )
        upload_text_to_drive(
            drive, sku_log_folder, name,
            json.dumps(payload, ensure_ascii=False, indent=2),
            mime_type="application/json",
        )
        log.info("    Vision log saved: VISION_LOGS/%s/%s",
                 folder_label, name)
    except Exception as e:
        log.warning("    Vision log save failed (%s) — continuing.", e)


# =============================================================================
# 3. CONTROLLED VOCABULARY BLOCK
# =============================================================================

def build_tag_vocab_block(tag_vocab: Dict[str, List[Dict]]) -> str:
    """Format the tag vocabulary as a compact instruction block for the model."""
    if not tag_vocab:
        return "(tag vocabulary unavailable — generate sensible defaults)"
    parts = []
    for axis in ("occasion", "fabric", "handwork", "color", "style", "merch"):
        items = tag_vocab.get(axis, [])
        if not items:
            continue
        parts.append(f"  {axis}:")
        for x in items:
            parts.append(f"    - {x['tag_value']}  ({x['display_label']})")
    return "\n".join(parts) if parts else "(no tags)"


# =============================================================================
# 4. PER-SKU PROCESSING
# =============================================================================

def build_spec_dict(siblings: List[Dict]) -> Dict[str, str]:
    """Merge spec fields from sibling rows. Uses first non-empty value
    across siblings for each field — same garment design, just different
    sizes/colors, so specs should be identical.

    'vendor_sku' carries the vendor identity into the vision spec block
    (the Master tab doesn't have a separate Vendor Name column today).
    """
    keys = [
        "color", "color_detail", "primary_fabric", "secondary_fabric",
        "primary_handwork", "secondary_handwork", "authenticity", "origin",
        "care_level", "sub_category", "category", "vendor_sku",
        "notes_for_listing",
    ]
    return {k: first_sibling_value(siblings, k) for k in keys}


def process_one_group(
    drive,
    sheets_client,
    ws,
    schema: SheetSchema,
    base_sku: str,
    color_code: str,
    siblings: List[Dict],
    anthropic_client,
    tag_vocab_block: str,
    vision_logs_root: Optional[str],
    args,
    log,
) -> Tuple[bool, Optional[str]]:
    """Process one (base_sku, color_code) group.

    Returns (success, error_message).

    Reads images from PROCESSED (Stage 1 output) so vision sees the same
    JPGs FASHN will consume. Hard-requires front + back stems before making
    the API call.
    """
    group_label = f"{base_sku}/{color_code or '_'}"
    log.info("Group %s (%d siblings)", group_label, len(siblings))

    # 1. Resolve PROCESSED folder via the sheet's Processed Folder URL.
    processed_url = first_sibling_value(siblings, "processed_url")
    if not processed_url:
        return False, (
            "Processed Folder URL is empty — Stage 1 (preprocess) hasn't "
            "run for this SKU yet."
        )
    try:
        processed_folder_id = parse_drive_folder_id(processed_url)
    except Exception as e:
        return False, f"invalid processed_url: {e}"
    log.info("  Source: PROCESSED (id=%s)", processed_folder_id)

    # 2. Hard prereq — front + back must exist in PROCESSED.
    processed_files = list_drive_folder(drive, processed_folder_id)
    have = {(f.get("name") or "").lower() for f in processed_files}
    if not any(name.startswith("front.") for name in have):
        return False, "PROCESSED folder is missing front.* — Stage 1 incomplete"
    if not any(name.startswith("back.") for name in have):
        return False, "PROCESSED folder is missing back.* — Stage 1 incomplete"

    # 3. Fetch images
    log.info("  Downloading images from PROCESSED...")
    angle_images = collect_sku_vision_images(drive, processed_folder_id, log)
    if not angle_images:
        return False, "no images decoded from PROCESSED folder"
    log.info("  Got %d images: %s", len(angle_images),
             ", ".join(sorted(angle_images.keys())))

    # 4. Build spec dict from siblings
    spec = build_spec_dict(siblings)
    populated_fields = [k for k, v in spec.items() if v]
    log.info("  Spec fields populated: %s",
             ", ".join(populated_fields) if populated_fields else "(none)")

    # 5. Call vision (returns parsed JSON, the raw text, and usage)
    parsed, raw_response, usage = call_vision(
        anthropic_client, angle_images, spec, tag_vocab_block, log,
    )
    if not parsed:
        # Persist the failure — useful for debugging prompt issues.
        if vision_logs_root and raw_response is not None:
            _save_vision_log(
                drive, vision_logs_root, base_sku, color_code,
                spec=spec, tag_vocab_block=tag_vocab_block,
                raw_response=raw_response, parsed=None, usage=usage,
                log=log, suffix="parse-failed",
            )
        return False, "vision call failed"

    # 6. Backup raw + parsed response to Drive before the sheet writeback.
    if vision_logs_root:
        _save_vision_log(
            drive, vision_logs_root, base_sku, color_code,
            spec=spec, tag_vocab_block=tag_vocab_block,
            raw_response=raw_response, parsed=parsed, usage=usage, log=log,
        )

    # 7. Extract output fields
    fp = parsed.get("fashn_prompts", {})
    log.info("  fashn_prompts.front: %r", fp.get("front", "")[:80])
    log.info("  product_name: %r", parsed.get("product_name", ""))

    # 7b. Reconcile routing decisions. Vision is asked to output BOTH the
    # embellishment_level AND the derived (mode, tier). To guard against
    # drift, we re-derive (mode, tier) from embellishment_level here using
    # the canonical EMBELLISHMENT_TO_ROUTING table, and override whatever
    # the model produced. The level itself comes straight from vision.
    embellishment_level = (parsed.get("embellishment_level") or "").strip().lower()
    if embellishment_level not in ("light", "medium", "heavy", "bridal"):
        log.warning("  Vision returned invalid embellishment_level=%r — defaulting to 'light'",
                    embellishment_level)
        embellishment_level = "light"
    canonical_mode, canonical_tier = routing_for_embellishment(embellishment_level)
    vision_mode = (parsed.get("recommended_fashn_mode") or "").strip().lower()
    vision_tier = (parsed.get("image_quality_tier") or "").strip().lower()
    if vision_mode != canonical_mode:
        log.info("  Routing override: vision said mode=%r, canonical=%r — using canonical",
                 vision_mode or "(empty)", canonical_mode)
    if vision_tier and vision_tier != canonical_tier:
        log.info("  Tier override: vision said tier=%r, canonical for %s=%r — using canonical",
                 vision_tier, embellishment_level, canonical_tier)
    log.info("  ROUTING: embellishment=%s -> mode=%s, tier=%s",
             embellishment_level, canonical_mode, canonical_tier)
    source_type = (parsed.get("source_type") or "dummy").strip().lower()
    if source_type not in ("dummy", "staff", "mixed"):
        source_type = "dummy"
    reshoot = (parsed.get("reshoot_recommendation") or "ok-as-is").strip().lower()
    if reshoot not in ("ok-as-is", "should-reshoot-on-staff"):
        reshoot = "ok-as-is"

    # 6. Write back to ALL sibling rows
    now = now_ist_iso()
    write_count = 0
    for row in siblings:
        row_idx = row["_row_index"]
        updates: Dict[str, str] = {}

        def add(key: str, value: str):
            try:
                col = schema.col_letter(key)
            except KeyError:
                log.warning("  column missing on sheet for key %r — skipped", key)
                return
            updates[col] = value

        add("tryon_prompt_front", fp.get("front", ""))
        add("tryon_prompt_back",  fp.get("back", ""))
        add("tryon_prompt_side",  fp.get("side", ""))
        add("tryon_prompt_life",  fp.get("lifestyle", ""))

        add("product_name",       parsed.get("product_name", ""))
        add("description",        parsed.get("description", ""))
        add("meta_title",         parsed.get("meta_title", ""))
        add("meta_description",   parsed.get("meta_description", ""))
        add("copy_generated_at",  now)

        add("dominant_hex",       parsed.get("dominant_color_hex", ""))
        add("ai_occasions",       ", ".join(parsed.get("suggested_occasions", [])))
        add("ai_tags",            ", ".join(parsed.get("suggested_tags", [])))

        # Routing decisions — drive Stage 3's endpoint dispatch.
        # source_type and reshoot_recommendation are informational; mode and
        # tier drive routing. Always overwrite these — vision is the source
        # of truth for what gets rendered, not Grishma's earlier setting
        # (she can still override post-hoc by hand).
        add("source_type",         source_type)
        add("embellishment_level", embellishment_level)
        add("fashn_mode",          canonical_mode)
        add("reshoot_recommended", reshoot)

        # Atomically advance Photo Status — Stage 3 picks up "Vision Done".
        add("photo_status",       PHOTO_STATUS["VISION_DONE"])

        # image_quality_tier: vision is now authoritative (it's part of
        # routing). Always overwrite with the canonical tier.
        add("image_quality_tier",  canonical_tier)

        # style: only fill if currently empty (Grishma owns this column)
        style_now = (row.get("style") or "").strip()
        if not style_now:
            add("style", parsed.get("style", ""))

        if updates:
            try:
                update_cells(ws, row_idx, updates)
                write_count += len(updates)
            except Exception as e:
                log.error("  Sheet writeback failed for row %d: %s", row_idx, e)
                return False, f"sheet writeback failed: {e}"

    log.info("  Sheet writes: %d cells across %d siblings",
             write_count, len(siblings))
    return True, None


# =============================================================================
# 5. PLAN BUILDING (which groups to process)
# =============================================================================

def build_plan(
    rows: List[Dict],
    sku_filter: Optional[str],
    force: bool,
    drive,
    log,
) -> List[Tuple[str, str, List[Dict], str]]:
    """Decide which groups to process.

    Returns list of (base_sku, color_code, siblings, mode).
    mode is always 'process' for vision (no propagation — every sibling gets
    written in process_one_group anyway).
    """
    groups = group_master_rows_by_base_color(rows)
    plan: List[Tuple[str, str, List[Dict], str]] = []

    for (base_sku, color_code), siblings in groups.items():
        # Filter by --sku if supplied
        if sku_filter and not group_matches_sku_filter(siblings, sku_filter):
            continue

        first = siblings[0]
        photo_status = (first.get("photo_status") or "").strip()

        if force:
            if not sku_filter:
                continue  # safety: --force requires --sku
            plan.append((base_sku, color_code, siblings, "process"))
            continue

        if sku_filter:
            # With --sku but no --force: trigger if INPUT folder present OR sheet
            # state qualifies. Don't block on Photo Status since user is targeting
            # a specific SKU intentionally.
            plan.append((base_sku, color_code, siblings, "process"))
            continue

        # Default trigger: Photo Status is the single source of truth.
        # Stage 2 fires only on "Preprocessed" (Stage 1 just finished).
        if photo_status == PHOTO_STATUS["PREPROCESSED"]:
            plan.append((base_sku, color_code, siblings, "process"))

    return plan


# =============================================================================
# 6. MAIN
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Stage 2: Vision analysis (Claude Opus 4.7)",
    )
    parser.add_argument("--sku", help="Process only this SKU (full Drevi SKU or Base SKU)")
    parser.add_argument("--force", action="store_true",
                        help="Re-run regardless of state. Requires --sku.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Build the plan and exit without API calls.")
    parser.add_argument("--max", type=int, default=0,
                        help="Cap to N groups (cost control). 0 = no limit. "
                             "At ~$0.15/SKU, full catalog runs come to $20-25.")
    args = parser.parse_args()

    log = setup_logger("drevi.vision", LOCAL_LOGS / "02_vision.log")
    log.info("=" * 70)
    log.info("Stage 2: Vision Analysis | model=%s | sku=%s | force=%s",
             ANTHROPIC_MODEL, args.sku or "(all)", args.force)

    if args.force and not args.sku:
        log.error("--force requires --sku for safety. Aborting.")
        return 2

    # Init clients
    log.info("Connecting to Sheets, Drive, Anthropic...")
    sheets_client = get_sheets_client()
    ws = get_master_ws(sheets_client)
    schema = load_master_schema(ws)
    drive = get_drive_service()
    anthropic_client = get_anthropic_client() if not args.dry_run else None

    # Load tag vocab once
    tag_vocab = load_tag_vocabulary(sheets_client)
    tag_vocab_block = build_tag_vocab_block(tag_vocab)

    # Resolve VISION_LOGS root for backup. Soft-fails: if we can't resolve
    # one, vision still runs — backups just get skipped per-call.
    vision_logs_root: Optional[str] = None
    if not args.dry_run:
        try:
            vision_logs_root = resolve_vision_logs_root(drive, log)
        except Exception as e:
            log.warning("VISION_LOGS root unresolved (%s) — backups disabled "
                        "for this run.", e)

    # Read all rows, build plan
    rows = read_master_rows(ws, schema)
    log.info("Master Sheet: %d data rows", len(rows))

    plan = build_plan(rows, args.sku, args.force, drive, log)
    if args.max > 0 and len(plan) > args.max:
        log.info("Plan: %d groups -> capping to --max %d", len(plan), args.max)
        plan = plan[:args.max]
    log.info("Plan: %d groups to process", len(plan))

    if args.dry_run:
        for (base_sku, color_code, siblings, mode) in plan:
            log.info("  [%s] %s/%s (%d siblings)", mode, base_sku,
                     color_code or "_", len(siblings))
        log.info("Dry run complete — no API calls made.")
        return 0

    if not plan:
        log.info("No SKUs ready for vision analysis.")
        return 0

    # Process each group
    photo_status_col = schema.col_letter("photo_status")

    def _mark_failed(siblings_list: List[Dict]) -> None:
        for r in siblings_list:
            try:
                update_cells(ws, r["_row_index"], {
                    photo_status_col: STAGE_FAILED["vision"],
                })
            except Exception as e:
                log.error("  failed-status writeback failed for row %d: %s",
                          r.get("_row_index"), e)

    succeeded: List[str] = []
    failed: List[Tuple[str, str]] = []
    for (base_sku, color_code, siblings, mode) in plan:
        try:
            ok, err = process_one_group(
                drive=drive,
                sheets_client=sheets_client,
                ws=ws,
                schema=schema,
                base_sku=base_sku,
                color_code=color_code,
                siblings=siblings,
                anthropic_client=anthropic_client,
                tag_vocab_block=tag_vocab_block,
                vision_logs_root=vision_logs_root,
                args=args,
                log=log,
            )
            label = f"{base_sku}/{color_code or '_'}"
            if ok:
                succeeded.append(label)
            else:
                failed.append((label, err or "unknown"))
                _mark_failed(siblings)
        except Exception as e:
            log.exception("Group %s/%s blew up: %s", base_sku, color_code, e)
            failed.append((f"{base_sku}/{color_code}", str(e)))
            _mark_failed(siblings)

    log.info("=" * 70)
    log.info("DONE · %d succeeded · %d failed", len(succeeded), len(failed))
    for sku, err in failed:
        log.error("  FAIL %s: %s", sku, err)

    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
