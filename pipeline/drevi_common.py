"""
drevi_common.py
================
Shared configuration, Google Sheets/Drive helpers, and column lookup logic.

Used by all four pipeline scripts:
  - 01_preprocess.py    (white-balance correction + crop)
  - 02_fashn_runner.py  (AI try-on via FASHN API)
  - 03_copy_generator.py (LLM copy generation)
  - 04_orchestrator.py  (runs all three in sequence)

Environment variables expected (set per-session, not persisted):
  GOOGLE_APPLICATION_CREDENTIALS  Path to service account JSON
  FASHN_API_KEY                   FASHN API key (used by 02)
  ANTHROPIC_API_KEY               Anthropic API key (used by 03)

The Drevi master sheet has a 2-row header layout: row 1 = SECTION labels
with merged cells, row 2 = column names. We treat (SECTION/COLUMN) as the
joined effective header and resolve via partial matching, mirroring the
Apps Script's findColumn() helper.
"""

from __future__ import annotations

import os
import re
import sys
import json
import time
import hashlib
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from collections import defaultdict

# Third-party imports — installed via:  pip install gspread google-auth google-api-python-client requests
import gspread
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload

# Pillow + pillow-heif are imported lazily by Stage 1 / vision helpers below
# so the module can be imported in environments without image libs (e.g. a
# Sheets-only smoke test).


# =============================================================================
# 1. CONFIGURATION
# =============================================================================

# Drevi Product Master sheet — same ID used by the Apps Script
# Overridable via env: DREVI_SHEET_ID lets the whole pipeline run against an
# alternate master (e.g. the temporary "Wholesale Drevi Product Master" used
# for the CMAI exhibition flow) without any code changes.
SHEET_ID = os.getenv("DREVI_SHEET_ID",
                     "1FbI2SBWqBC6Wy8oTLtModXXvDKHbpIdQPRO32g2ivr0")
MASTER_TAB = "Master"

# Header layout (matches the live sheet today; v1.2 of the schema script
# preserves this layout)
HEADER_SECTION_ROW = 1   # IDENTITY / AUTO FROM SKU / etc.
HEADER_COLUMN_ROW = 2    # Drevi SKU / Cat Code / etc.
DATA_START_ROW = 3       # First SKU row

# Local working directories (all under /home/<user>/drevi)
LOCAL_ROOT = Path(os.environ.get("DREVI_LOCAL_ROOT", str(Path.home() / "drevi")))
LOCAL_DOWNLOADS = LOCAL_ROOT / "downloads"   # raw photos pulled from Drive
LOCAL_PROCESSED = LOCAL_ROOT / "processed"   # color-corrected outputs
LOCAL_TRYON = LOCAL_ROOT / "tryon"           # FASHN outputs
LOCAL_LOGS = LOCAL_ROOT / "logs"             # per-run logs

# Photography contract — see operations manual section 05
# We accept multiple input extensions because iPhone defaults to HEIC since
# iOS 11. The pipeline reads any accepted extension and writes all outputs
# as JPEG so downstream stages (FASHN, Shopify) get a single consistent format.
EXPECTED_STEMS_FULL_BODY = ["front", "back", "side", "lifestyle"]
EXPECTED_STEMS_DETAIL = ["detail", "detail2"]
EXPECTED_STEMS_ALL = EXPECTED_STEMS_FULL_BODY + EXPECTED_STEMS_DETAIL
ACCEPTED_EXTENSIONS = (".jpg", ".jpeg", ".heic", ".heif", ".png")

# Output extension for converted/cropped files. Mannequin shots that are
# already JPG pass through with no re-encode; HEIC shots are converted to
# JPEG. Every output that the pipeline writes ends in .jpg.
OUTPUT_EXTENSION = ".jpg"

# FASHN configuration
FASHN_BASE_URL = "https://api.fashn.ai/v1"
FASHN_MODEL_NAME = "tryon-max"    # premium endpoint — uses 'product_image' input
                                  # (not 'garment_image' like tryon-v1.6)
FASHN_POLL_INTERVAL_SEC = int(os.getenv("DREVI_FASHN_POLL_INTERVAL_SEC", "3"))
# 4k model-swap jobs can exceed 180s under FASHN load. Env-overridable so a
# slow/congested run can widen the window without a code change.
FASHN_POLL_TIMEOUT_SEC = int(os.getenv("DREVI_FASHN_POLL_TIMEOUT_SEC", "180"))

# Quality tier → per-angle (resolution, generation_mode) for tryon-max.
# tryon-max splits what v1.6 calls `mode` into two orthogonal axes:
#   resolution      ∈ {'1k', '2k', '4k'}   — output size in megapixels
#   generation_mode ∈ {'balanced', 'quality'} — quality of generation
#
# Credits per output (per FASHN docs):
#       1k    2k    4k
#   bal  2     3     4
#   qual 3     4     5
#
# Drevi splits the angles by importance. Front + back are the primary listing
# images and get the best config the tier supports; side and lifestyle are
# ancillary so they get a cheaper config. Locked May 2026:
#
#   standard   front/back: 2k qual (4 cr)   side/lifestyle: 1k qual (3 cr)   = 14/SKU
#   hero_lite  front/back: 2k qual (4 cr)   side/lifestyle: 2k qual (4 cr)   = 16/SKU
#   hero       front/back: 4k qual (5 cr)   side/lifestyle: 2k qual (4 cr)   = 18/SKU
#   bridal     front/back: 4k qual (5 cr)   side/lifestyle: 4k qual (5 cr)   = 20/SKU
TIER_TO_ANGLE_PARAMS: Dict[str, Dict[str, Tuple[str, str]]] = {
    "standard": {
        "front":     ("2k", "quality"),
        "back":      ("2k", "quality"),
        "side":      ("1k", "quality"),
        "lifestyle": ("1k", "quality"),
    },
    "hero_lite": {
        "front":     ("2k", "quality"),
        "back":      ("2k", "quality"),
        "side":      ("2k", "quality"),
        "lifestyle": ("2k", "quality"),
    },
    "hero": {
        "front":     ("4k", "quality"),
        "back":      ("4k", "quality"),
        "side":      ("2k", "quality"),
        "lifestyle": ("2k", "quality"),
    },
    "bridal": {
        "front":     ("4k", "quality"),
        "back":      ("4k", "quality"),
        "side":      ("4k", "quality"),
        "lifestyle": ("4k", "quality"),
    },
}

# Default tier when Image Quality Tier column is empty/unknown.
DEFAULT_QUALITY_TIER = "standard"

# Credits per output for tryon-max (used for accurate credit accounting).
TRYON_MAX_CREDITS = {
    ("1k", "balanced"): 2, ("1k", "quality"): 3,
    ("2k", "balanced"): 3, ("2k", "quality"): 4,
    ("4k", "balanced"): 4, ("4k", "quality"): 5,
}


# =============================================================================
# 1d. MODEL-SWAP CONFIG (Stage 3, embellished-garment path)
# =============================================================================
# model-swap is used when the source garment has medium/heavy/bridal-tier
# embellishment that tryon-max would smooth or simplify. It preserves the
# source's outfit pixels verbatim and only swaps the person's identity via
# `face_reference`. We always set face_reference to the brand-model pose,
# so we always pay the +3 cr/output surcharge.
#
# Locked May 2026 — quality-only matrix, same per-angle prioritisation as
# tryon-max (front+back at the best the tier supports; side+lifestyle drop):
#
#   standard   front/back: 2k qual+ref (7 cr)   side/lifestyle: 1k qual+ref (6 cr)   = 26/SKU
#   hero_lite  front/back: 2k qual+ref (7 cr)   side/lifestyle: 2k qual+ref (7 cr)   = 28/SKU
#   hero       front/back: 4k qual+ref (8 cr)   side/lifestyle: 2k qual+ref (7 cr)   = 30/SKU
#   bridal     front/back: 4k qual+ref (8 cr)   side/lifestyle: 4k qual+ref (8 cr)   = 32/SKU
MODEL_SWAP_TIER_PARAMS: Dict[str, Dict[str, Tuple[str, str]]] = {
    "standard": {
        "front":     ("2k", "quality"),
        "back":      ("2k", "quality"),
        "side":      ("1k", "quality"),
        "lifestyle": ("1k", "quality"),
    },
    "hero_lite": {
        "front":     ("2k", "quality"),
        "back":      ("2k", "quality"),
        "side":      ("2k", "quality"),
        "lifestyle": ("2k", "quality"),
    },
    "hero": {
        "front":     ("4k", "quality"),
        "back":      ("4k", "quality"),
        "side":      ("2k", "quality"),
        "lifestyle": ("2k", "quality"),
    },
    "bridal": {
        "front":     ("4k", "quality"),
        "back":      ("4k", "quality"),
        "side":      ("4k", "quality"),
        "lifestyle": ("4k", "quality"),
    },
}

