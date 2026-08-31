"""
03_fashn_runner.py
===================
Drevi Photography Pipeline · Stage 3 · AI try-on via FASHN tryon-max.

For each (base_sku, color_code) group whose photos have been preprocessed
(Stage 1) and analysed by vision (Stage 2):

  1. Resolve brand model (A/B) and lifestyle Movement Pose via Brand Model Map
  2. Read per-angle prompts from the Master Sheet (Stage 2 output) — fall back
     to the Tryon Prompt Map for groups not yet seen by vision.
  3. For each of the 4 angles (front, back, side, lifestyle):
       a. Find the angle-matched garment image in PROCESSED
       b. Find the angle's brand-model pose image
       c. Submit to /v1/run (tryon-max) with seed = MD5(base_sku) + angle offset
       d. Poll /v1/status/<id>; on completed, download → upload to TRYON
  4. Finalise: re-encode detail.* / detail2.* into TRYON as JPEG so Shopify
     gets a uniform gallery in one folder.
  5. Writeback to all sibling rows: brand model, movement pose, seed, prompts,
     credit cost, failed angles, Photo Status → AI Done, Pipeline Status →
     Ready for Review.

By default, an angle whose output already exists in TRYON is skipped (no
credits burned). Pass `--regenerate` to force re-rendering.

Usage:
  python 03_fashn_runner.py                    # process all ready SKUs
  python 03_fashn_runner.py --sku DD-LEH-FLR-007
  python 03_fashn_runner.py --dry-run          # no API calls, just plan
  python 03_fashn_runner.py --max 5            # cap to 5 SKUs (cost control)
  python 03_fashn_runner.py --sku ... --regenerate   # force re-render
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from collections import defaultdict
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

from drevi_common import (
    COLS, DATA_START_ROW, DEFAULT_QUALITY_TIER, FASHN_BASE_URL,
    FASHN_MODEL_NAME, FASHN_POLL_INTERVAL_SEC, FASHN_POLL_TIMEOUT_SEC,
    LOCAL_DOWNLOADS, LOCAL_LOGS, LOCAL_TRYON, PHOTO_STATUS,
    PIPELINE_STATUS, STAGE_FAILED, angle_seed, base_sku_from_drevi_sku,
    download_drive_file, ensure_anyone_can_read, find_file_by_stem,
    first_sibling_value, get_drive_service, get_master_ws,
    get_or_create_subfolder, get_sheets_client,
    group_master_rows_by_base_color, group_matches_sku_filter,
    list_drive_folder,
    load_brand_model_map, load_master_schema,
    load_tryon_prompt_map, make_public_url,
    model_swap_angle_params, model_swap_credits, model_swap_total_credits,
    now_ist_iso, parse_drive_folder_id, photo_folder_name, read_master_rows,
    ANGLES, normalize_brand_model, resolve_angle_pose_filenames,
    resolve_brand_model_folder,
    resolve_brand_model, resolve_tryon_prompts, seed_for_sku,
    setup_logger, tier_angle_params, tier_total_credits, tryon_max_credits,
    update_cells, upload_file_to_drive, SheetSchema,
)


# =============================================================================
# CONFIG
# =============================================================================

# Brand model pose master files — these were generated once in Gemini Pro
# and live in the team's Shared Drive. Set via env var.
# Each pose is a 4K PNG, public read, fetched once and cached locally.
BRAND_MODEL_POSE_FOLDER_ENV = "DREVI_BRAND_MODEL_FOLDER_ID"

# =============================================================================
# FASHN API CLIENT
# =============================================================================

FASHN_SUBMIT_RETRIES = int(os.getenv("DREVI_FASHN_SUBMIT_RETRIES", "2"))
FASHN_OUTPUT_FORMAT = os.getenv("DREVI_FASHN_OUTPUT_FORMAT", "png")  # 'png' | 'jpeg'


class FashnClient:
    """Thin wrapper around FASHN tryon-max (see https://docs.fashn.ai/api-reference/tryon-max).

    Required inputs: model_image, product_image.
    Optional: prompt, resolution ('1k'|'2k'|'4k'), generation_mode
    ('balanced'|'quality'), seed, num_images, output_format ('png'|'jpeg').
    Credits per output: 2-5 by (resolution × generation_mode); see
    `tryon_max_credits()` in drevi_common.
    """

    def __init__(self, api_key: str, log):
        self.api_key = api_key
        self.log = log
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        })

    def submit_tryon(
        self,
        model_image_url: str,
        garment_image_url: str,
        *,
        resolution: str = "1k",
        generation_mode: str = "balanced",
        prompt: str = "",
        seed: int = 42,
        num_images: int = 1,
        output_format: Optional[str] = None,
    ) -> str:
        """Submit a tryon-max job. Returns prediction ID. Retries up to
        FASHN_SUBMIT_RETRIES on 5xx / network errors with exponential backoff."""
        inputs = {
            "model_image":     model_image_url,
            "product_image":   garment_image_url,
            "resolution":      resolution,
            "generation_mode": generation_mode,
            "seed":            int(seed),
            "num_images":      int(num_images),
            "output_format":   output_format or FASHN_OUTPUT_FORMAT,
        }
        if prompt:
            inputs["prompt"] = prompt

        payload = {"model_name": "tryon-max", "inputs": inputs}

        last_err: Optional[Exception] = None
        for attempt in range(FASHN_SUBMIT_RETRIES + 1):
            try:
                r = self.session.post(
                    f"{FASHN_BASE_URL}/run", json=payload, timeout=30,
                )
                if 500 <= r.status_code < 600:
                    raise RuntimeError(
                        f"FASHN /run {r.status_code}: {r.text[:200]}"
                    )
                if r.status_code != 200:
                    # 4xx → not retryable, surface immediately.
                    raise RuntimeError(
                        f"FASHN /run returned {r.status_code}: {r.text[:300]}"
                    )
                body = r.json()
                pred_id = body.get("id")
                if not pred_id:
                    raise RuntimeError(f"FASHN /run no id in response: {body}")
                return pred_id
            except (requests.RequestException, RuntimeError) as e:
                # Only retry on transient classes — RuntimeError above only
                # raised for 5xx; 4xx is wrapped in RuntimeError too but we
                # also have status code text in it, so cap retries at 5xx.
                last_err = e
                msg = str(e)
                if attempt < FASHN_SUBMIT_RETRIES and (
                    isinstance(e, requests.RequestException)
                    or " 5" in msg.split("/run", 1)[-1][:6]
                ):
                    backoff = 1.5 ** attempt
                    self.log.warning(
                        "FASHN /run attempt %d failed (%s); retrying in %.1fs",
                        attempt + 1, msg[:120], backoff,
                    )
                    time.sleep(backoff)
                    continue
                raise

        # Fallthrough — shouldn't reach here without an exception.
        raise RuntimeError(f"FASHN submit gave up: {last_err}")

    def submit_model_swap(
        self,
        *,
        source_image_url: str,         # local garment photo (preserves outfit + pose)
        face_reference_url: str,       # brand-model pose (identity to apply)
        resolution: str = "2k",
        generation_mode: str = "quality",
        prompt: str = "",
        seed: int = 42,
        num_images: int = 1,
        face_reference_mode: str = "match_base",
        output_format: Optional[str] = None,
    ) -> str:
        """Submit a model-swap job (FASHN's outfit-preserving endpoint).
        See https://docs.fashn.ai/api-reference/model-swap. Returns
        prediction ID. Same retry policy as submit_tryon.
        """
        inputs = {
            "model_image":         source_image_url,    # docs name: source for outfit + pose
            "face_reference":      face_reference_url,
            "face_reference_mode": face_reference_mode,
            "resolution":          resolution,
            "generation_mode":     generation_mode,
            "seed":                int(seed) & 0xFFFFFFFF,
            "num_images":          int(num_images),
            "output_format":       output_format or FASHN_OUTPUT_FORMAT,
        }
        if prompt:
            inputs["prompt"] = prompt

        payload = {"model_name": "model-swap", "inputs": inputs}

        last_err: Optional[Exception] = None
        for attempt in range(FASHN_SUBMIT_RETRIES + 1):
            try:
                r = self.session.post(
                    f"{FASHN_BASE_URL}/run", json=payload, timeout=30,
                )
                if 500 <= r.status_code < 600:
                    raise RuntimeError(
                        f"FASHN /run {r.status_code}: {r.text[:200]}"
                    )
                if r.status_code != 200:
                    raise RuntimeError(
                        f"FASHN /run returned {r.status_code}: {r.text[:300]}"
                    )
                body = r.json()
                pred_id = body.get("id")
                if not pred_id:
                    raise RuntimeError(f"FASHN /run no id in response: {body}")
                return pred_id
            except (requests.RequestException, RuntimeError) as e:
                last_err = e
                msg = str(e)
                if attempt < FASHN_SUBMIT_RETRIES and (
                    isinstance(e, requests.RequestException)
                    or " 5" in msg.split("/run", 1)[-1][:6]
                ):
                    backoff = 1.5 ** attempt
                    self.log.warning(
                        "FASHN model-swap /run attempt %d failed (%s); retrying in %.1fs",
                        attempt + 1, msg[:120], backoff,
                    )
                    time.sleep(backoff)
                    continue
                raise
        raise RuntimeError(f"FASHN model-swap submit gave up: {last_err}")

    def poll_status(self, pred_id: str) -> dict:
        """Poll until completion or timeout. Returns the final response body.

        Transient network errors on individual polls (ReadTimeout,
        ConnectionError) are caught and treated as 'not ready yet' — we
        sleep and retry inside the same overall deadline. This avoids the
        old failure mode where a single slow FASHN response (we observed
        plenty in the batch) aborted the whole angle and wasted 8 credits.
        """
        from requests.exceptions import ReadTimeout, ConnectTimeout, ConnectionError as ReqConnError
        deadline = time.time() + FASHN_POLL_TIMEOUT_SEC
        while time.time() < deadline:
            try:
                r = self.session.get(
                    f"{FASHN_BASE_URL}/status/{pred_id}", timeout=60,
                )
            except (ReadTimeout, ConnectTimeout, ReqConnError) as e:
                self.log.warning("Status poll %s transient network error "
                                 "(%s); retrying...", pred_id, type(e).__name__)
                time.sleep(FASHN_POLL_INTERVAL_SEC)
                continue
            if r.status_code != 200:
                self.log.warning("Status poll %s returned %d, retrying...",
                                 pred_id, r.status_code)
                time.sleep(FASHN_POLL_INTERVAL_SEC)
                continue
            body = r.json()
            status = body.get("status")
            if status == "completed":
                return body
            if status == "failed":
                err = body.get("error", "unknown")
                raise RuntimeError(f"FASHN job {pred_id} failed: {err}")
            time.sleep(FASHN_POLL_INTERVAL_SEC)
        raise TimeoutError(f"FASHN job {pred_id} did not complete within "
                           f"{FASHN_POLL_TIMEOUT_SEC}s")

    def get_credits(self) -> Optional[float]:
        """Return remaining credit balance. Returns None on error."""
        try:
            r = self.session.get(f"{FASHN_BASE_URL}/credits", timeout=10)
            if r.status_code == 200:
                return r.json().get("credits")
        except Exception:
            pass
        return None


# =============================================================================
# WORKFLOW
# =============================================================================

def find_pose_image_url(
    drive,
    pose_folder_id: str,
    pose_filename: str,
    log,
    pose_listing: Optional[List[Dict]] = None,
) -> Tuple[str, str]:
    """Locate a pose image in the brand model folder. Returns
    (file_id, public_url). Raises if not found.

    `pose_listing` lets the caller list the pose folder once per SKU and
    pass it in for all 4 angles — avoids the 4× redundant Drive list.
    """
    files = pose_listing if pose_listing is not None else list_drive_folder(
        drive, pose_folder_id,
    )
    by_name = {(f.get("name") or "").lower(): f for f in files}
    if pose_filename.lower() not in by_name:
        raise RuntimeError(
            f"Brand model pose not found: {pose_filename} in folder {pose_folder_id}. "
            f"Available: {list(by_name.keys())[:5]}"
        )
    fid = by_name[pose_filename.lower()]["id"]
    try:
        ensure_anyone_can_read(drive, fid)
    except Exception as e:
        log.warning("could not set anyone-read on pose %s: %s", fid, e)
    return fid, make_public_url(fid)


def find_processed_garment_url(
    drive,
    processed_folder_id: str,
    angle_filename: str,
) -> Tuple[str, str]:
    """Locate the processed garment image for a given angle.
    Returns (file_id, public_url).
    """
    files = list_drive_folder(drive, processed_folder_id)
    by_name = {f["name"].lower(): f for f in files}
    if angle_filename.lower() not in by_name:
        raise RuntimeError(
            f"Processed garment not found: {angle_filename} in folder "
            f"{processed_folder_id}. Did preprocessing run successfully?"
        )
    fid = by_name[angle_filename.lower()]["id"]
    ensure_anyone_can_read(drive, fid)
    return fid, make_public_url(fid)


def _output_ext_and_mime() -> Tuple[str, str]:
    if FASHN_OUTPUT_FORMAT.lower() == "jpeg":
        return ".jpg", "image/jpeg"
    return ".png", "image/png"


def process_one_angle(
    fashn: FashnClient,
    drive,
    angle: str,
    garment_url: str,
    pose_url: str,
    *,
    fashn_mode: str,             # "tryon-max" | "model-swap"
    resolution: str,
    generation_mode: str,
    prompt: str,
    seed: int,
    output_folder_id: str,
    base_sku: str,
    log,
) -> Tuple[bool, Optional[str], Optional[str]]:
    """Run one FASHN call for one angle, dispatching by fashn_mode.

    For fashn_mode == "tryon-max":
        model_image   = pose_url      (brand-model body to dress)
        product_image = garment_url   (garment to overlay)

    For fashn_mode == "model-swap":
        model_image    = garment_url  (source — preserves outfit + pose)
        face_reference = pose_url     (identity to apply)

    Returns (success, output_drive_url, error_message).
    """
    log.info("    Submitting %s (mode=%s, res=%s, gen=%s, seed=%d, prompt=%r)...",
             angle, fashn_mode, resolution, generation_mode, seed, prompt[:60])
    try:
        if fashn_mode == "model-swap":
            pred_id = fashn.submit_model_swap(
                source_image_url=garment_url,
                face_reference_url=pose_url,
                resolution=resolution,
                generation_mode=generation_mode,
                prompt=prompt,
                seed=seed,
                face_reference_mode="match_base",
            )
        else:
            pred_id = fashn.submit_tryon(
                model_image_url=pose_url,
                garment_image_url=garment_url,
                resolution=resolution,
                generation_mode=generation_mode,
                prompt=prompt,
                seed=seed,
            )
    except Exception as e:
        return False, None, f"submit failed: {e}"

    log.info("      → prediction %s, polling...", pred_id)
    try:
        result = fashn.poll_status(pred_id)
    except Exception as e:
        return False, None, f"poll failed: {e}"

    output_urls = result.get("output") or []
    if not output_urls:
        return False, None, f"no output urls in response: {result}"
    src_url = output_urls[0]

    out_ext, out_mime = _output_ext_and_mime()
    out_local = LOCAL_TRYON / base_sku / f"{angle}{out_ext}"
    out_local.parent.mkdir(parents=True, exist_ok=True)
    try:
        r = requests.get(src_url, timeout=60)
        r.raise_for_status()
        out_local.write_bytes(r.content)
    except Exception as e:
        return False, None, f"download failed: {e}"

    try:
        f = upload_file_to_drive(
            drive, out_local, output_folder_id,
            name=f"{angle}{out_ext}", mime_type=out_mime,
        )
        try:
            ensure_anyone_can_read(drive, f["id"])
        except Exception as e:
            log.warning("    [%s] anyone-read on output failed: %s", angle, e)
    except Exception as e:
        return False, None, f"drive upload failed: {e}"

    return True, f.get("webViewLink", make_public_url(f["id"])), None


def _existing_angle_output(
    angle: str, output_files_by_name: Dict[str, Dict],
) -> Optional[Dict]:
    """Return the existing TRYON file for this angle (any extension) or None."""
    for ext in (".png", ".jpg", ".jpeg"):
        candidate = f"{angle}{ext}".lower()
        if candidate in output_files_by_name:
            return output_files_by_name[candidate]
    return None


def _convert_local_to_jpeg(src_path: Path, dst_path: Path, quality: int = 98) -> None:
    """Re-encode any source image (HEIC, PNG, JPG) to JPEG. Used when finalising
    detail shots into TRYON so the gallery is uniformly JPEG/PNG."""
    from PIL import Image  # lazy
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        pass
    img = Image.open(src_path)
    if img.mode != "RGB":
        img = img.convert("RGB")
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst_path, format="JPEG", quality=quality)


def process_one_sku(
    siblings: List[Dict],
    fashn: FashnClient,
    drive,
    brand_model_map,
    tryon_prompt_map,
    output_root_id: str,
    brand_model_root_id: str,
    log,
    dry_run: bool = False,
    regenerate: bool = False,
) -> Dict[str, Any]:
    """Process all 4 angles for one SKU group (siblings share photos).
    Returns a dict to write back to all sibling rows.

    Garment images come from PROCESSED (Stage 1 output). Per-angle prompts
    come from the Master Sheet (Stage 2 vision); the Tryon Prompt Map is
    a category-level fallback only.

    `regenerate=False` (default) skips angles whose output already exists in
    the per-SKU TRYON folder. `regenerate=True` always re-renders.
    """
    first = siblings[0]
    drevi_sku = first["drevi_sku"]
    base_sku = base_sku_from_drevi_sku(drevi_sku)
    cat_code = first.get("cat_code", "")
    sub_code = first.get("sub_code", "")
    color_code = first.get("color_code", "")
    quality_tier = (first.get("image_quality_tier") or "standard").strip().lower()
    # FASHN Mode is set by Stage 2 vision based on embellishment level.
    # Default to tryon-max for SKUs that haven't been through vision yet.
    fashn_mode = (first.get("fashn_mode") or "tryon-max").strip().lower()
    if fashn_mode not in ("tryon-max", "model-swap"):
        log.warning("  Unknown fashn_mode=%r — defaulting to tryon-max", fashn_mode)
        fashn_mode = "tryon-max"

    # 1. Resolve config-driven values
    brand_model, movement_pose = resolve_brand_model(cat_code, sub_code, brand_model_map)
    # Only models A and B are in use; clamp anything else (e.g. legacy C) to A.
    brand_model = normalize_brand_model(brand_model, log)

    # Per-SKU prompts from Stage 2 vision win; fall back to category-level
    # Tryon Prompt Map for SKUs that haven't been through vision yet.
    sheet_prompts = {
        "front":     first_sibling_value(siblings, "tryon_prompt_front"),
        "back":      first_sibling_value(siblings, "tryon_prompt_back"),
        "side":      first_sibling_value(siblings, "tryon_prompt_side"),
        "lifestyle": first_sibling_value(siblings, "tryon_prompt_life"),
    }
    tpm_prompts = resolve_tryon_prompts(cat_code, sub_code, tryon_prompt_map)
    prompts = {
        angle: sheet_prompts[angle] or tpm_prompts.get(angle, "")
        for angle in ANGLES
    }
    sheet_used = sum(1 for a in ANGLES if sheet_prompts[a])
    log.info("  Prompts: %d/4 from vision (sheet), %d/4 from Tryon Prompt Map",
             sheet_used, 4 - sheet_used)

    # Per-angle FASHN params. The lookup function depends on which endpoint
    # we're using — tryon-max and model-swap have separate per-angle matrices
    # (see TIER_TO_ANGLE_PARAMS and MODEL_SWAP_TIER_PARAMS in drevi_common).
    # Front + back always get the best config the tier supports; side +
    # lifestyle get a cheaper one. tier comes from the row's
    # Image Quality Tier column; empty => standard.
    effective_tier = (quality_tier or DEFAULT_QUALITY_TIER).strip().lower()
    if fashn_mode == "model-swap":
        angle_params: Dict[str, Tuple[str, str]] = {
            a: model_swap_angle_params(effective_tier, a) for a in ANGLES
        }
        per_angle_cost_fn = model_swap_credits
        total_budget = model_swap_total_credits(effective_tier)
    else:
        angle_params = {
            a: tier_angle_params(effective_tier, a) for a in ANGLES
        }
        per_angle_cost_fn = tryon_max_credits
        total_budget = tier_total_credits(effective_tier)
    seed_base = seed_for_sku(base_sku)

    log.info("---- %s (cat=%s, sub=%s, tier=%s, fashn_mode=%s) ----",
             drevi_sku, cat_code, sub_code, effective_tier, fashn_mode)
    log.info("  Brand Model: %s | Movement Pose: %s",
             brand_model, movement_pose)
    log.info("  %s per-angle:", fashn_mode)
    for a in ANGLES:
        res, gen = angle_params[a]
        log.info("    %-9s %s/%s (%d cr/img)",
                 a, res, gen, per_angle_cost_fn(res, gen))
    log.info("  Total budgeted: %d credits/SKU", total_budget)

    # 2. Garment source — always PROCESSED.
    processed_url = first.get("processed_url", "")
    if not processed_url:
        return {"_error": (
            "Processed Folder URL is empty — Stage 1 (preprocess) hasn't "
            "run for this SKU yet."
        )}
    try:
        garment_folder_id = parse_drive_folder_id(processed_url)
    except ValueError as e:
        return {"_error": f"Invalid processed_url: {e}"}

    log.info("  Garment source: PROCESSED (folder=%s)", garment_folder_id)

    garment_files = list_drive_folder(drive, garment_folder_id)
    garment_by_name = {(f.get("name") or "").lower(): f for f in garment_files}

    pose_folder_id = resolve_brand_model_folder(drive, brand_model_root_id, brand_model)
    pose_listing = list_drive_folder(drive, pose_folder_id)  # cached, used 4x

    # Output folder per SKU (under TRYON root)
    folder_name = photo_folder_name(drevi_sku, color_code)
    sku_output_id = get_or_create_subfolder(drive, output_root_id, folder_name)
    try:
        ensure_anyone_can_read(drive, sku_output_id)
    except Exception as e:
        log.warning("  anyone-read on TRYON folder failed: %s", e)

    # Existing output snapshot — used for idempotency skip.
    existing_outputs = list_drive_folder(drive, sku_output_id)
    existing_by_name = {(f.get("name") or "").lower(): f for f in existing_outputs}

    if dry_run:
        log.info("  DRY RUN — would call FASHN up to %d times (seed_base=%d)",
                 len(ANGLES), seed_base)
        return {"_dry_run": True}

    # 3. Per-angle processing — pose filenames are model-specific (Model A
    # uses flat angle-named files; Model B uses pose_NN_* with the lifestyle
    # slot driven by the normalized movement pose).
    angle_to_pose_filename = resolve_angle_pose_filenames(
        brand_model, movement_pose, log,
    )
    log.info("  Pose files [%s]: %s", brand_model,
             ", ".join(f"{a}={angle_to_pose_filename[a]}" for a in ANGLES))

    failed_angles: List[str] = []
    skipped_angles: List[str] = []
    credits_used = 0

    for angle in ANGLES:
        # Idempotency — skip if output already exists, unless --regenerate.
        existing = _existing_angle_output(angle, existing_by_name)
        if existing and not regenerate:
            log.info("    [%s] SKIP (already in TRYON: %s, --regenerate to redo)",
                     angle, existing.get("name"))
            skipped_angles.append(angle)
            continue

        m = find_file_by_stem(garment_by_name, angle)
        if m is None:
            failed_angles.append(angle)
            log.error("    [%s] no garment file with stem '%s' in PROCESSED",
                      angle, angle)
            continue
        try:
            ensure_anyone_can_read(drive, m["id"])
        except Exception as e:
            failed_angles.append(angle)
            log.error("    [%s] anyone-read on garment failed: %s", angle, e)
            continue
        garment_url = make_public_url(m["id"])

        try:
            _, pose_url = find_pose_image_url(
                drive, pose_folder_id, angle_to_pose_filename[angle], log,
                pose_listing=pose_listing,
            )
        except Exception as e:
            failed_angles.append(angle)
            log.error("    [%s] could not locate pose image: %s", angle, e)
            continue

        seed = angle_seed(base_sku, angle)
        res, gen = angle_params[angle]
        ok, _, err = process_one_angle(
            fashn=fashn,
            drive=drive,
            angle=angle,
            garment_url=garment_url,
            pose_url=pose_url,
            fashn_mode=fashn_mode,
            resolution=res,
            generation_mode=gen,
            prompt=prompts.get(angle, ""),
            seed=seed,
            output_folder_id=sku_output_id,
            base_sku=base_sku,
            log=log,
        )
        if ok:
            angle_cost = per_angle_cost_fn(res, gen)
            credits_used += angle_cost
            log.info("    [%s] OK (+%d cr)", angle, angle_cost)
        else:
            failed_angles.append(angle)
            log.error("    [%s] FAIL: %s", angle, err)

    # Finalise: copy detail.* / detail2.* from PROCESSED into TRYON, always
    # re-encoded as JPEG so the gallery is uniform regardless of whether
    # CONVERT_DETAIL_HEIC was on or off during preprocess.
    processed_root = os.environ.get("DREVI_PROCESSED_FOLDER_ID")
    if processed_root:
        try:
            processed_sku_folder_id = get_or_create_subfolder(
                drive, processed_root, photo_folder_name(base_sku, color_code),
            )
            processed_files = list_drive_folder(drive, processed_sku_folder_id)
            tmp_dir = LOCAL_TRYON / base_sku / "_finalise"
            tmp_dir.mkdir(parents=True, exist_ok=True)
            for stem in ("detail", "detail2"):
                src = find_file_by_stem(processed_files, stem)
                if not src:
                    log.info("    [%s] not in PROCESSED — skipped finalise", stem)
                    continue
                src_ext = Path(src.get("name", "")).suffix.lower() or ".jpg"
                local_src = tmp_dir / f"{stem}{src_ext}"
                local_dst = tmp_dir / f"{stem}.jpg"
                try:
                    download_drive_file(drive, src["id"], local_src)
                    if src_ext in (".jpg", ".jpeg"):
                        # No re-encode needed; just upload original bytes.
                        local_dst = local_src
                        target_name = f"{stem}.jpg"
                    else:
                        _convert_local_to_jpeg(local_src, local_dst)
                        target_name = f"{stem}.jpg"
                    upload_file_to_drive(
                        drive, local_dst, sku_output_id,
                        name=target_name, mime_type="image/jpeg",
                    )
                    log.info("    [%s] finalised into TRYON as %s", stem, target_name)
                except Exception as e:
                    log.warning("    [%s] finalise failed: %s", stem, e)
        except Exception as e:
            log.warning("  detail finalise step failed: %s", e)

    output_folder_url = f"https://drive.google.com/drive/folders/{sku_output_id}"

    return {
        "brand_model": brand_model,
        "movement_pose": movement_pose,
        "image_seed_base": str(seed_base),
        "tryon_prompt_front": prompts["front"],
        "tryon_prompt_back":  prompts["back"],
        "tryon_prompt_side":  prompts["side"],
        "tryon_prompt_life":  prompts["lifestyle"],
        "output_folder_url":  output_folder_url,
        "tryon_credit_cost":  str(credits_used),
        "tryon_failed":       json.dumps(failed_angles) if failed_angles else "",
        "_failed_count":      len(failed_angles),
        "_skipped_count":     len(skipped_angles),
    }


# =============================================================================
# MAIN
# =============================================================================

def main() -> int:
    parser = argparse.ArgumentParser(description="Drevi FASHN try-on runner")
    parser.add_argument("--sku")
    parser.add_argument("--force", action="store_true",
                        help="Bypass Photo Status check. Use with --sku to force "
                             "FASHN run on a specific SKU regardless of state.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max", type=int, default=0,
                        help="Stop after N SKUs (cost control). 0 = no limit")
    parser.add_argument("--regenerate", action="store_true",
                        help="Re-render angles whose output already exists in "
                             "TRYON. Default behaviour skips them to save credits.")
    parser.add_argument("--allow-empty-prompts", action="store_true",
                        help="Run FASHN even if Stage 2 vision hasn't filled "
                             "Tryon Prompt - Front. Not recommended.")
    args = parser.parse_args()

    log = setup_logger(
        "drevi.fashn",
        LOCAL_LOGS / f"fashn_{now_ist_iso().replace(':', '').replace(' ', '_')}.log"
    )

    log.info("=" * 60)
    log.info("Drevi FASHN Runner · v1.0")
    log.info("=" * 60)
    log.info("Dry run: %s", args.dry_run)

    # API key check
    fashn_key = os.environ.get("FASHN_API_KEY")
    if not fashn_key and not args.dry_run:
        log.error("FASHN_API_KEY env var not set.")
        return 1

    brand_model_root_id = os.environ.get(BRAND_MODEL_POSE_FOLDER_ENV)
    if not brand_model_root_id and not args.dry_run:
        log.error("%s env var not set. Should point at the Drive folder "
                  "containing model-a/ and model-b/ subfolders.",
                  BRAND_MODEL_POSE_FOLDER_ENV)
        return 1

    output_root_id = os.environ.get("DREVI_TRYON_FOLDER_ID")
    if not output_root_id and not args.dry_run:
        log.error("DREVI_TRYON_FOLDER_ID env var not set. "
                  "Should be the Drive folder where TRYON outputs go.")
        return 1

    # Connect
    client = get_sheets_client()
    drive = get_drive_service()
    ws = get_master_ws(client)
    schema = load_master_schema(ws)
    brand_model_map = load_brand_model_map(client)
    tryon_prompt_map = load_tryon_prompt_map(client)
    log.info("Brand Model Map: %d rows", len(brand_model_map))
    log.info("Tryon Prompt Map: %d rows (fallback only — per-SKU prompts win)",
             len(tryon_prompt_map))

    fashn = FashnClient(fashn_key or "", log)
    if not args.dry_run:
        bal = fashn.get_credits()
        if bal is not None:
            log.info("FASHN credit balance: %s", bal)

    # Read all rows and group by (base, color)
    all_rows = read_master_rows(ws, schema)
    all_groups = group_master_rows_by_base_color(all_rows)

    if args.force and not args.sku:
        log.error("--force requires --sku to be specified.")
        return 1

    # ----- Decide what to do for each group -----
    # Modes:
    #   "process"   - run FASHN tryon (overwrites Drive output if --force)
    #   "propagate" - group already has Tryon outputs; copy to siblings
    #   skip        - nothing to do
    #
    # Trigger logic (Photo Status is the single source of truth):
    #   --sku given       -> data-driven, runs as long as Processed URL exists.
    #   no --sku, default -> Photo Status == "Vision Done".
    #
    # Garment-image source is always PROCESSED.
    valid_trigger_states = {PHOTO_STATUS["VISION_DONE"]}

    plan: List[Tuple[Tuple[str, str], List[Dict[str, Any]], str]] = []
    for key, siblings in all_groups.items():
        if not group_matches_sku_filter(siblings, args.sku):
            continue
        existing_tryon_url = first_sibling_value(siblings, "output_folder_url")

        # Prerequisite: PROCESSED folder must exist. With the new state machine
        # this is implied by Photo Status == Vision Done, but keep the guard
        # for --sku data-driven runs where status may be off.
        if not first_sibling_value(siblings, "processed_url"):
            continue

        # When the user is overriding the trigger via --sku, optionally allow
        # empty Stage-2 prompts. Default refuses so FASHN doesn't fall back
        # to tryon-max defaults (e.g. long-skirt-rendered-as-pants).
        if (args.sku and not args.allow_empty_prompts
                and not first_sibling_value(siblings, "tryon_prompt_front")):
            log.info("Skipping %s/%s — Stage 2 prompts not yet on sheet "
                     "(use --allow-empty-prompts to override)",
                     key[0], key[1] or "_")
            continue

        # Determine if this group is in scope (separate from process/propagate)
        if args.sku:
            in_scope = True  # data-driven via --sku
        else:
            in_scope = any(
                r.get("photo_status") in valid_trigger_states for r in siblings
            )
        if not in_scope:
            continue

        # Determine mode
        if args.force:
            mode = "process"
        elif existing_tryon_url:
            # Already has Tryon output. Propagate to siblings without it.
            if args.sku:
                needs_propagation = any(
                    not (r.get("output_folder_url") or "").strip()
                    for r in siblings
                )
            else:
                needs_propagation = any(
                    not (r.get("output_folder_url") or "").strip()
                    and r.get("photo_status") in valid_trigger_states
                    for r in siblings
                )
            if not needs_propagation:
                continue
            mode = "propagate"
        else:
            mode = "process"
        plan.append((key, siblings, mode))

    log.info("Groups to process: %d (force=%s, sku=%s)",
             len(plan), args.force, args.sku or "(none)")

    # Apply --max cap to actual-process groups (cost control)
    if args.max > 0:
        process_count = 0
        capped_plan = []
        for entry in plan:
            _, _, mode = entry
            if mode == "process":
                if process_count >= args.max:
                    continue
                process_count += 1
            capped_plan.append(entry)
        plan = capped_plan

    success = 0
    failed = 0
    propagate_count = 0

    for (base, color), siblings, mode in plan:
        log.info("")
        log.info("Group %s/%s (%d siblings) · mode=%s",
                 base, color, len(siblings), mode)

        # ---- Mode: propagate ----
        if mode == "propagate":
            if args.dry_run:
                log.info("  DRY RUN — would propagate Tryon outputs to siblings")
                continue

            # FASHN-side fields
            propagate_keys = (
                "output_folder_url", "brand_model", "movement_pose",
                "image_seed_base", "tryon_prompt_front", "tryon_prompt_back",
                "tryon_prompt_side", "tryon_prompt_life", "tryon_credit_cost",
                "tryon_failed",
                # Stage-2 fields. Normally already in sync because Stage 2 writes
                # every sibling, but if vision was run on a subset (e.g. --sku),
                # these may be missing on sibling rows.
                "product_name", "description", "meta_title", "meta_description",
                "ai_occasions", "ai_tags", "dominant_hex", "copy_generated_at",
                "image_quality_tier", "style",
            )
            propagated = {
                k: first_sibling_value(siblings, k) for k in propagate_keys
            }
            log.info("  Propagating Tryon URL %s to %d siblings",
                     propagated.get("output_folder_url"), len(siblings))
            for r in siblings:
                writeback: Dict[str, Any] = {
                    schema.col_letter("photo_status"):    PHOTO_STATUS["TRYON_DONE"],
                    schema.col_letter("pipeline_status"): PIPELINE_STATUS["READY_FOR_REVIEW"],
                }
                for k, v in propagated.items():
                    if v:
                        writeback[schema.col_letter(k)] = v
                update_cells(ws, r["_row"], writeback)
            propagate_count += 1
            continue

        # ---- Mode: process ----
        try:
            result = process_one_sku(
                siblings=siblings,
                fashn=fashn,
                drive=drive,
                brand_model_map=brand_model_map,
                tryon_prompt_map=tryon_prompt_map,
                output_root_id=output_root_id or "",
                brand_model_root_id=brand_model_root_id or "",
                log=log,
                dry_run=args.dry_run,
                regenerate=args.regenerate,
            )
        except Exception as e:
            log.error("CRASH: %s\n%s", e, traceback.format_exc())
            result = {"_error": f"Unhandled: {e}"}

        if "_error" in result:
            log.error("FAILED: %s", result["_error"])
            failed += 1
            if not args.dry_run:
                for r in siblings:
                    update_cells(ws, r["_row"], {
                        schema.col_letter("photo_status"): STAGE_FAILED["tryon"],
                    })
            continue

        if args.dry_run:
            continue

        # Decide downstream status. A SKU is "Tryon Done" if at least one
        # angle either succeeded this run or already had output in TRYON
        # (idempotent skip path). Per Drevi's policy, partial success still
        # counts as Tryon Done — Tryon Failed Angles JSON carries the detail
        # for any angles Grishma might want to re-run with --regenerate.
        produced_or_existing = (
            len(ANGLES) - result.get("_failed_count", 0)
        )
        any_succeeded = produced_or_existing > 0
        new_photo_status = (
            PHOTO_STATUS["TRYON_DONE"] if any_succeeded else STAGE_FAILED["tryon"]
        )

        for r in siblings:
            row_writeback: Dict[str, Any] = {
                schema.col_letter("brand_model"):        result["brand_model"],
                schema.col_letter("movement_pose"):      result["movement_pose"],
                schema.col_letter("image_seed_base"):    result["image_seed_base"],
                schema.col_letter("tryon_prompt_front"): result["tryon_prompt_front"],
                schema.col_letter("tryon_prompt_back"):  result["tryon_prompt_back"],
                schema.col_letter("tryon_prompt_side"):  result["tryon_prompt_side"],
                schema.col_letter("tryon_prompt_life"):  result["tryon_prompt_life"],
                schema.col_letter("output_folder_url"):  result["output_folder_url"],
                schema.col_letter("tryon_credit_cost"):  result["tryon_credit_cost"],
                schema.col_letter("tryon_failed"):       result["tryon_failed"],
                schema.col_letter("photo_status"):       new_photo_status,
            }
            if any_succeeded:
                # Pipeline Status advances only when FASHN finishes successfully —
                # at this point the gallery is in TRYON and copy is already on
                # the sheet from Stage 2, so the SKU is genuinely review-ready.
                row_writeback[schema.col_letter("pipeline_status")] = (
                    PIPELINE_STATUS["READY_FOR_REVIEW"]
                )
            update_cells(ws, r["_row"], row_writeback)
        if any_succeeded:
            success += 1
        else:
            failed += 1

    log.info("")
    log.info("=" * 60)
    log.info("DONE · %d processed · %d propagated · %d failed",
             success, propagate_count, failed)
    log.info("=" * 60)
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
