"""Stage 1 — Format normalisation + detail crop (post-color-correction era).

This stage was previously ~750 lines and handled white balance sampling,
white-card detection, gain inheritance, and JPEG re-encoding. Color
correction was removed in April 2026 — the Drevi store's mixed lighting
made white-card sampling unreliable, and uncorrected source images were
visually closer to the actual garments. Stage 1 now does two simple jobs:

  1. Mannequin shots (front, back, side, lifestyle):
       HEIC -> JPEG q98 conversion (so FASHN can process them).
       JPG passes through unchanged.
       Output to PROCESSED/<sku>/.

  2. Detail shots (detail, detail2):
       Center-crop to 4:5 (matching brand model ratio for gallery
       consistency), save as JPEG q98.
       Output to PROCESSED/<sku>/.

Two env flags control whether HEIC files get converted at all:
  DREVI_CONVERT_MANNEQUIN_HEIC=0  -> mannequin HEICs pass through unchanged
  DREVI_CONVERT_DETAIL_HEIC=0     -> detail HEICs pass through (no crop, no
                                     re-encode) - useful for testing whether
                                     Shopify accepts HEIC directly

Triggers
--------
default (no --sku):       Photo Status == "Photos Uploaded"
                          AND Processed Folder URL empty
with --sku:               INPUT folder discoverable
--force --sku ...:        Re-runs regardless of state.

State: photo_status stays "Photos Uploaded" after Stage 1 - Stage 3 (FASHN)
is what advances it to "AI Done".
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).parent))

from drevi_common import (  # noqa: E402
    COLS, CONVERT_DETAIL_HEIC, CONVERT_MANNEQUIN_HEIC, DETAIL_RATIO,
    JPEG_QUALITY, LOCAL_LOGS, PHOTO_STATUS, STAGE_FAILED, SheetSchema,
    base_sku_from_drevi_sku, download_drive_file, ensure_anyone_can_read,
    find_file_by_stem, first_sibling_value, get_drive_service,
    get_master_ws, get_or_create_subfolder, get_sheets_client,
    group_master_rows_by_base_color, group_matches_sku_filter,
    list_drive_folder, list_input_folder_names, load_master_schema,
    parse_drive_folder_id, photo_folder_name, read_master_rows,
    resolve_input_folder, safe_filename, setup_logger, update_cells,
    upload_file_to_drive,
)


MANNEQUIN_STEMS = ("front", "back", "side", "lifestyle")
DETAIL_STEMS    = ("detail", "detail2")
ALL_STEMS       = MANNEQUIN_STEMS + DETAIL_STEMS

HEIC_EXTS = {".heic", ".heif"}
JPG_EXTS  = {".jpg", ".jpeg"}


def file_kind(stem: str) -> str:
    if stem in MANNEQUIN_STEMS:
        return "mannequin"
    if stem in DETAIL_STEMS:
        return "detail"
    return "unknown"


def _ensure_pil():
    """Lazy PIL + HEIC opener registration."""
    from PIL import Image
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        pass
    return Image


def center_crop_to_ratio(img, target_ratio: Tuple[int, int]):
    """Center-crop a PIL Image to (w, h) ratio. Returns new Image."""
    target_w, target_h = target_ratio
    cur_w, cur_h = img.size
    cur_ratio = cur_w / cur_h
    target = target_w / target_h

    if abs(cur_ratio - target) < 1e-3:
        return img.copy()

    if cur_ratio > target:
        # wider than target -> crop horizontally
        new_w = int(round(cur_h * target))
        offset = (cur_w - new_w) // 2
        return img.crop((offset, 0, offset + new_w, cur_h))
    else:
        # taller than target -> crop vertically
        new_h = int(round(cur_w / target))
        offset = (cur_h - new_h) // 2
        return img.crop((0, offset, cur_w, offset + new_h))


def process_mannequin_file(
    drive, src_file: Dict, src_local_path: Path,
    output_folder_id: str, log,
) -> Optional[Dict]:
    """Process one mannequin angle.
    JPG -> passthrough. HEIC -> JPEG q98 (or passthrough if flag off)."""
    src_name = src_file.get("name", "")
    src_ext = Path(src_name).suffix.lower()
    stem = Path(src_name).stem

    if src_ext in JPG_EXTS:
        log.info("    [%s] JPG passthrough", stem)
        return upload_file_to_drive(
            drive, src_local_path, output_folder_id,
            name=f"{stem}.jpg",
            mime_type="image/jpeg",
        )

    if src_ext in HEIC_EXTS:
        if not CONVERT_MANNEQUIN_HEIC:
            log.info("    [%s] HEIC passthrough (CONVERT_MANNEQUIN_HEIC=0)",
                     stem)
            return upload_file_to_drive(
                drive, src_local_path, output_folder_id,
                name=f"{stem}{src_ext}",
                mime_type="image/heic",
            )
        log.info("    [%s] HEIC -> JPEG q%d", stem, JPEG_QUALITY)
        Image = _ensure_pil()
        img = Image.open(src_local_path)
        if img.mode != "RGB":
            img = img.convert("RGB")
        out_path = src_local_path.with_suffix(".jpg")
        img.save(out_path, format="JPEG", quality=JPEG_QUALITY)
        return upload_file_to_drive(
            drive, out_path, output_folder_id,
            name=f"{stem}.jpg",
            mime_type="image/jpeg",
        )

    log.warning("    [%s] unsupported ext %r - skipped", stem, src_ext)
    return None


def process_detail_file(
    drive, src_file: Dict, src_local_path: Path,
    output_folder_id: str, log,
) -> Optional[Dict]:
    """Detail file: center-crop to 4:5, save as JPEG q98.
    HEIC + flag-off = passthrough (no crop)."""
    src_name = src_file.get("name", "")
    src_ext = Path(src_name).suffix.lower()
    stem = Path(src_name).stem

    if src_ext in HEIC_EXTS and not CONVERT_DETAIL_HEIC:
        log.info("    [%s] HEIC passthrough (CONVERT_DETAIL_HEIC=0, no crop)",
                 stem)
        return upload_file_to_drive(
            drive, src_local_path, output_folder_id,
            name=f"{stem}{src_ext}",
            mime_type="image/heic",
        )

    if src_ext in (HEIC_EXTS | JPG_EXTS):
        Image = _ensure_pil()
        img = Image.open(src_local_path)
        if img.mode != "RGB":
            img = img.convert("RGB")
        cropped = center_crop_to_ratio(img, DETAIL_RATIO)
        log.info("    [%s] %dx%d -> %dx%d (%d:%d) JPEG q%d",
                 stem, img.size[0], img.size[1],
                 cropped.size[0], cropped.size[1],
                 DETAIL_RATIO[0], DETAIL_RATIO[1], JPEG_QUALITY)
        out_path = src_local_path.with_suffix(".jpg")
        cropped.save(out_path, format="JPEG", quality=JPEG_QUALITY)
        return upload_file_to_drive(
            drive, out_path, output_folder_id,
            name=f"{stem}.jpg",
            mime_type="image/jpeg",
        )

    log.warning("    [%s] unsupported ext %r - skipped", stem, src_ext)
    return None


def process_one_group(
    drive, sheets_client, ws, schema: SheetSchema,
    base_sku: str, color_code: str, siblings: List[Dict],
    args, log,
) -> Tuple[bool, Optional[str]]:
    group_label = f"{base_sku}/{color_code or '_'}"
    log.info("Group %s (%d siblings)", group_label, len(siblings))

    # Resolve INPUT folder
    input_folder_id = None
    sheet_url = first_sibling_value(siblings, "input_folder_url")
    if sheet_url:
        try:
            input_folder_id = parse_drive_folder_id(sheet_url)
        except Exception:
            input_folder_id = None
    if not input_folder_id:
        input_root_id = os.environ.get("DREVI_INPUT_FOLDER_ID")
        if not input_root_id:
            return False, "DREVI_INPUT_FOLDER_ID env var not set"
        try:
            sibling_skus = [
                s.get("drevi_sku", "") for s in siblings if s.get("drevi_sku")
            ]
            input_folder_id, matched_name = resolve_input_folder(
                drive, input_root_id,
                sibling_skus=sibling_skus,
                base_sku=base_sku,
                color_code=color_code,
            )
            if not input_folder_id:
                return False, (
                    f"INPUT folder not found in Drive for {base_sku}/"
                    f"{color_code or '_'}. Tried: "
                    f"{', '.join(sibling_skus) or base_sku}."
                )
            log.info("  INPUT: %r (id=%s)", matched_name, input_folder_id)
        except Exception as e:
            return False, f"INPUT folder lookup failed: {e}"

    input_files = list_drive_folder(drive, input_folder_id)
    if not input_files:
        return False, "INPUT folder is empty"

    # Hard prerequisite: front + back stems must exist. Vision (Stage 2)
    # cannot produce useful output without these two angles, and FASHN
    # (Stage 3) can't render the primary listing images without them.
    have_front = find_file_by_stem(input_files, "front") is not None
    have_back  = find_file_by_stem(input_files, "back") is not None
    if not (have_front and have_back):
        missing = [
            label for label, ok in (("front", have_front), ("back", have_back))
            if not ok
        ]
        return False, (
            f"INPUT folder is missing required stem(s): {missing}. "
            f"Front + back are required before this SKU can move to "
            f"Preprocessed."
        )

    # PROCESSED subfolder
    processed_root = os.environ.get("DREVI_PROCESSED_FOLDER_ID")
    if not processed_root:
        return False, "DREVI_PROCESSED_FOLDER_ID env var not set"
    sku_folder_name = photo_folder_name(base_sku, color_code)
    processed_sku_folder_id = get_or_create_subfolder(
        drive, processed_root, sku_folder_name,
    )
    log.info("  PROCESSED: %r (id=%s)", sku_folder_name,
             processed_sku_folder_id)

    # Process each canonical angle
    with tempfile.TemporaryDirectory(prefix="drevi_preprocess_") as tmpdir:
        tmp_root = Path(tmpdir)
        output_files: Dict[str, Dict] = {}

        for stem in ALL_STEMS:
            src_file = find_file_by_stem(input_files, stem)
            if not src_file:
                log.info("    [%s] not in INPUT - skipped", stem)
                continue

            file_id = src_file["id"]
            file_name = src_file.get("name", f"{stem}")
            local_path = tmp_root / safe_filename(file_name)
            try:
                download_drive_file(drive, file_id, local_path)
            except Exception as e:
                log.error("    [%s] download failed: %s", stem, e)
                continue

            kind = file_kind(stem)
            try:
                if kind == "mannequin":
                    out = process_mannequin_file(
                        drive, src_file, local_path,
                        processed_sku_folder_id, log,
                    )
                elif kind == "detail":
                    out = process_detail_file(
                        drive, src_file, local_path,
                        processed_sku_folder_id, log,
                    )
                else:
                    log.warning("    [%s] unknown stem - skipped", stem)
                    continue
                if out:
                    output_files[stem] = out
                    try:
                        ensure_anyone_can_read(drive, out["id"])
                    except Exception as e:
                        log.warning("    [%s] permission set failed: %s",
                                    stem, e)
            except Exception as e:
                log.error("    [%s] processing failed: %s", stem, e)
                continue

    if not output_files:
        return False, "no files processed successfully"

    log.info("  Output files: %s", ", ".join(sorted(output_files.keys())))

    # Writeback: PROCESSED folder URL + advance Photo Status to Preprocessed.
    # One batch_update per sibling row.
    processed_folder_url = (
        f"https://drive.google.com/drive/folders/{processed_sku_folder_id}"
    )
    processed_col = schema.col_letter("processed_url")
    photo_status_col = schema.col_letter("photo_status")
    write_count = 0
    for row in siblings:
        row_idx = row["_row_index"]
        try:
            update_cells(ws, row_idx, {
                processed_col:    processed_folder_url,
                photo_status_col: PHOTO_STATUS["PREPROCESSED"],
            })
            write_count += 1
        except Exception as e:
            log.error("  writeback failed for row %d: %s", row_idx, e)

    log.info("  Sheet writes: %d siblings (status -> Preprocessed)", write_count)
    return True, None


def _candidate_folder_names(siblings: List[Dict], base_sku: str, color_code: str) -> List[str]:
    """Names that an INPUT subfolder could plausibly use for this group, in
    priority order — mirrors resolve_input_folder()'s candidate logic so Stage
    1's Drive-sweep matches whatever Arushi happened to type."""
    names: List[str] = []
    for s in siblings:
        sku = s.get("drevi_sku", "")
        if sku and sku not in names:
            names.append(sku)
    if base_sku and color_code and color_code != "OTH":
        c2 = f"{base_sku}-{color_code}"
        if c2 not in names:
            names.append(c2)
    if base_sku and base_sku not in names:
        names.append(base_sku)
    return names