# Per-output credits for model-swap. Includes the +3 face_reference surcharge
# so a single lookup gives you the all-in cost.
MODEL_SWAP_FACE_REF_SURCHARGE = 3
MODEL_SWAP_CREDITS = {
    # Quality-mode only — the user-locked constraint.
    ("1k", "quality"): 3 + MODEL_SWAP_FACE_REF_SURCHARGE,  # 6
    ("2k", "quality"): 4 + MODEL_SWAP_FACE_REF_SURCHARGE,  # 7
    ("4k", "quality"): 5 + MODEL_SWAP_FACE_REF_SURCHARGE,  # 8
    # Balanced kept for completeness even though we don't route to it.
    ("1k", "balanced"): 2 + MODEL_SWAP_FACE_REF_SURCHARGE,  # 5
    ("2k", "balanced"): 3 + MODEL_SWAP_FACE_REF_SURCHARGE,  # 6
    ("4k", "balanced"): 4 + MODEL_SWAP_FACE_REF_SURCHARGE,  # 7
}

# Routing rule: which embellishment level → which (endpoint, tier).
# Source type does NOT influence routing — model-swap handles dummies fine
# (verified May 10 2026). Vision step writes embellishment_level; this map
# turns that into the FASHN params at dispatch time.
#
# Endpoint is locked to model-swap across the board (decision May 10 2026):
# tryon-max regenerates the garment, which destroys embellishment work even
# at the highest quality tier — observed on DD-LEH-FLR-004 + DD-IWS-DHT-010
# during the production validation run. model-swap preserves outfit pixels
# verbatim across all garment types, including plain ones, so the cost
# premium (~12 cr/SKU more on plain pieces) is the price of catalog-wide
# embellishment-fidelity guarantee.
#
# tryon-max code path remains in 03_fashn_runner.py as a manual override —
# Grishma can still set FASHN Mode = "tryon-max" on the sheet for a SKU if
# she wants to A/B test — but the canonical pipeline never routes to it.
EMBELLISHMENT_TO_ROUTING: Dict[str, Tuple[str, str]] = {
    "light":  ("model-swap", "standard"),   # 26 cr/SKU
    "medium": ("model-swap", "standard"),   # 26 cr/SKU
    "heavy":  ("model-swap", "hero"),       # 30 cr/SKU
    "bridal": ("model-swap", "bridal"),     # 32 cr/SKU
}


def tier_angle_params(tier: str, angle: str) -> Tuple[str, str]:
    """Return (resolution, generation_mode) for a given (tier, angle) pair.

    Looks up TIER_TO_ANGLE_PARAMS; falls back to the standard tier if `tier`
    is unrecognised, then to ('1k', 'quality') if the angle is missing.
    """
    t = (tier or DEFAULT_QUALITY_TIER).strip().lower()
    angle_map = (
        TIER_TO_ANGLE_PARAMS.get(t)
        or TIER_TO_ANGLE_PARAMS[DEFAULT_QUALITY_TIER]
    )
    return angle_map.get(angle, ("1k", "quality"))


def tryon_max_credits(resolution: str, generation_mode: str) -> int:
    """Credits per output image for a given (resolution, generation_mode) pair."""
    return TRYON_MAX_CREDITS.get((resolution, generation_mode), 2)


def tier_total_credits(
    tier: str,
    angles: Tuple[str, ...] = ("front", "back", "side", "lifestyle"),
) -> int:
    """Sum credits for a full SKU run at a given tier. Used for log preview."""
    return sum(
        tryon_max_credits(*tier_angle_params(tier, a)) for a in angles
    )


# Backward-compat shim — old API was `tier_to_tryon_max_params(tier)` which
# returned a single (res, mode) pair for the whole SKU. New code should use
# `tier_angle_params(tier, angle)` instead. The shim returns the front-angle
# config so any straggler caller still gets a sensible answer.
def tier_to_tryon_max_params(tier: str) -> Tuple[str, str]:
    return tier_angle_params(tier, "front")


# ---- model-swap equivalents ------------------------------------------------

def model_swap_angle_params(tier: str, angle: str) -> Tuple[str, str]:
    """Return (resolution, generation_mode) for a model-swap (tier, angle)
    pair. Falls back to the standard tier if `tier` is unknown, then to
    ('1k', 'quality') if the angle is missing."""
    t = (tier or DEFAULT_QUALITY_TIER).strip().lower()
    angle_map = (
        MODEL_SWAP_TIER_PARAMS.get(t)
        or MODEL_SWAP_TIER_PARAMS[DEFAULT_QUALITY_TIER]
    )
    return angle_map.get(angle, ("1k", "quality"))


def model_swap_credits(resolution: str, generation_mode: str = "quality") -> int:
    """Per-output cost for a model-swap call at a given (res, mode).
    Includes the +3 face_reference surcharge baked in."""
    return MODEL_SWAP_CREDITS.get((resolution, generation_mode), 6)


def model_swap_total_credits(
    tier: str,
    angles: Tuple[str, ...] = ("front", "back", "side", "lifestyle"),
) -> int:
    """Sum credits for a full SKU model-swap run at a given tier."""
    return sum(
        model_swap_credits(*model_swap_angle_params(tier, a)) for a in angles
    )


def routing_for_embellishment(level: str) -> Tuple[str, str]:
    """Return (fashn_mode, tier) for an embellishment level. Defaults to
    ('model-swap', 'standard') when the level is unknown or empty —
    model-swap is the canonical endpoint (locked May 10 2026)."""
    return EMBELLISHMENT_TO_ROUTING.get(
        (level or "").strip().lower(), ("model-swap", "standard"),
    )


# =============================================================================
# 1c. IMAGE PROCESSING CONSTANTS (Stage 1)
# =============================================================================
# Color correction was removed entirely (April 2026). Stage 1 now only
# normalises file format and crops detail shots to 4:5.

# JPEG quality used for both mannequin and detail outputs.
# 98 is visually indistinguishable from the source for fashion photography
# while keeping files comfortably under 1MB. Tunable via env so we can
# experiment without a code change.
JPEG_QUALITY = int(os.getenv("DREVI_JPEG_QUALITY", "98"))

# Detail shot aspect ratio. Brand model PNGs are 1856x2304 ≈ 4:5 (off by 0.6%
# due to Uwear rounding to multiples of 64). Cropping details to exact 4:5
# gives a uniform Shopify gallery — every image displays at the same height.
DETAIL_RATIO = (4, 5)

# HEIC conversion flags (independent for mannequin vs detail).
# Both default ON. Set to "0" / "false" in env to disable.
# When OFF: HEIC files are copied through PROCESSED unchanged. Useful for
# testing whether downstream consumers (FASHN, Shopify) accept HEIC URLs.
CONVERT_MANNEQUIN_HEIC = os.getenv(
    "DREVI_CONVERT_MANNEQUIN_HEIC", "1"
) not in ("0", "false", "False", "")

CONVERT_DETAIL_HEIC = os.getenv(
    "DREVI_CONVERT_DETAIL_HEIC", "1"
) not in ("0", "false", "False", "")

# Brand model + lifestyle pose fallbacks when Brand Model Map has no entry.
# Logged on use so we can spot the silent default in production.
DEFAULT_BRAND_MODEL = os.getenv("DREVI_DEFAULT_BRAND_MODEL", "A")
DEFAULT_MOVEMENT_POSE = os.getenv("DREVI_DEFAULT_MOVEMENT_POSE", "pose_06_turning")

# Anthropic configuration
ANTHROPIC_MODEL = "claude-opus-4-7"   # current most-capable model

# Sheet column names (used with findColumn-style partial matching).
# Matching is suffix-based: "Drevi SKU" matches "IDENTITY/Drevi SKU" or plain
# "Drevi SKU" — survives header format changes.
COLS = {
    # Identity
    "drevi_sku":          "Drevi SKU",
    "base_sku":           "Base SKU",
    "vendor_sku":         "Vendor SKU",
    # Auto from SKU
    "cat_code":           "Cat Code",
    "category":           "Category",
    "sub_code":           "Sub Code",
    "sub_category":       "Sub-Category",
    "size_code":          "Size Code",
    "color_code":         "Color Code",
    "color":              "Color",
    # Enrichment
    "color_detail":       "Color Detail (override)",
    # Garment specs
    "primary_fabric":     "Primary Fabric",
    "secondary_fabric":   "Secondary Fabric",
    "primary_handwork":   "Primary Handwork",
    "secondary_handwork": "Secondary Handwork",
    "authenticity":       "Authenticity",
    "origin":             "Origin",
    "care_level":         "Care Level",
    "notes_for_listing":  "Notes for Listing",
    # Stock (per-variant inventory live on the sheet)
    "total_received":     "Total Received",
    "current_qty":        "Current Qty",
    "qty_sold":           "Qty Sold",
    # Pricing
    "final_mrp":          "Final MRP",
    # Pipeline status
    "video_flag":         "Video Flag",
    "photo_status":       "Photo Status",
    "pipeline_status":    "Pipeline Status",
    "input_folder_url":   "Input Folder URL",
    "output_folder_url":  "Output Folder URL",
    # Merchandising
    "shopify_cat_override": "Shopify Category Override",
    "hero_featured":      "Hero / Featured",
    "ai_occasions":       "AI Suggested Occasions",
    "ai_tags":            "AI Suggested Tags",
    # NEW: AI Pipeline section (added by schema migration v1.2)
    "brand_model":        "Brand Model",
    "image_quality_tier": "Image Quality Tier",
    "image_seed_base":    "Image Seed Base",
    "movement_pose":      "Movement Pose",
    "lifestyle_bg":       "Lifestyle Background",
    "tryon_prompt_front": "Tryon Prompt - Front",
    "tryon_prompt_back":  "Tryon Prompt - Back",
    "tryon_prompt_side":  "Tryon Prompt - Side",
    "tryon_prompt_life":  "Tryon Prompt - Lifestyle",
    "dominant_hex":       "Dominant Color Hex",
    "processed_url":      "Processed Folder URL",
    "tryon_credit_cost":  "Tryon Credit Cost",
    "tryon_failed":       "Tryon Failed Angles",
    # NEW: SHOPIFY / COPY / REVIEW sections
    "style":              "Style",
    "edit_inclusion":     "Edit Inclusion",
    "product_name":       "Product Name",
    "description":        "Description",
    "meta_title":         "Meta Title",
    "meta_description":   "Meta Description",
    "copy_generated_at":  "Copy Generated At",
    # NEW: vision-driven routing (added May 10 2026 — see EMBELLISHMENT_TO_ROUTING)
    "source_type":         "Source Type",
    "embellishment_level": "Embellishment Level",
    "fashn_mode":          "FASHN Mode",
    "reshoot_recommended": "Reshoot Recommended",
    # NEW: Shopify draft step (added May 12 2026 — Stage 4 PoC)
    "shopify_product_id":  "Shopify Product ID",
    "shopify_product_url": "Shopify Product URL",
}


# =============================================================================
# 2. LOGGING
# =============================================================================

def setup_logger(name: str, log_file: Optional[Path] = None) -> logging.Logger:
    """Configure a logger that writes to stdout AND optionally a file."""
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger  # already configured

    logger.setLevel(logging.INFO)
    formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )

    # Stdout handler
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(formatter)
    logger.addHandler(sh)

    # File handler (optional)
    if log_file is not None:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        fh = logging.FileHandler(log_file, encoding="utf-8")
        fh.setFormatter(formatter)
        logger.addHandler(fh)

    return logger


# =============================================================================
# 3. GOOGLE AUTH
# =============================================================================

# Scopes — Sheets read/write + Drive read/write
GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]


def get_credentials() -> Credentials:
    """Load service account credentials. Path comes from env var."""
    creds_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not creds_path:
        raise RuntimeError(
            "GOOGLE_APPLICATION_CREDENTIALS env var not set. "
            "Point it at your service account JSON file."
        )
    if not Path(creds_path).is_file():
        raise RuntimeError(f"Credentials file not found: {creds_path}")
    return Credentials.from_service_account_file(creds_path, scopes=GOOGLE_SCOPES)


def get_sheets_client():
    """Return an authenticated gspread client."""
    return gspread.authorize(get_credentials())


def get_drive_service():
    """Return an authenticated Google Drive v3 service."""
    return build("drive", "v3", credentials=get_credentials(), cache_discovery=False)


# =============================================================================
# 4. SHEET HELPERS
# =============================================================================

@dataclass
class SheetSchema:
    """Resolved column-name → 1-indexed column number map for the Master tab."""
    effective_headers: List[str]
    col_map: Dict[str, int] = field(default_factory=dict)
    data_start_row: int = DATA_START_ROW

    def col(self, key_or_header: str) -> int:
        """Return 1-indexed column number for either a logical key
        ('final_mrp') or a raw display header ('Final MRP'). Raw display
        headers go straight to find_column; logical keys are resolved via
        the COLS map first.
        """
        # If it's a logical key, translate to its display name.
        needle = COLS.get(key_or_header, key_or_header)
        if needle in self.col_map:
            return self.col_map[needle]
        col = find_column(self.effective_headers, needle)
        if col == 0:
            raise KeyError(
                f"Column not found in master sheet: '{needle}' "
                f"(looked up via '{key_or_header}'). Has the schema migration been run?"
            )
        self.col_map[needle] = col
        return col

    def col_letter(self, key_or_header: str) -> str:
        return column_to_letter(self.col(key_or_header))

    # Alias used by Stage 1 / Stage 2 callers.
    get_col_letter = col_letter


def find_column(headers: List[str], needle: str) -> int:
    """
    1-indexed column lookup. Mirrors the Apps Script findColumn().

    Tries:
      1. Exact match
      2. Header endsWith('/' + needle)
      3. If needle has '/', try its trailing segments as exact matches
    """
    needle = (needle or "").strip()
    if not needle:
        return 0
    # 1. Exact match
    for i, h in enumerate(headers):
        if h == needle:
            return i + 1
    # 2. Suffix match
    suffix = "/" + needle
    for i, h in enumerate(headers):
        if h and h.endswith(suffix):
            return i + 1
    # 3. Inverse direction
    if "/" in needle:
        # Try every split position (handles needles with embedded slashes)
        idx = needle.find("/")
        while idx >= 0:
            sub = needle[idx + 1:].strip()
            for i, h in enumerate(headers):
                if h == sub:
                    return i + 1
            idx = needle.find("/", idx + 1)
    return 0


def column_to_letter(col: int) -> str:
    """1=A, 27=AA, 53=BA, etc."""
    if col < 1:
        return ""
    result = ""
    while col > 0:
        col, r = divmod(col - 1, 26)
        result = chr(65 + r) + result
    return result


def load_master_schema(ws: gspread.Worksheet) -> SheetSchema:
    """
    Read row 1 + row 2 of the master tab and produce the joined effective
    headers used for column lookups. This mirrors the Apps Script's
    analyzeHeaderStructure() function.
    """
    last_col = ws.col_count
    # Pull row 1 + row 2
    rng = ws.get(f"A1:{column_to_letter(last_col)}2")
    row1 = rng[0] if len(rng) > 0 else []
    row2 = rng[1] if len(rng) > 1 else []
    # Pad to last_col
    row1 = (row1 + [""] * last_col)[:last_col]
    row2 = (row2 + [""] * last_col)[:last_col]
    # Carry-forward section labels from row 1
    section = ""
    effective: List[str] = []
    for i in range(last_col):
        if row1[i].strip():
            section = row1[i].strip()
        col_name = row2[i].strip()
        if not col_name:
            effective.append("")
        else:
            effective.append(f"{section}/{col_name}" if section else col_name)
    return SheetSchema(effective_headers=effective)


def get_master_ws(client: Optional[gspread.Client] = None) -> gspread.Worksheet:
    client = client or get_sheets_client()
    sh = client.open_by_key(SHEET_ID)
    return sh.worksheet(MASTER_TAB)