def build_plan(
    rows: List[Dict],
    sku_filter: Optional[str],
    force: bool,
    drive,
    input_root_id: Optional[str],
    log,
) -> List[Tuple[str, str, List[Dict]]]:
    """Decide which (base_sku, color_code) groups Stage 1 should process.

    Default trigger (no --sku):
        Drive sweep finds an INPUT subfolder whose name matches one of the
        group's candidate names (full Drevi SKU, base+colour, or bare base)
        AND the group's Photo Status is in {Pending Photos, Photos Uploaded}.

        Folder presence in INPUT counts as 'photos uploaded' even when the
        sheet still says 'Pending Photos' — Arushi doesn't have to flip the
        dropdown manually.

    With --sku: data-driven; processes the matching group regardless of state.
    With --force --sku: same, but a deliberate re-run.
    """
    groups = group_master_rows_by_base_color(rows)
    plan: List[Tuple[str, str, List[Dict]]] = []

    # --- Drive sweep for the catalog-wide path ---
    folder_set: set = set()
    if input_root_id and not (sku_filter or force):
        try:
            names = list_input_folder_names(drive, input_root_id)
            folder_set = {n.strip().lower() for n in names if n.strip()}
            log.info("Drive sweep: %d INPUT subfolders found", len(folder_set))
        except Exception as e:
            log.warning("Drive sweep failed (%s) — falling back to status trigger", e)

    matched_folders: set = set()
    eligible_states = {PHOTO_STATUS["PENDING"], PHOTO_STATUS["UPLOADED"]}

    for (base_sku, color_code), siblings in groups.items():
        if sku_filter and not group_matches_sku_filter(siblings, sku_filter):
            continue

        first = siblings[0]
        photo_status = (first.get("photo_status") or "").strip()

        if force:
            if not sku_filter:
                continue
            plan.append((base_sku, color_code, siblings))
            continue

        if sku_filter:
            plan.append((base_sku, color_code, siblings))
            continue

        # --- Catalog-wide path: Drive-sweep + status guard ---
        candidates = _candidate_folder_names(siblings, base_sku, color_code)
        match = next(
            (c for c in candidates if c.strip().lower() in folder_set),
            None,
        )

        if match:
            # Folder exists in INPUT — implies photos are there.
            if photo_status in eligible_states:
                matched_folders.add(match.lower())
                plan.append((base_sku, color_code, siblings))
            else:
                # Folder exists but SKU has already moved past upload step
                # (Preprocessed / Vision Done / Tryon Done / Failed-*).
                # Skip silently — re-runs go through --force.
                matched_folders.add(match.lower())
        elif photo_status == PHOTO_STATUS["UPLOADED"]:
            # No folder match but status was set manually — leave for caller
            # to triage. We don't queue it because preprocess will fail at
            # INPUT lookup and produce a clearer error there.
            log.warning(
                "Group %s/%s has Photo Status=%r but no INPUT folder found "
                "(tried: %s). Skipping; preprocess would fail at folder lookup.",
                base_sku, color_code or "_", photo_status, ", ".join(candidates),
            )

    # Surface unmatched INPUT folders so the team notices misnamed uploads
    # or SKUs that haven't been added to the sheet yet.
    if folder_set and not (sku_filter or force):
        unmatched = sorted(folder_set - matched_folders)
        if unmatched:
            log.warning(
                "Unmatched INPUT folders (%d) — no SKU on Master matches these "
                "names: %s",
                len(unmatched), ", ".join(unmatched),
            )

    return plan