def read_master_rows(
    ws: gspread.Worksheet,
    schema: SheetSchema,
    filter_status: Optional[str] = None,
    filter_status_col: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Read all data rows from the Master tab. Each row is returned as a dict
    keyed by logical column key (e.g. 'drevi_sku', 'final_mrp').

    Optionally filter by a status column value, e.g.:
        read_master_rows(ws, schema, filter_status='Photos Uploaded',
                         filter_status_col='photo_status')
    """
    last_col = ws.col_count
    last_row = ws.row_count
    if last_row < schema.data_start_row:
        return []

    raw = ws.get(
        f"A{schema.data_start_row}:{column_to_letter(last_col)}{last_row}"
    )

    # Build reverse index: 0-indexed column position → logical key
    col_to_key: Dict[int, str] = {}
    for key, header_name in COLS.items():
        try:
            col_idx = schema.col(key) - 1  # convert to 0-indexed
            col_to_key[col_idx] = key
        except KeyError:
            # Column not yet present (e.g. schema migration not run yet) — skip
            continue

    out: List[Dict[str, Any]] = []
    filter_col_idx = None
    if filter_status and filter_status_col:
        try:
            filter_col_idx = schema.col(filter_status_col) - 1
        except KeyError:
            filter_col_idx = None

    for offset, row_vals in enumerate(raw):
        # Skip empty rows
        first_val = row_vals[0].strip() if row_vals else ""
        if not first_val:
            continue
        # Filter by status if requested
        if filter_col_idx is not None:
            val = row_vals[filter_col_idx] if filter_col_idx < len(row_vals) else ""
            if val.strip() != filter_status:
                continue
        idx = schema.data_start_row + offset
        record = {
            "_row": idx,
            "_row_index": idx,   # alias — both names are written so call sites stay simple
            "_raw": row_vals,
        }
        for col_idx, key in col_to_key.items():
            record[key] = row_vals[col_idx].strip() if col_idx < len(row_vals) else ""
        out.append(record)
    return out


def update_cell(
    ws: gspread.Worksheet,
    row: int,
    col_letter: str,
    value: Any,
) -> None:
    """Write a single cell. Idempotent — safe to call repeatedly."""
    ws.update_acell(f"{col_letter}{row}", value)


_A1_RE = re.compile(r"^[A-Z]+\d+$")
_COL_LETTER_RE = re.compile(r"^[A-Z]+$")


def update_cells(
    ws: gspread.Worksheet,
    row_or_updates: "int | List[Tuple[str, Any]]",
    updates: Optional[Dict[str, Any]] = None,
    value_input_option: str = "USER_ENTERED",
) -> None:
    """Batch-write cells in a single round-trip.

    Two call shapes are supported, both end up as a single ``batch_update``:

    1. Dict-per-row form (most common — Stage 3 style)::

           update_cells(ws, row_index, {col_letter: value, ...})

    2. List-of-(A1, value) pairs (Stage 1 / Stage 2 style)::

           update_cells(ws, [(f"{col_letter}{row}", value), ...])

    Either way the call results in one ``ws.batch_update`` API call rather
    than per-cell reads + writes.

    ``value_input_option`` defaults to ``USER_ENTERED`` (Sheets parses the
    value as if typed — good for dates/numbers). Pass ``"RAW"`` to store the
    literal string. Use RAW for opaque identifiers like Shopify product IDs:
    a long all-digit string written as USER_ENTERED gets number-parsed and
    can silently vanish in a number-formatted column.
    """
    body: List[Dict[str, Any]] = []

    if isinstance(row_or_updates, int):
        row = row_or_updates
        if not updates:
            return
        for col_letter, val in updates.items():
            if not _COL_LETTER_RE.match(col_letter):
                raise ValueError(f"Invalid column letter: {col_letter!r}")
            body.append({
                "range": f"{col_letter}{row}",
                "values": [[val]],
            })
    else:
        if updates is not None:
            raise TypeError(
                "update_cells: pass either (ws, row, dict) OR "
                "(ws, [(a1, value), ...]); cannot combine both forms."
            )
        for entry in row_or_updates:
            if not isinstance(entry, (tuple, list)) or len(entry) != 2:
                raise TypeError(
                    f"update_cells list entries must be (a1_range, value) — got {entry!r}"
                )
            a1, val = entry
            if not _A1_RE.match(a1 or ""):
                raise ValueError(f"Invalid A1 range: {a1!r}")
            body.append({
                "range": a1,
                "values": [[val]],
            })

    if not body:
        return
    ws.batch_update(body, value_input_option=value_input_option)


# =============================================================================
# 5. FILENAME HELPERS
# =============================================================================
#
# find_file_by_stem — match a file in a Drive listing regardless of extension.
# Image decoding/encoding lives inside Stage 1 (Pillow) and the vision helpers
# (Pillow + pillow-heif). drevi_common deliberately stays out of the image-lib
# imports so a Sheets-only smoke test doesn't need PIL installed.


def find_file_by_stem(
    files: "Dict[str, Dict] | List[Dict]",
    stem: str,
) -> Optional[Dict]:
    """Find a file by its stem (filename without extension), trying every
    accepted image extension in order. Match is case-insensitive.

    Accepts either:
      - a list of Drive file dicts (each with name/id/mimeType), or
      - a dict keyed on lowercased filename → file dict

    Returns the file dict or None.

    This exists because Arushi's iPhone produces front.HEIC by default,
    but if she has Most Compatible mode enabled it'll be front.jpg, and
    if she ever screenshots/edits/converts it could be front.png. The
    pipeline shouldn't care — the stem is the contract.
    """
    if isinstance(files, list):
        files_by_name = {
            (f.get("name") or "").lower(): f for f in files
        }
    else:
        files_by_name = files
    stem_lower = stem.lower()
    for ext in ACCEPTED_EXTENSIONS:
        candidate = stem_lower + ext
        if candidate in files_by_name:
            return files_by_name[candidate]
    return None


# =============================================================================
# 6. DRIVE HELPERS
# =============================================================================

def parse_drive_folder_id(url_or_id: str) -> str:
    """
    Accept either a raw Drive folder ID or a Drive URL like:
      https://drive.google.com/drive/folders/<ID>?...
      https://drive.google.com/drive/u/0/folders/<ID>
    Returns the folder ID.
    """
    if not url_or_id:
        raise ValueError("Empty Drive URL/ID")
    s = url_or_id.strip()
    # Already an ID-shaped string (no slashes, alphanumeric+_-)
    if re.match(r"^[A-Za-z0-9_-]{20,}$", s):
        return s
    m = re.search(r"/folders/([A-Za-z0-9_-]+)", s)
    if m:
        return m.group(1)
    m = re.search(r"id=([A-Za-z0-9_-]+)", s)
    if m:
        return m.group(1)
    raise ValueError(f"Could not parse folder ID from: {url_or_id}")


def list_drive_folder(drive, folder_id: str) -> List[Dict[str, str]]:
    """List files (not folders) directly inside a Drive folder.
    Returns list of {id, name, mimeType}.
    """
    files = []
    page_token = None
    q = f"'{folder_id}' in parents and trashed = false"
    while True:
        resp = drive.files().list(
            q=q,
            fields="nextPageToken, files(id, name, mimeType)",
            pageToken=page_token,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
            corpora="allDrives",
        ).execute()
        files.extend(resp.get("files", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    # Filter to actual files, not folders
    return [f for f in files
            if f.get("mimeType") != "application/vnd.google-apps.folder"]


def list_drive_subfolders(drive, parent_id: str) -> List[Dict[str, str]]:
    """List subfolders directly inside a Drive folder.
    Returns list of {id, name, mimeType}.

    Used by 01_preprocess.py to auto-discover the per-SKU INPUT folder
    by name, removing the need for Arushi to paste the folder URL into
    the master sheet.
    """
    files = []
    page_token = None
    q = (
        f"'{parent_id}' in parents and "
        f"mimeType = 'application/vnd.google-apps.folder' and "
        f"trashed = false"
    )
    while True:
        resp = drive.files().list(
            q=q,
            fields="nextPageToken, files(id, name, mimeType)",
            pageToken=page_token,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
            corpora="allDrives",
        ).execute()
        files.extend(resp.get("files", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return files


def find_subfolder_by_name(
    drive, parent_id: str, name: str
) -> Optional[Dict[str, str]]:
    """Find a single subfolder by exact name match (case-insensitive).
    Returns the folder dict {id, name, mimeType}, or None.

    Drive does not enforce unique folder names, so if duplicates exist
    we return the first match and the caller should log a warning if
    more than one was found. We keep this simple: case-insensitive
    exact match.
    """
    target = name.strip().lower()
    if not target:
        return None
    matches = [
        f for f in list_drive_subfolders(drive, parent_id)
        if f.get("name", "").strip().lower() == target
    ]
    if not matches:
        return None
    return matches[0]


def download_drive_file(drive, file_id: str, dest_path: Path) -> Path:
    """Download a Drive file to a local path. Skips if already exists."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    if dest_path.exists() and dest_path.stat().st_size > 0:
        return dest_path
    request = drive.files().get_media(fileId=file_id, supportsAllDrives=True)
    with dest_path.open("wb") as f:
        downloader = MediaIoBaseDownload(f, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()
    return dest_path


def get_or_create_subfolder(drive, parent_id: str, name: str) -> str:
    """Return ID of subfolder named `name` under `parent_id`. Creates if missing."""
    q = (
        f"'{parent_id}' in parents and trashed = false and "
        f"mimeType = 'application/vnd.google-apps.folder' and "
        f"name = '{name}'"
    )
    resp = drive.files().list(
        q=q, fields="files(id, name)",
        supportsAllDrives=True, includeItemsFromAllDrives=True,
        corpora="allDrives",
    ).execute()
    items = resp.get("files", [])
    if items:
        return items[0]["id"]
    body = {
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent_id],
    }
    folder = drive.files().create(
        body=body, fields="id", supportsAllDrives=True
    ).execute()
    return folder["id"]


def upload_file_to_drive(
    drive,
    local_path: Path,
    parent_id: str,
    name: Optional[str] = None,
    mime_type: str = "image/jpeg",
) -> Dict[str, str]:
    """Upload a file to Drive. Returns {id, webViewLink}."""
    name = name or local_path.name
    # If a file with the same name exists in parent, replace it
    q = (
        f"'{parent_id}' in parents and trashed = false and name = '{name}'"
    )
    resp = drive.files().list(
        q=q, fields="files(id)",
        supportsAllDrives=True, includeItemsFromAllDrives=True,
        corpora="allDrives",
    ).execute()
    existing = resp.get("files", [])
    media = MediaFileUpload(str(local_path), mimetype=mime_type, resumable=False)
    if existing:
        f = drive.files().update(
            fileId=existing[0]["id"],
            media_body=media,
            fields="id, webViewLink",
            supportsAllDrives=True,
        ).execute()
    else:
        body = {"name": name, "parents": [parent_id]}
        f = drive.files().create(
            body=body, media_body=media,
            fields="id, webViewLink",
            supportsAllDrives=True,
        ).execute()
    return f


def make_public_url(file_id: str) -> str:
    """Construct the publicly-shareable URL for a Drive file (used as input to FASHN).
    Note: the file MUST have 'anyone with link can view' permission for FASHN to fetch it.
    See ensure_anyone_can_read() helper.
    """
    return f"https://drive.google.com/uc?export=download&id={file_id}"


def ensure_anyone_can_read(drive, file_id: str) -> None:
    """Set 'anyone with link can read' permission on a file. Idempotent —
    a 'duplicate'/'alreadyExists' response from Drive is silently ignored.
    Auth (401/403) and other unexpected errors propagate so the caller can
    decide whether to fail-soft (log + continue) or fail-loud (re-raise);
    historically we swallowed everything here, which masked Drive policy
    misconfigurations as opaque downstream FASHN 403s.
    """
    try:
        drive.permissions().create(
            fileId=file_id,
            body={"type": "anyone", "role": "reader"},
            supportsAllDrives=True,
        ).execute()
    except Exception as e:
        msg = str(e).lower()
        if any(token in msg for token in (
            "alreadyexists", "duplicate", "permissionnotfound",
            "publishouterror",   # already-public-on-shared-drive variants
        )):
            return
        # Re-raise — caller logs with the SKU/angle context.
        raise


# =============================================================================
# 5b. DRIVE SWEEP / VISION-LOG HELPERS
# =============================================================================

def list_input_folder_names(drive, input_root_id: str) -> List[str]:
    """Return the names of all subfolders directly under the INPUT root.

    Used by Stage 1's Drive-driven trigger: any folder Arushi creates here
    counts as 'photos uploaded' regardless of what the sheet's Photo Status
    column says.
    """
    return [
        (f.get("name") or "").strip()
        for f in list_drive_subfolders(drive, input_root_id)
        if (f.get("name") or "").strip()
    ]


def upload_text_to_drive(
    drive,
    parent_id: str,
    name: str,
    text: str,
    mime_type: str = "application/json",
) -> Dict[str, str]:
    """Upload a small text/JSON payload to Drive (used for vision-call backups).
    Overwrites any same-named existing file in the parent. Returns {id, webViewLink}.
    """
    import io
    from googleapiclient.http import MediaIoBaseUpload

    q = f"'{parent_id}' in parents and trashed = false and name = '{name}'"
    resp = drive.files().list(
        q=q, fields="files(id)",
        supportsAllDrives=True, includeItemsFromAllDrives=True,
        corpora="allDrives",
    ).execute()
    existing = resp.get("files", [])
    media = MediaIoBaseUpload(
        io.BytesIO(text.encode("utf-8")), mimetype=mime_type, resumable=False,
    )
    if existing:
        return drive.files().update(
            fileId=existing[0]["id"],
            media_body=media,
            fields="id, webViewLink",
            supportsAllDrives=True,
        ).execute()
    body = {"name": name, "parents": [parent_id]}
    return drive.files().create(
        body=body, media_body=media,
        fields="id, webViewLink",
        supportsAllDrives=True,
    ).execute()


def resolve_vision_logs_root(drive, log) -> str:
    """Return the Drive folder ID where vision-call backups are written.

    Resolution order:
      1. DREVI_VISION_LOGS_FOLDER_ID env var (preferred — explicit ID).
      2. Auto-created `VISION_LOGS` folder as a sibling of PROCESSED.
      3. PROCESSED itself as a last resort (logs subfolder created inside).
    """
    explicit = os.environ.get("DREVI_VISION_LOGS_FOLDER_ID", "").strip()
    if explicit:
        return explicit

    processed_root = os.environ.get("DREVI_PROCESSED_FOLDER_ID", "").strip()
    if not processed_root:
        raise RuntimeError(
            "Cannot resolve VISION_LOGS folder: neither "
            "DREVI_VISION_LOGS_FOLDER_ID nor DREVI_PROCESSED_FOLDER_ID is set."
        )

    try:
        meta = drive.files().get(
            fileId=processed_root,
            fields="parents",
            supportsAllDrives=True,
        ).execute()
        parents = meta.get("parents") or []
        if parents:
            sibling_id = get_or_create_subfolder(drive, parents[0], "VISION_LOGS")
            log.info("VISION_LOGS auto-resolved to sibling of PROCESSED: %s",
                     sibling_id)
            return sibling_id
    except Exception as e:
        log.warning("Could not place VISION_LOGS as sibling of PROCESSED (%s); "
                    "falling back to a child folder of PROCESSED.", e)

    return get_or_create_subfolder(drive, processed_root, "VISION_LOGS")


# =============================================================================
# 6. SKU UTILITIES
# =============================================================================

def base_sku_from_drevi_sku(drevi_sku: str) -> str:
    """
    DD-LEH-FLR-007-XL-CPR  →  DD-LEH-FLR-007
    DD-IWS-JKT-001-XL-NVY  →  DD-IWS-JKT-001
    The base is the first 4 dash-separated parts.
    """
    parts = drevi_sku.split("-")
    if len(parts) < 4:
        return drevi_sku
    return "-".join(parts[:4])


def photo_folder_name(drevi_sku: str, color_code: str = "") -> str:
    """
    Photo folder naming convention from the operations manual:
      Single-color SKU:  DD-IWS-JKT-001            (just the base SKU)
      Multi-color SKU:   DD-LEH-FLR-007-CPR        (base + color)

    Whether to use the multi-color form depends on whether the same Base SKU
    is used across multiple colors. The pipeline determines this dynamically
    by looking at sibling rows; here we just produce a candidate name.
    """
    base = base_sku_from_drevi_sku(drevi_sku)
    if color_code and color_code != "OTH":
        return f"{base}-{color_code}"
    return base


def resolve_input_folder(
    drive,
    root_folder_id: str,
    *args,
    sibling_skus: Optional[List[str]] = None,
    base_sku: Optional[str] = None,
    color_code: Optional[str] = None,
    siblings: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """Find the per-SKU input folder. Returns (folder_id, matched_name) or
    (None, None). Lookup order:

      1. Each sibling's full Drevi SKU (DD-IWS-DHT-006-L-IVR) — Arushi's
         natural choice off the garment tag.
      2. base + colour (DD-IWS-DHT-006-IVR) — legacy convention.
      3. Just base SKU (DD-IWS-DHT-006) — fallback for single-colour designs.

    Accepts both call orders for historical reasons:

        resolve_input_folder(drive, root, sibling_skus, base_sku, color_code)
        resolve_input_folder(drive, root, base_sku, color_code, siblings)
        resolve_input_folder(drive, root, sibling_skus=..., base_sku=..., color_code=...)

    Returns the folder ID directly (not the dict) — every caller wants the ID.
    """
    # Disambiguate the two positional shapes.
    if args:
        if sibling_skus is None and isinstance(args[0], list) and (
            not args[0] or isinstance(args[0][0], str)
        ):
            # Form A: (sibling_skus, base_sku, color_code)
            sibling_skus = args[0]
            if len(args) >= 2 and base_sku is None:
                base_sku = args[1]
            if len(args) >= 3 and color_code is None:
                color_code = args[2]
        elif isinstance(args[0], str):
            # Form B: (base_sku, color_code, siblings)
            if base_sku is None:
                base_sku = args[0]
            if len(args) >= 2 and color_code is None:
                color_code = args[1]
            if len(args) >= 3 and siblings is None:
                siblings = args[2]

    if sibling_skus is None and siblings is not None:
        sibling_skus = [
            s.get("drevi_sku", "") for s in siblings if s.get("drevi_sku")
        ]
    if sibling_skus is None:
        sibling_skus = []
    base_sku = base_sku or ""
    color_code = color_code or ""

    candidates: List[str] = []
    for sku in sibling_skus:
        if sku and sku not in candidates:
            candidates.append(sku)
    if base_sku and color_code and color_code != "OTH":
        c2 = f"{base_sku}-{color_code}"
        if c2 not in candidates:
            candidates.append(c2)
    if base_sku and base_sku not in candidates:
        candidates.append(base_sku)

    for name in candidates:
        folder = find_subfolder_by_name(drive, root_folder_id, name)
        if folder:
            return folder["id"], name

    # Fuzzy fallback: size-insensitive match on the folder name shape
    # {base}-{any_size}-{color_code}. Drevi runs ONE photo shoot per
    # (base, color) — the same images serve every size sibling. So if the
    # sheet says L-NVY and the actual folder is XL-NVY (or vice versa), it
    # should still resolve. Without this, harmless folder-name size drift
    # blocks the whole SKU. If multiple folders match, pick the first and
    # log a warning so the duplication is visible.
    if base_sku and color_code:
        pat = re.compile(
            rf"^{re.escape(base_sku)}-[^-]+-{re.escape(color_code)}$",
            re.IGNORECASE,
        )
        matches = [
            s for s in list_drive_subfolders(drive, root_folder_id)
            if pat.match((s.get("name") or "").strip())
        ]
        if matches:
            if len(matches) > 1:
                logging.getLogger("drevi").warning(
                    "resolve_input_folder: %d folders match %s-*-%s — "
                    "picked first (%s). Consider consolidating.",
                    len(matches), base_sku, color_code,
                    matches[0].get("name"),
                )
            return matches[0]["id"], matches[0].get("name")

    return None, None


# FASHN's `seed` field is documented as `[0, 2^32 - 1]`. We mask to 32 bits
# both for the base seed and the per-angle offset to guarantee we never
# overflow when MD5[:8] happens to land on 0xFFFFFFFC..0xFFFFFFFF.
_SEED_MASK = 0xFFFFFFFF


def seed_for_sku(base_sku: str) -> int:
    """Deterministic seed from base SKU. Same SKU → same seed → reproducible
    FASHN output. 32-bit-safe."""
    h = hashlib.md5(base_sku.encode("utf-8")).hexdigest()
    return int(h[:8], 16) & _SEED_MASK


def angle_seed(base_sku: str, angle: str) -> int:
    """Per-angle seed offsets so each of the 4 angles gets a slightly
    different seed (avoids 4 identical-looking outputs). 32-bit-safe.
    """
    offsets = {"front": 0, "back": 1, "side": 2, "lifestyle": 3}
    return (seed_for_sku(base_sku) + offsets.get(angle, 0)) & _SEED_MASK


# =============================================================================
# 6.5  SIBLING GROUP HELPERS
# =============================================================================
# Master can have multiple rows for the same (base, color) — different sizes
# of the same design. They share photos, AI outputs, and copy. The pipeline
# operates on (base, color) groups, not individual rows.

def group_master_rows_by_base_color(
    rows: List[Dict[str, Any]],
) -> Dict[Tuple[str, str], List[Dict[str, Any]]]:
    """Group all Master rows by (base SKU, color code). Returns
    {(base_sku, color_code): [rows]} for every row that has a Drevi SKU.
    """
    groups: Dict[Tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)
    for r in rows:
        drevi_sku = r.get("drevi_sku", "")
        if not drevi_sku:
            continue
        key = (
            base_sku_from_drevi_sku(drevi_sku),
            r.get("color_code", ""),
        )
        groups[key].append(r)
    return dict(groups)


def group_matches_sku_filter(
    siblings: List[Dict[str, Any]],
    sku_filter: Optional[str],
) -> bool:
    """Return True if --sku filter matches any sibling in the group, or if
    no filter was given. Accepts full Drevi SKU or Base SKU.
    """
    if not sku_filter:
        return True
    return any(
        r.get("drevi_sku") == sku_filter or r.get("base_sku") == sku_filter
        for r in siblings
    )


def first_sibling_value(
    siblings: List[Dict[str, Any]],
    field: str,
) -> str:
    """Return the first non-empty value of `field` across the siblings, or ''
    if no sibling has it set. Used to detect 'group already has an output URL'.
    """
    for r in siblings:
        v = (r.get(field) or "").strip()
        if v:
            return v
    return ""


# =============================================================================
# 7. CONFIG TAB LOOKUPS
# =============================================================================

def load_brand_model_map(client: Optional[gspread.Client] = None) -> List[Dict[str, str]]:
    """Read the Brand Model Map tab (added by the schema migration).
    Returns list of {cat_code, sub_code, brand_model, movement_pose}.
    """
    client = client or get_sheets_client()
    sh = client.open_by_key(SHEET_ID)
    try:
        ws = sh.worksheet("Brand Model Map")
    except gspread.WorksheetNotFound:
        return []
    rows = ws.get_all_values()
    if len(rows) < 2:
        return []
    # Skip header row
    out = []
    for r in rows[1:]:
        if len(r) < 4:
            continue
        cat = r[0].strip()
        sub = r[1].strip()
        if not cat:
            continue
        out.append({
            "cat_code": cat,
            "sub_code": sub,
            "brand_model": r[2].strip(),
            "movement_pose": r[3].strip(),
        })
    return out


def resolve_brand_model(
    cat_code: str, sub_code: str, mapping: List[Dict[str, str]]
) -> Tuple[str, str]:
    """Most-specific-first lookup. Returns (brand_model, movement_pose).
    Tries (cat, sub) → (cat, *) → (*, *) → env defaults.
    Logs a warning if the env defaults end up being used so we can spot
    silent fallbacks in production.
    """
    cat = (cat_code or "").strip().upper()
    sub = (sub_code or "").strip().upper()
    for r in mapping:
        if r["cat_code"] == cat and r["sub_code"].upper() == sub:
            return r["brand_model"], r["movement_pose"]
    for r in mapping:
        if r["cat_code"] == cat and r["sub_code"] == "*":
            return r["brand_model"], r["movement_pose"]
    for r in mapping:
        if r["cat_code"] == "*" and r["sub_code"] == "*":
            return r["brand_model"], r["movement_pose"]
    logging.getLogger("drevi").warning(
        "Brand Model Map miss for (cat=%s, sub=%s) — falling back to env "
        "defaults (%s, %s). Consider adding an explicit row.",
        cat or "?", sub or "?", DEFAULT_BRAND_MODEL, DEFAULT_MOVEMENT_POSE,
    )
    return DEFAULT_BRAND_MODEL, DEFAULT_MOVEMENT_POSE


# =============================================================================
# PER-MODEL LAYOUT DESCRIPTORS  (single source of truth — used by both
# 03_fashn_runner.py and test_fashn_local.py; do NOT duplicate this logic
# in either caller again — that drift is what caused the Model-A breakage.)
# =============================================================================
# Model A and Model B have DIFFERENT Drive structures AND pose inventories:
#
#   Model A  — Drive folder "Model-a", FLAT (no poses/ subfolder):
#       <root>/Model-a/front.png  back.png  side.png  lifestyle.png
#                      (one fixed lifestyle shot, no movement-pose variety)
#
#   Model B  — Drive folder "model-b", NESTED under poses/:
#       <root>/model-b/poses/pose_01_front.png ... pose_10_sitting.png
#
# Folder names are inconsistently cased ("Model-a" vs "model-b"), so matching
# is case-insensitive and folders are NEVER auto-created (a mis-cased empty
# folder would mask the real one).
#
# Policy: only models A and B are in use. ~80% of the catalog routes to A;
# B is reserved for the "cool" styles (sarees, mermaid lehengas) — that
# split lives in the Brand Model Map sheet tab, not hard-coded here.
ANGLES = ["front", "back", "side", "lifestyle"]

BRAND_MODEL_LAYOUTS: Dict[str, Dict] = {
    "A": {
        "folder_aliases":  ["model-a"],   # case-insensitive
        "poses_subfolder": None,          # photos are flat in the model folder
        "angle_to_file": {
            "front":     "front.png",
            "back":      "back.png",
            "side":      "side.png",
            "lifestyle": "lifestyle.png",
        },
        "lifestyle_uses_movement_pose": False,  # A: fixed lifestyle.png
    },
    "B": {
        "folder_aliases":  ["model-b"],
        "poses_subfolder": "poses",
        "angle_to_file": {
            "front":     "pose_01_front.png",
            "back":      "pose_02_back.png",
            "side":      "pose_03_three_quarter_left.png",
            # lifestyle filled dynamically from the (normalized) movement pose
        },
        "lifestyle_uses_movement_pose": True,
        # Default lifestyle pose for any Model B SKU whose Brand Model Map
        # movement pose is missing/unresolved. pose_04_hand_on_hip_right is
        # the strongest general editorial pose (confident contrapposto);
        # pose_06_turning was the weak default that made output look basic.
        "lifestyle_fallback":           "pose_04_hand_on_hip_right",
        "available_poses": {
            "pose_01_front", "pose_02_back", "pose_03_three_quarter_left",
            "pose_04_hand_on_hip_right", "pose_05_walking", "pose_06_turning",
            "pose_07_over_shoulder", "pose_08_lean", "pose_09_bridal_moment",
            "pose_10_sitting",
        },
    },
}

# Brand Model Map sheet historically referenced pose names that don't match
# Model B's actual files. Normalize the known stale names; anything still
# unresolved falls back to the model's lifestyle_fallback.
BRAND_MODEL_B_POSE_ALIASES = {
    "pose_05_pallu_walk":     "pose_05_walking",
    "pose_07_editorial_lean": "pose_07_over_shoulder",
    "pose_08_stride":         "pose_08_lean",
}


def normalize_brand_model(brand_model: str, log) -> str:
    """Clamp to a model we actually support. Only A and B are in use;
    anything else (C, blank, junk) → A with a warning so it's visible."""
    bm = (brand_model or "").strip().upper()
    if bm in BRAND_MODEL_LAYOUTS:
        return bm
    log.warning("Brand model %r is not in use (only A/B) — using A.", brand_model)
    return "A"


def resolve_b_lifestyle_pose(movement_pose: str, log) -> str:
    """Map a Brand-Model-Map movement pose to an actual Model B pose file
    stem. Applies the stale-name alias table, validates against B's known
    poses, and falls back to B's lifestyle_fallback if unresolved."""
    cfg = BRAND_MODEL_LAYOUTS["B"]
    raw = (movement_pose or "").strip()
    stem = raw[:-4] if raw.lower().endswith(".png") else raw
    stem = BRAND_MODEL_B_POSE_ALIASES.get(stem, stem)
    if stem in cfg["available_poses"]:
        return stem
    fb = cfg["lifestyle_fallback"]
    log.warning(
        "Model B movement pose %r not available (after alias) — "
        "using fallback %r.", movement_pose, fb,
    )
    return fb


def resolve_angle_pose_filenames(brand_model: str, movement_pose: str,
                                 log) -> Dict[str, str]:
    """Return {angle: pose_filename} for the given model. Model A uses its
    fixed angle-named files; Model B uses pose_NN_* with the lifestyle slot
    driven by the normalized movement pose."""
    cfg = BRAND_MODEL_LAYOUTS[brand_model]
    mapping = dict(cfg["angle_to_file"])
    if cfg["lifestyle_uses_movement_pose"]:
        mapping["lifestyle"] = f"{resolve_b_lifestyle_pose(movement_pose, log)}.png"
    return mapping


def _find_child_folder_ci(drive, parent_id: str, aliases: List[str]) -> str:
    """Return the id of a child FOLDER whose name case-insensitively matches
    one of `aliases`. Never creates — raises with a helpful listing if no
    match (creating a mis-cased empty folder would mask the real one)."""
    children = list_drive_subfolders(drive, parent_id)
    wanted = {a.strip().lower() for a in aliases}
    for c in children:
        if (c.get("name") or "").strip().lower() in wanted:
            return c["id"]
    raise RuntimeError(
        f"Brand model folder not found under {parent_id}: expected one of "
        f"{sorted(wanted)} (case-insensitive). Available subfolders: "
        f"{[c.get('name') for c in children]}"
    )


def resolve_brand_model_folder(
    drive, brand_model_root_id: str, brand_model: str,
) -> str:
    """Return the Drive folder id that holds `brand_model`'s pose images.

    Model A is FLAT — the model folder itself holds front/back/side/
    lifestyle .png. Model B is NESTED — a 'poses/' subfolder holds the
    pose_NN_* files. Case-insensitive, never auto-created.
    """
    cfg = BRAND_MODEL_LAYOUTS[brand_model]
    model_folder_id = _find_child_folder_ci(
        drive, brand_model_root_id, cfg["folder_aliases"],
    )
    sub = cfg["poses_subfolder"]
    if not sub:
        return model_folder_id  # Model A: flat
    return _find_child_folder_ci(drive, model_folder_id, [sub])  # Model B


def load_tryon_prompt_map(client: Optional[gspread.Client] = None) -> List[Dict[str, str]]:
    """Read the Tryon Prompt Map tab.
    Returns list of {cat_code, sub_code, front, back, side, lifestyle}.
    """
    client = client or get_sheets_client()
    sh = client.open_by_key(SHEET_ID)
    try:
        ws = sh.worksheet("Tryon Prompt Map")
    except gspread.WorksheetNotFound:
        return []
    rows = ws.get_all_values()
    if len(rows) < 2:
        return []
    out = []
    for r in rows[1:]:
        if len(r) < 6:
            r = r + [""] * (6 - len(r))
        cat = r[0].strip()
        if not cat:
            continue
        out.append({
            "cat_code": cat,
            "sub_code": r[1].strip(),
            "front": r[2].strip(),
            "back": r[3].strip(),
            "side": r[4].strip(),
            "lifestyle": r[5].strip(),
        })
    return out


def resolve_tryon_prompts(
    cat_code: str, sub_code: str, mapping: List[Dict[str, str]]
) -> Dict[str, str]:
    """Same most-specific-first logic. Returns {front, back, side, lifestyle}."""
    cat = (cat_code or "").strip().upper()
    sub = (sub_code or "").strip().upper()
    keys = ["front", "back", "side", "lifestyle"]
    for matcher in (
        lambda r: r["cat_code"] == cat and r["sub_code"].upper() == sub,
        lambda r: r["cat_code"] == cat and r["sub_code"] == "*",
        lambda r: r["cat_code"] == "*" and r["sub_code"] == "*",
    ):
        for r in mapping:
            if matcher(r):
                return {k: r[k] for k in keys}
    return {k: "" for k in keys}


def load_tag_vocabulary(client: Optional[gspread.Client] = None) -> Dict[str, List[Dict[str, str]]]:
    """Read the Tag Vocabulary tab.
    Returns {axis: [{tag_value, display_label, source}, ...]}.
    """
    client = client or get_sheets_client()
    sh = client.open_by_key(SHEET_ID)
    try:
        ws = sh.worksheet("Tag Vocabulary")
    except gspread.WorksheetNotFound:
        return {}
    rows = ws.get_all_values()
    if len(rows) < 2:
        return {}
    out: Dict[str, List[Dict[str, str]]] = {}
    for r in rows[1:]:
        if len(r) < 3:
            r = r + [""] * (3 - len(r))
        axis = r[0].strip()
        if not axis:
            continue
        out.setdefault(axis, []).append({
            "tag_value": r[1].strip(),
            "display_label": r[2].strip(),
            "source": r[3].strip() if len(r) > 3 else "",
        })
    return out


# =============================================================================
# 8. PIPELINE STATUS HELPERS
# =============================================================================

# Photo Status — machine-owned. Each stage reads ONLY this column to find
# work, and atomically advances it on success / writes a per-stage Failed
# value on failure. Values must match the Reference!V dropdown LoV exactly.
#
#   Pending Photos          (initial; default for new SKUs)
#         │ Arushi uploads + flips
#         ▼
#   Photos Uploaded         ← Stage 1 trigger
#         │ Stage 1 (preprocess)
#         ▼
#   Preprocessed            ← Stage 2 trigger
#         │ Stage 2 (vision)
#         ▼
#   Vision Done             ← Stage 3 trigger
#         │ Stage 3 (FASHN tryon)
#         ▼
#   Tryon Done              ← Stage 4 trigger (planned: Shopify draft)
#         │ Stage 4 (Shopify draft — planned)
#         ▼
#   Shopify Draft Created
#
#   On stage failure (any stage):
#         Failed - Preprocess  | Failed - Vision  |
#         Failed - Tryon       | Failed - Shopify
PHOTO_STATUS = {
    "PENDING":            "Pending Photos",
    "UPLOADED":           "Photos Uploaded",
    "PREPROCESSED":       "Preprocessed",
    "VISION_DONE":        "Vision Done",
    "TRYON_DONE":         "Tryon Done",
    "SHOPIFY_DRAFT":      "Shopify Draft Created",
    "FAILED_PREPROCESS":  "Failed - Preprocess",
    "FAILED_VISION":      "Failed - Vision",
    "FAILED_TRYON":       "Failed - Tryon",
    "FAILED_SHOPIFY":     "Failed - Shopify",
}

# Per-stage Failed value used when a stage fails. Lets stage code do
# `update_cells(..., {photo_status: STAGE_FAILED["vision"]})` without
# memorising literal strings.
STAGE_FAILED = {
    "preprocess": PHOTO_STATUS["FAILED_PREPROCESS"],
    "vision":     PHOTO_STATUS["FAILED_VISION"],
    "tryon":      PHOTO_STATUS["FAILED_TRYON"],
    "shopify":    PHOTO_STATUS["FAILED_SHOPIFY"],
}

# Pipeline Status — human-owned listing lifecycle. The pipeline writes this
# column exactly once: Stage 3 sets "Ready for Review" on success.
# Everything else (Published, On Hold, Cancelled) is set by Grishma.
# Values must match the Reference!X dropdown LoV exactly.
PIPELINE_STATUS = {
    "AWAITING_SPECS":   "Awaiting Specs",
    "AWAITING_PHOTOS":  "Awaiting Photos",
    "READY_FOR_REVIEW": "Ready for Review",
    "PUBLISHED":        "Published",
    "ON_HOLD":          "On Hold",
    "CANCELLED":        "Cancelled",
}


# =============================================================================
# 9. FORMATTING HELPERS
# =============================================================================

def now_ist_iso() -> str:
    """Current timestamp in IST (matches the sheet's audit columns)."""
    # Use UTC offset directly to avoid a tz dependency; IST is UTC+5:30
    import datetime as _dt
    ist = _dt.timezone(_dt.timedelta(hours=5, minutes=30))
    return _dt.datetime.now(ist).strftime("%Y-%m-%d %H:%M")


def safe_filename(s: str) -> str:
    """Strip characters not safe for filenames."""
    return re.sub(r"[^\w\-.]+", "_", s).strip("_")


# =============================================================================
# 9b. VISION HELPERS (Stage 2 — Claude vision)
# =============================================================================

# Standard angle ordering — the order vision sees photos. Matches Drevi's
# canonical file naming (front, back, side, lifestyle, detail, detail2).
VISION_ANGLE_ORDER = ["front", "back", "side", "lifestyle", "detail", "detail2"]


VISION_IMAGE_LONG_EDGE = int(os.getenv("DREVI_VISION_IMAGE_LONG_EDGE", "1568"))
VISION_IMAGE_QUALITY = int(os.getenv("DREVI_VISION_IMAGE_QUALITY", "88"))


def fetch_input_image_b64(
    drive,
    folder_id: str,
    angle: str,
    folder_listing_cache: Optional[Dict[str, List[Dict]]] = None,
) -> Optional[Tuple[str, str]]:
    """Locate a single canonical photo in an INPUT folder, download it, convert
    HEIC to JPEG if needed, and return (base64_string, media_type).

    Returns None if the angle is missing.

    The Claude API accepts JPEG, PNG, GIF, WebP. HEIC must be converted.
    Drevi's canonical files are .HEIC (mannequin angles) and .JPG (details);
    we normalize both to base64 JPEG for vision.

    folder_listing_cache: optional dict {folder_id: [files]} to avoid repeated
    Drive list calls when iterating over multiple angles in the same folder.

    The local cache is keyed on `<file_id><ext>` so a re-upload (which gives
    Drive a new file ID) misses cache and re-downloads automatically.
    """
    import base64
    from io import BytesIO
    from PIL import Image

    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        pass  # HEIC files will fail to open if pillow-heif missing

    if folder_listing_cache is not None and folder_id in folder_listing_cache:
        files = folder_listing_cache[folder_id]
    else:
        files = list_drive_folder(drive, folder_id)
        if folder_listing_cache is not None:
            folder_listing_cache[folder_id] = files

    file_match = find_file_by_stem(files, angle)
    if not file_match:
        return None

    file_id = file_match["id"]
    file_name = file_match.get("name", "")
    ext = Path(file_name).suffix.lower()

    cache_dir = LOCAL_ROOT / "vision_input"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / safe_filename(f"{file_id}{ext}")
    download_drive_file(drive, file_id, cache_path)

    try:
        img = Image.open(cache_path)
        if img.mode != "RGB":
            img = img.convert("RGB")
        img.thumbnail((VISION_IMAGE_LONG_EDGE, VISION_IMAGE_LONG_EDGE))
        buf = BytesIO()
        img.save(buf, format="JPEG", quality=VISION_IMAGE_QUALITY)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return b64, "image/jpeg"
    except Exception as e:
        raise RuntimeError(f"Failed to encode {file_name} as JPEG: {e}")


def collect_sku_vision_images(
    drive,
    folder_id: str,
    log,
) -> Dict[str, Tuple[str, str]]:
    """Fetch all canonical angles from a SKU's photo folder (any folder that
    contains the front/back/side/lifestyle/detail/detail2 stems).

    Today this is called with the PROCESSED folder so vision sees the same
    JPGs FASHN will consume. Missing angles are silently omitted — vision
    can still produce useful output from a subset.

    Returns {angle: (b64, media_type)}.
    """
    cache: Dict[str, List[Dict]] = {}
    out: Dict[str, Tuple[str, str]] = {}
    for angle in VISION_ANGLE_ORDER:
        try:
            result = fetch_input_image_b64(drive, folder_id, angle, cache)
        except Exception as e:
            log.warning("    [%s] fetch failed: %s", angle, e)
            continue
        if result is None:
            continue
        out[angle] = result
    return out


def build_vision_messages(
    angle_images: Dict[str, Tuple[str, str]],
    spec: Dict[str, str],
) -> List[Dict]:
    """Build the Claude messages array for vision analysis.
    Returns a single user message with all images interleaved with labels,
    followed by the spec text and the output schema instructions.
    """
    content: List[Dict] = []

    # Brief framing first so Claude reads the labels in context with the images
    content.append({
        "type": "text",
        "text": (
            "Here are mannequin photos and detail shots of one Drevi garment. "
            "Each image is labelled with its angle. After the images, you'll "
            "find structured spec data from our sourcing team and the JSON "
            "schema you must output."
        ),
    })

    # Interleave label + image for each available angle
    for angle in VISION_ANGLE_ORDER:
        if angle not in angle_images:
            continue
        b64, media_type = angle_images[angle]
        content.append({
            "type": "text",
            "text": f"=== {angle.upper()} ===",
        })
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": b64,
            },
        })

    # Spec block. Vendor identity comes from the Vendor SKU column on the
    # Master tab — the sheet doesn't carry a separate Vendor Name today.
    spec_lines = ["", "=== SPEC SHEET (from sourcing team) ===", ""]
    for key, label in [
        ("color",             "Color"),
        ("color_detail",      "Color Detail"),
        ("primary_fabric",    "Primary Fabric"),
        ("secondary_fabric",  "Secondary Fabric"),
        ("primary_handwork",  "Primary Handwork"),
        ("secondary_handwork", "Secondary Handwork"),
        ("authenticity",      "Authenticity"),
        ("origin",            "Origin"),
        ("care_level",        "Care"),
        ("sub_category",      "Sub-Category"),
        ("category",          "Category"),
        ("vendor_sku",        "Vendor SKU"),
        ("notes_for_listing", "Notes from Rakesh"),
    ]:
        val = spec.get(key, "").strip() if spec.get(key) else ""
        if val:
            spec_lines.append(f"  {label}: {val}")
    if len(spec_lines) == 3:  # nothing got appended
        spec_lines.append("  (No spec data available — describe from images only.)")
    content.append({"type": "text", "text": "\n".join(spec_lines)})

    return [{"role": "user", "content": content}]


def parse_vision_json(raw: str, log) -> Optional[Dict]:
    """Parse Claude's JSON response. Strips markdown fences if any,
    extracts the first {...} block, and validates required keys.
    Returns None on parse failure.
    """
    s = raw.strip()
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"\s*```$", "", s)
    s = s.strip()
    start = s.find("{")
    end = s.rfind("}")
    if start < 0 or end <= start:
        log.error("Vision response has no JSON object: %s", s[:200])
        return None
    try:
        obj = json.loads(s[start:end + 1])
    except json.JSONDecodeError as e:
        log.error("Vision JSON parse error: %s | snippet: %s", e, s[:300])
        return None

    required = [
        "fashn_prompts", "garment_analysis", "product_name",
        "description", "meta_title",
    ]
    missing = [k for k in required if k not in obj]
    if missing:
        log.error("Vision JSON missing required keys: %s", missing)
        return None

    fp = obj.get("fashn_prompts", {})
    for angle in ("front", "back", "side", "lifestyle"):
        if angle not in fp:
            log.warning("  fashn_prompts missing '%s' — will use empty prompt", angle)
            fp[angle] = ""

    return obj


# =============================================================================
# 10. ENTRY-POINT GUARD
# =============================================================================

if __name__ == "__main__":
    # Smoke test — verify creds + sheet access
    log = setup_logger("drevi.common.smoke")
    log.info("Loading credentials...")
    creds = get_credentials()
    log.info("Opening master sheet...")
    client = get_sheets_client()
    ws = get_master_ws(client)
    schema = load_master_schema(ws)
    log.info("Master tab: %d cols, %d rows", ws.col_count, ws.row_count)
    log.info("Effective headers (sample): %s",
             [h for h in schema.effective_headers[:8] if h])
    rows = read_master_rows(ws, schema)
    log.info("Loaded %d data rows", len(rows))
    if rows:
        log.info("First SKU: %s (cat=%s, MRP=%s)",
                 rows[0].get("drevi_sku"),
                 rows[0].get("cat_code"),
                 rows[0].get("final_mrp"))