def main():
    parser = argparse.ArgumentParser(
        description="Stage 1: format normalisation + 4:5 detail crop",
    )
    parser.add_argument("--sku")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    log = setup_logger("drevi.preprocess", LOCAL_LOGS / "01_preprocess.log")
    log.info("=" * 70)
    log.info("Stage 1: Preprocess | sku=%s | force=%s",
             args.sku or "(all)", args.force)
    log.info("Flags: convert_mannequin_heic=%s, convert_detail_heic=%s, "
             "jpeg_q=%d, detail_ratio=%d:%d",
             CONVERT_MANNEQUIN_HEIC, CONVERT_DETAIL_HEIC, JPEG_QUALITY,
             DETAIL_RATIO[0], DETAIL_RATIO[1])

    if args.force and not args.sku:
        log.error("--force requires --sku for safety. Aborting.")
        return 2

    sheets_client = get_sheets_client()
    ws = get_master_ws(sheets_client)
    schema = load_master_schema(ws)
    drive = get_drive_service()

    rows = read_master_rows(ws, schema)
    log.info("Master Sheet: %d data rows", len(rows))

    input_root_id = os.environ.get("DREVI_INPUT_FOLDER_ID")
    plan = build_plan(rows, args.sku, args.force, drive, input_root_id, log)
    log.info("Plan: %d groups", len(plan))

    if args.dry_run:
        for (base_sku, color_code, siblings) in plan:
            log.info("  %s/%s (%d siblings)", base_sku, color_code or "_",
                     len(siblings))
        return 0

    if not plan:
        log.info("No SKUs ready for preprocess.")
        return 0

    photo_status_col = schema.col_letter("photo_status")

    def _mark_failed(siblings_list: List[Dict]) -> None:
        for r in siblings_list:
            try:
                update_cells(ws, r["_row_index"], {
                    photo_status_col: STAGE_FAILED["preprocess"],
                })
            except Exception as e:
                log.error("  failed-status writeback failed for row %d: %s",
                          r.get("_row_index"), e)

    succeeded: List[str] = []
    failed: List[Tuple[str, str]] = []
    for (base_sku, color_code, siblings) in plan:
        try:
            ok, err = process_one_group(
                drive=drive, sheets_client=sheets_client,
                ws=ws, schema=schema,
                base_sku=base_sku, color_code=color_code,
                siblings=siblings, args=args, log=log,
            )
            label = f"{base_sku}/{color_code or '_'}"
            if ok:
                succeeded.append(label)
            else:
                failed.append((label, err or "unknown"))
                _mark_failed(siblings)
        except Exception as e:
            log.exception("Group %s/%s blew up", base_sku, color_code)
            failed.append((f"{base_sku}/{color_code}", str(e)))
            _mark_failed(siblings)

    log.info("=" * 70)
    log.info("DONE * %d succeeded * %d failed",
             len(succeeded), len(failed))
    for label, err in failed:
        log.error("  FAIL %s: %s", label, err)

    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