# ---------------------------------------------------------------------------
# Drevi App integration (build guide Stage 4, added 26 Jul 2026)
# ---------------------------------------------------------------------------
# JobReporter streams a pipeline_jobs row's lifecycle back to Supabase over
# plain REST (service-role key). State-backend switch (guide D7): stage
# scripts keep defaulting to the sheet; the runner always passes
# --state supabase. Nothing above this block changed.

import urllib.request as _urllib_request


def get_state_backend(default: str = "sheet") -> str:
    """D7: 'sheet' (legacy CLI default until Stage 8) or 'supabase'."""
    return os.environ.get("DREVI_STATE_BACKEND", default).strip().lower() or default


class SupabaseRest:
    """Minimal PostgREST client — no SDK dependency in the runner."""

    def __init__(self, url: str | None = None, key: str | None = None):
        self.url = (url or os.environ.get("SUPABASE_URL", "")).rstrip("/")
        self.key = key or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not self.url or not self.key:
            raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set")

    def _req(self, method: str, path: str, body=None, prefer: str | None = None):
        req = _urllib_request.Request(
            f"{self.url}/rest/v1/{path}",
            data=json.dumps(body).encode() if body is not None else None,
            method=method,
        )
        req.add_header("apikey", self.key)
        req.add_header("Authorization", f"Bearer {self.key}")
        req.add_header("Content-Type", "application/json")
        req.add_header("Prefer", prefer or "return=representation")
        with _urllib_request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw else None

    def select(self, table: str, query: str):
        return self._req("GET", f"{table}?{query}")

    def insert(self, table: str, rows, upsert_on: str | None = None):
        prefer = "return=representation"
        path = table
        if upsert_on:
            prefer += ",resolution=merge-duplicates"
            path += f"?on_conflict={upsert_on}"
        return self._req("POST", path, rows, prefer)

    def update(self, table: str, query: str, patch):
        return self._req("PATCH", f"{table}?{query}", patch)


class JobReporter:
    """Owns one pipeline_jobs row: claim → progress/log → done|error.

    The runner traps ALL exceptions and finalises the row — a killed run must
    leave a resumable 'error', never a stuck 'running' (guide §8 done-when).
    """

    def __init__(self, job_id: str, runner_id: str, rest: SupabaseRest | None = None):
        self.job_id = job_id
        self.runner_id = runner_id
        self.rest = rest or SupabaseRest()
        self._log_lines: list[str] = []

    def _patch(self, patch: dict):
        self.rest.update("pipeline_jobs", f"id=eq.{self.job_id}", patch)

    def claim(self) -> dict:
        rows = self.rest.select("pipeline_jobs", f"id=eq.{self.job_id}&select=*")
        if not rows:
            raise RuntimeError(f"job {self.job_id} not found")
        job = rows[0]
        if job["status"] not in ("queued", "claimed"):
            raise RuntimeError(f"job {self.job_id} is {job['status']} — not claimable")
        self._patch({"status": "claimed", "runner_id": self.runner_id})
        self._patch({"status": "running", "started_at": _now_iso(), "progress": 0})
        return job

    def progress(self, pct: int, line: str | None = None):
        patch: dict = {"progress": max(0, min(100, int(pct)))}
        if line:
            self._log_lines.append(line)
            patch["log"] = "\n".join(self._log_lines)[-9000:]
        self._patch(patch)

    def log(self, line: str):
        self._log_lines.append(line)
        self._patch({"log": "\n".join(self._log_lines)[-9000:]})

    def add_cost(self, credits: float):
        rows = self.rest.select("pipeline_jobs", f"id=eq.{self.job_id}&select=cost_credits")
        current = float(rows[0]["cost_credits"] or 0) if rows else 0.0
        self._patch({"cost_credits": current + credits})

    def done(self):
        self._patch({"status": "done", "progress": 100, "finished_at": _now_iso()})

    def error(self, message: str):
        self._log_lines.append(f"ERROR: {message}")
        self._patch({"status": "error", "log": "\n".join(self._log_lines)[-9000:], "finished_at": _now_iso()})


def _now_iso() -> str:
    import datetime as _dt

    return _dt.datetime.now(_dt.timezone.utc).isoformat()
