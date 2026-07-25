#!/usr/bin/env python3
"""
test_fashn_local.py
====================
Quick FASHN test against local staff-wearing-outfit photos.

Reads photos from:  /Users/anshsarawagi/Documents/Tryon_testing/<folder>/
Writes results to:  /Users/anshsarawagi/Documents/Tryon_testing/Results/<folder>/

Two FASHN endpoints, picked via --mode:

  --mode tryon-max   (default)
    The local photo is the `product_image` (garment source). The brand-model
    pose is the `model_image` (target body). FASHN re-renders the garment
    on the brand-model pose. Cheaper, but the garment can drift on
    embellishment detail or silhouette (FASHN reconstructs the garment).

  --mode model-swap
    The local photo is the `model_image` (preserves outfit + pose verbatim).
    The brand-model pose is the `face_reference` (identity to apply).
    `face_reference_mode = match_base` keeps the staff's head angle and
    swaps the face only. Embellishment and pose are preserved pixel-accurate;
    only the person changes. +3 cr per output for the face_reference.

Two modes, controlled by --angles:

  --angles front           DEFAULT. Single-angle mode.
                           EVERY image in the folder is sent as a front-pose
                           tryon. Filenames are NOT checked — drop whatever
                           you have. Each output keeps the source filename
                           stem: staff_red.jpg -> staff_red.png.

  --angles all             Multi-angle mode (also: --angles front,back,side).
                           Requires canonical stem-named files
                           (front.*, back.*, side.*, lifestyle.*) and
                           outputs <angle>.png per stem.

HEIC/PNG/etc. are auto-converted to JPEG q95 before upload to Drive.
The temp uploads land under PROCESSED/_TRYON_TESTING/<folder>/ on Drive
so they don't pollute the production INPUT/PROCESSED trees.

Usage:
    cd /Users/anshsarawagi/Documents/drevi/pipeline/scripts
    source .env
    source .venv/bin/activate

    # Default — tryon-max, front only, any filenames, Brand Model A
    python test_fashn_local.py test_9_may

    # Same input but via model-swap (outfit pixel-accurate, swaps person)
    python test_fashn_local.py test_9_may --mode model-swap

    # Bridal tier (4k quality) on tryon-max
    python test_fashn_local.py test_9_may --tier bridal

    # Full 4-angle test (requires front/back/side/lifestyle stem files)
    python test_fashn_local.py test_9_may --angles all

    # Override brand model + add a prompt
    python test_fashn_local.py test_9_may --brand-model B --prompt "drape pallu"

Env vars required (same .env as the main pipeline):
    FASHN_API_KEY
    GOOGLE_APPLICATION_CREDENTIALS
    DREVI_BRAND_MODEL_FOLDER_ID
    DREVI_PROCESSED_FOLDER_ID    (used as parent for Drive temp uploads)
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import requests

# Make the script runnable from any cwd
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from drevi_common import (  # noqa: E402
    ANGLES, FASHN_BASE_URL, FASHN_MODEL_NAME, FASHN_POLL_INTERVAL_SEC,
    FASHN_POLL_TIMEOUT_SEC, ensure_anyone_can_read, get_drive_service,
    get_or_create_subfolder, list_drive_folder, make_public_url,
    normalize_brand_model, resolve_angle_pose_filenames,
    resolve_brand_model_folder, setup_logger, tier_angle_params,
    tryon_max_credits, upload_file_to_drive,
)


ROOT = Path("/Users/anshsarawagi/Documents/Tryon_testing")
RESULTS_ROOT = ROOT / "Results"

# NOTE: per-angle pose filenames are NO LONGER hard-coded here. They are
# model-specific (Model A flat/angle-named, Model B nested/pose_NN_*) and come
# from drevi_common.resolve_angle_pose_filenames() — the single source of truth
# shared with 03_fashn_runner.py. Do not reintroduce a local copy (that drift
# is exactly what silently broke Model A).

ACCEPTED_EXTS = (".jpg", ".jpeg", ".heic", ".heif", ".png", ".webp")

# Per-angle seed offset so a single --seed value still produces 4 distinct
# outputs. Mirrors angle_seed() in drevi_common.
ANGLE_OFFSETS = {"front": 0, "back": 1, "side": 2, "lifestyle": 3}

# ---- Model-swap tier matrix ----
# Different from tryon-max because model-swap has a 3-value generation_mode
# ('fast' | 'balanced' | 'quality') and a different credit table:
#       fast     bal     qual
#   1k    1       2       3
#   2k    2       3       4
#   4k    3       4       5
# Plus +3 credits when face_reference is provided (we always provide one
# for the brand-model identity).
MODEL_SWAP_TIER = {
    "standard":  ("2k", "balanced"),  # 3 + 3 = 6 cr
    "hero_lite": ("2k", "quality"),   # 4 + 3 = 7 cr
    "hero":      ("4k", "quality"),   # 5 + 3 = 8 cr
    "bridal":    ("4k", "quality"),   # 5 + 3 = 8 cr
}

MODEL_SWAP_CREDITS = {
    ("1k", "fast"): 1, ("1k", "balanced"): 2, ("1k", "quality"): 3,
    ("2k", "fast"): 2, ("2k", "balanced"): 3, ("2k", "quality"): 4,
    ("4k", "fast"): 3, ("4k", "balanced"): 4, ("4k", "quality"): 5,
}
MODEL_SWAP_FACE_REF_SURCHARGE = 3


# =============================================================================
# Image normalisation
# =============================================================================

def _ensure_pillow():
    from PIL import Image
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        pass
    return Image


def normalise_to_jpeg(src: Path, dst: Path, quality: int = 95) -> Path:
    """Convert any common image format (HEIC/PNG/WEBP/...) to JPEG.
    JPGs get re-saved at the configured quality so we have one consistent
    upload format for FASHN."""
    Image = _ensure_pillow()
    img = Image.open(src)
    if img.mode != "RGB":
        img = img.convert("RGB")
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, format="JPEG", quality=quality)
    return dst


# =============================================================================
# Drive helpers
# =============================================================================

def find_pose_url(drive, brand_model: str, pose_filename: str) -> str:
    """Resolve the public URL of a brand-model pose using the SHARED
    per-model folder resolver (Model A is flat; Model B is nested under
    poses/). Never creates folders."""
    root = os.environ.get("DREVI_BRAND_MODEL_FOLDER_ID")
    if not root:
        raise RuntimeError("DREVI_BRAND_MODEL_FOLDER_ID env var not set.")
    pose_folder_id = resolve_brand_model_folder(drive, root, brand_model)
    files = list_drive_folder(drive, pose_folder_id)
    by_name = {(f.get("name") or "").lower(): f for f in files}
    if pose_filename.lower() not in by_name:
        raise RuntimeError(
            f"Pose {pose_filename!r} not found in Model {brand_model}'s "
            f"pose folder ({pose_folder_id}). "
            f"Available: {sorted(by_name)[:8]}"
        )
    fid = by_name[pose_filename.lower()]["id"]
    try:
        ensure_anyone_can_read(drive, fid)
    except Exception as e:
        # The pose folder is normally already public; warn but continue.
        logging_warn(f"could not set anyone-read on pose {fid}: {e}")
    return make_public_url(fid)


def logging_warn(msg: str) -> None:
    """Tiny helper to avoid pulling logging into helper scope."""
    print(f"WARN: {msg}", file=sys.stderr)


# =============================================================================
# FASHN client (inline — keeps the script self-contained)
# =============================================================================

def submit_tryon(
    api_key: str,
    *,
    model_image_url: str,
    product_image_url: str,
    resolution: str,
    generation_mode: str,
    seed: int,
    prompt: str,
    output_format: str = "png",
) -> str:
    inputs = {
        "model_image":     model_image_url,
        "product_image":   product_image_url,
        "resolution":      resolution,
        "generation_mode": generation_mode,
        "seed":            int(seed),
        "num_images":      1,
        "output_format":   output_format,
    }
    if prompt:
        inputs["prompt"] = prompt
    r = requests.post(
        f"{FASHN_BASE_URL}/run",
        json={"model_name": "tryon-max", "inputs": inputs},
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(f"FASHN /run {r.status_code}: {r.text[:300]}")
    pid = r.json().get("id")
    if not pid:
        raise RuntimeError(f"FASHN /run no id in response: {r.json()}")
    return pid


def submit_model_swap(
    api_key: str,
    *,
    source_image_url: str,       # the local photo — preserves outfit + pose
    face_reference_url: str,     # brand-model identity reference
    resolution: str,
    generation_mode: str,        # 'fast' | 'balanced' | 'quality'
    seed: int,
    prompt: str,
    face_reference_mode: str = "match_base",
    output_format: str = "png",
) -> str:
    """Submit a model-swap job. The source image's clothing and pose are
    preserved verbatim; only the person's identity is swapped to match
    `face_reference_url`. `match_base` keeps the source's head angle and
    expression — best when the staff photo is well-posed.
    """
    inputs = {
        "model_image":         source_image_url,    # docs: "Source image
                                                     # containing clothing
                                                     # and pose to preserve"
        "face_reference":      face_reference_url,
        "face_reference_mode": face_reference_mode,
        "resolution":          resolution,
        "generation_mode":     generation_mode,
        "seed":                int(seed),
        "num_images":          1,
        "output_format":       output_format,
    }
    if prompt:
        inputs["prompt"] = prompt
    r = requests.post(
        f"{FASHN_BASE_URL}/run",
        json={"model_name": "model-swap", "inputs": inputs},
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(f"FASHN /run {r.status_code}: {r.text[:300]}")
    pid = r.json().get("id")
    if not pid:
        raise RuntimeError(f"FASHN /run no id in response: {r.json()}")
    return pid


def poll_until_done(api_key: str, pid: str, log) -> dict:
    deadline = time.time() + FASHN_POLL_TIMEOUT_SEC
    while time.time() < deadline:
        r = requests.get(
            f"{FASHN_BASE_URL}/status/{pid}",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=20,
        )
        if r.status_code != 200:
            log.warning("  status poll %s -> %d, retrying", pid, r.status_code)
            time.sleep(FASHN_POLL_INTERVAL_SEC)
            continue
        body = r.json()
        if body.get("status") == "completed":
            return body
        if body.get("status") == "failed":
            raise RuntimeError(f"FASHN failed: {body.get('error', 'unknown')}")
        time.sleep(FASHN_POLL_INTERVAL_SEC)
    raise TimeoutError(f"FASHN job {pid} timed out after {FASHN_POLL_TIMEOUT_SEC}s")


# =============================================================================
# Main flow
# =============================================================================

def find_local_stems(folder: Path) -> Dict[str, Path]:
    """Return {stem: path} for files named exactly <stem>.<accepted_ext>.
    Case-insensitive on filename."""
    by_lower = {f.name.lower(): f for f in folder.iterdir() if f.is_file()}
    found: Dict[str, Path] = {}
    for stem in ANGLES:
        for ext in ACCEPTED_EXTS:
            cand = f"{stem}{ext}"
            if cand in by_lower:
                found[stem] = by_lower[cand]
                break
    return found


def main() -> int:
    parser = argparse.ArgumentParser(
        description="FASHN tryon-max test against local staff photos.",
    )
    parser.add_argument("folder_name", help="e.g. test_9_may")
    parser.add_argument("--mode", default="tryon-max",
                        choices=["tryon-max", "model-swap"],
                        help="FASHN endpoint. tryon-max re-renders the "
                             "garment on a different body; model-swap "
                             "preserves the outfit pixel-accurate and only "
                             "swaps the person's face/identity. (default tryon-max)")
    parser.add_argument("--brand-model", default="A", choices=["A", "B"],
                        help="Brand model A or B (default A).")
    parser.add_argument("--tier", default="standard",
                        choices=["standard", "hero_lite", "hero", "bridal"],
                        help="Quality tier (per-angle params; default standard).")
    parser.add_argument("--prompt", default="",
                        help="Optional FASHN prompt applied to every angle.")
    parser.add_argument("--seed", type=int, default=42,
                        help="Base seed; per-angle offset is added (default 42).")
    parser.add_argument(
        "--angles", default="front",
        help="Comma-separated angles to run. Default 'front' = single-angle "
             "mode: EVERY image in the folder is treated as a front-pose "
             "test, filenames are not checked. Pass 'all' for "
             "front,back,side,lifestyle (requires canonical stem-named "
             "files). Other valid values: front, back, side, lifestyle.",
    )
    parser.add_argument(
        "--label", default="",
        help="Suffix appended to output filenames so re-runs at different "
             "tiers/modes don't overwrite. If empty, defaults to the mode "
             "(so model-swap outputs become e.g. IMG_0693_model-swap.png "
             "and tryon-max outputs stay IMG_0693.png for backward compat).",
    )
    parser.add_argument(
        "--pose-override", default="",
        help="Path to a LOCAL image file to use as the FASHN model_image "
             "(or face_reference, in model-swap mode) instead of the "
             "default Drive brand-model pose. The local file is normalised "
             "to JPEG and uploaded to Drive temporarily. Use this to A/B "
             "test candidate brand-model PNGs without touching the "
             "production brand-model folder. The pose candidate's filename "
             "stem auto-fills the output label if --label isn't set.",
    )
    args = parser.parse_args()

    log = setup_logger("drevi.test_fashn",
                       SCRIPT_DIR.parent.parent / "test_fashn_local.log"
                       if (SCRIPT_DIR.parent.parent).is_dir() else None)

    api_key = os.environ.get("FASHN_API_KEY")
    if not api_key:
        log.error("FASHN_API_KEY env var not set. Did you `source .env`?")
        return 1

    in_dir = ROOT / args.folder_name
    out_dir = RESULTS_ROOT / args.folder_name
    if not in_dir.is_dir():
        log.error("Input folder not found: %s", in_dir)
        return 1
    out_dir.mkdir(parents=True, exist_ok=True)

    # ---- Parse --angles ----
    raw = args.angles.strip().lower()
    if raw == "all":
        angles = ["front", "back", "side", "lifestyle"]
    else:
        angles = [a.strip() for a in raw.split(",") if a.strip()]
    invalid = [a for a in angles if a not in ANGLES]
    if not angles or invalid:
        log.error("Invalid --angles %r. Valid values: %s, or 'all'.",
                  args.angles, ANGLES)
        return 1
    single_angle_mode = len(angles) == 1

    # Per-model pose filenames (single source of truth in drevi_common).
    # test_fashn_local doesn't read the Brand Model Map, so Model B's
    # lifestyle slot uses the default movement pose; Model A ignores it.
    brand_model = normalize_brand_model(args.brand_model, log)
    angle_to_pose = resolve_angle_pose_filenames(
        brand_model, "pose_06_turning", log,
    )

    # ---- Build the work plan ----
    # work_items: List[(angle, source_path, output_stem)]
    work_items: List[Tuple[str, Path, str]] = []
    if single_angle_mode:
        angle = angles[0]
        # Take EVERY image file in the folder; filenames don't matter.
        files = sorted(
            p for p in in_dir.iterdir()
            if p.is_file() and p.suffix.lower() in ACCEPTED_EXTS
        )
        if not files:
            log.error("No image files in %s", in_dir)
            log.info("Accepted extensions: %s", list(ACCEPTED_EXTS))
            return 1
        for p in files:
            work_items.append((angle, p, p.stem))
    else:
        # Multi-angle mode: require canonical stem-named files.
        found = find_local_stems(in_dir)
        found = {a: p for a, p in found.items() if a in angles}
        if not found:
            log.error(
                "No canonical-stem files matching %s in %s. Multi-angle "
                "mode needs files named e.g. front.jpg, back.heic, etc.",
                angles, in_dir,
            )
            present = sorted(p.name for p in in_dir.iterdir() if p.is_file())
            log.info("Files present: %s", present or "(empty)")
            return 1
        for a in angles:
            if a in found:
                work_items.append((a, found[a], a))

    # Validate --pose-override path early so we fail before any uploads.
    pose_override_path: Optional[Path] = None
    if args.pose_override:
        pose_override_path = Path(args.pose_override).expanduser().resolve()
        if not pose_override_path.is_file():
            log.error("--pose-override file not found: %s", pose_override_path)
            return 1
        if pose_override_path.suffix.lower() not in ACCEPTED_EXTS:
            log.error("--pose-override must be one of %s; got %s",
                      list(ACCEPTED_EXTS), pose_override_path.suffix)
            return 1

    # Default the output label to (pose_override_stem | mode), so candidate
    # comparisons + cross-mode comparisons don't overwrite each other.
    label_suffix = (args.label or "").strip()
    if not label_suffix and pose_override_path is not None:
        label_suffix = f"pose-{pose_override_path.stem}"
    if not label_suffix and args.mode == "model-swap":
        label_suffix = "model-swap"

    log.info("=" * 70)
    log.info("Folder:       %s", in_dir)
    log.info("Output:       %s", out_dir)
    log.info("Endpoint:     %s", args.mode)
    log.info("Selection:    %s (%d job%s)",
             "single-angle" if single_angle_mode else "multi-angle",
             len(work_items), "" if len(work_items) == 1 else "s")
    if pose_override_path is not None:
        log.info("Pose source:  LOCAL OVERRIDE -> %s", pose_override_path)
    log.info("Tier:         %s | Brand model: %s | Seed base: %d",
             args.tier, args.brand_model, args.seed)
    if args.prompt:
        log.info("Prompt:       %r", args.prompt)
    if label_suffix:
        log.info("Output label: _%s", label_suffix)
    if single_angle_mode:
        log.info("Angle:        %s (all source files paired with %s pose)",
                 angles[0], angle_to_pose[angles[0]])
    else:
        log.info("Stems found:  %s", ", ".join(a for a, _, _ in work_items))
    log.info("=" * 70)

    drive = get_drive_service()

    # Set up a Drive temp folder for uploads under PROCESSED. We need this
    # before resolving pose URLs because --pose-override uploads its file here.
    processed_root = os.environ.get("DREVI_PROCESSED_FOLDER_ID")
    if not processed_root:
        log.error("DREVI_PROCESSED_FOLDER_ID env var not set.")
        return 1
    test_root = get_or_create_subfolder(drive, processed_root, "_TRYON_TESTING")
    upload_folder = get_or_create_subfolder(drive, test_root, args.folder_name)
    log.info("  Drive uploads: %s", upload_folder)

    # Resolve the pose URLs we'll need (one per distinct angle).
    needed_angles = sorted({a for a, _, _ in work_items})
    pose_urls: Dict[str, str] = {}

    if pose_override_path is not None:
        # Single override: same local file is used for every requested angle.
        log.info("  Pose override: %s (used for all angles)",
                 pose_override_path.name)
        try:
            with tempfile.TemporaryDirectory(prefix="drevi_pose_") as pose_td:
                pose_jpeg = Path(pose_td) / f"pose_override_{pose_override_path.stem}.jpg"
                normalise_to_jpeg(pose_override_path, pose_jpeg)
                pose_upload = upload_file_to_drive(
                    drive, pose_jpeg, upload_folder,
                    name=f"pose_override_{pose_override_path.stem}.jpg",
                    mime_type="image/jpeg",
                )
                ensure_anyone_can_read(drive, pose_upload["id"])
                override_url = make_public_url(pose_upload["id"])
            for a in needed_angles:
                pose_urls[a] = override_url
            log.info("  [override] uploaded as pose_override_%s.jpg",
                     pose_override_path.stem)
        except Exception as e:
            log.error("  pose-override upload failed: %s", e)
            return 1
    else:
        for a in needed_angles:
            try:
                pose_urls[a] = find_pose_url(
                    drive, brand_model, angle_to_pose[a],
                )
                log.info("  [%s] pose:   %s", a, angle_to_pose[a])
            except Exception as e:
                log.error("  [%s] pose lookup failed: %s", a, e)
    log.info("=" * 70)

    # Result row: (label, output_path | None, status, credits)
    results: List[Tuple[str, Optional[Path], str, int]] = []
    with tempfile.TemporaryDirectory(prefix="drevi_test_") as td:
        tmp = Path(td)
        for idx, (angle, src_path, out_stem) in enumerate(work_items):
            label = (
                f"{out_stem}"
                if single_angle_mode and out_stem != angle
                else angle
            )
            if angle not in pose_urls:
                results.append((label, None, "no pose URL resolved", 0))
                continue

            # Resolve per-mode params.
            if args.mode == "tryon-max":
                res, gen_mode = tier_angle_params(args.tier, angle)
                credits = tryon_max_credits(res, gen_mode)
            else:  # model-swap
                res, gen_mode = MODEL_SWAP_TIER.get(
                    args.tier, MODEL_SWAP_TIER["standard"],
                )
                credits = (
                    MODEL_SWAP_CREDITS.get((res, gen_mode), 3)
                    + MODEL_SWAP_FACE_REF_SURCHARGE
                )
            log.info("[%s] %s  ->  pose=%s  %s/%s  (%d cr/img)",
                     label, src_path.name, angle_to_pose[angle],
                     res, gen_mode, credits)

            try:
                # Normalise the source to JPEG and upload to Drive. The Drive
                # filename uses out_stem so multiple source files in
                # single-angle mode don't overwrite each other.
                local_jpeg = tmp / f"{out_stem}.jpg"
                normalise_to_jpeg(src_path, local_jpeg)
                upload = upload_file_to_drive(
                    drive, local_jpeg, upload_folder,
                    name=f"{out_stem}.jpg", mime_type="image/jpeg",
                )
                ensure_anyone_can_read(drive, upload["id"])
                source_url = make_public_url(upload["id"])

                # In single-angle mode, vary the seed by file index too so
                # multiple staff photos don't share the same FASHN noise.
                seed = args.seed + ANGLE_OFFSETS[angle] + (
                    idx if single_angle_mode else 0
                )

                if args.mode == "tryon-max":
                    pid = submit_tryon(
                        api_key,
                        model_image_url=pose_urls[angle],
                        product_image_url=source_url,
                        resolution=res,
                        generation_mode=gen_mode,
                        seed=seed,
                        prompt=args.prompt,
                    )
                else:  # model-swap
                    pid = submit_model_swap(
                        api_key,
                        source_image_url=source_url,
                        face_reference_url=pose_urls[angle],
                        resolution=res,
                        generation_mode=gen_mode,
                        seed=seed,
                        prompt=args.prompt,
                        face_reference_mode="match_base",
                    )
                log.info("  prediction %s, polling...", pid)
                body = poll_until_done(api_key, pid, log)

                output_url = (body.get("output") or [None])[0]
                if not output_url:
                    raise RuntimeError(f"no output URL: {body}")

                r = requests.get(output_url, timeout=120)
                r.raise_for_status()
                # Apply label suffix to output filename.
                out_name = (
                    f"{out_stem}_{label_suffix}.png" if label_suffix
                    else f"{out_stem}.png"
                )
                out_path = out_dir / out_name
                out_path.write_bytes(r.content)
                log.info("  ✓ saved %s (%d KB)",
                         out_path.name, len(r.content) // 1024)
                results.append((label, out_path, "OK", credits))
            except Exception as e:
                log.error("  FAIL: %s", e)
                results.append((label, None, str(e), 0))
            log.info("")

    # Summary
    log.info("=" * 70)
    log.info("SUMMARY")
    log.info("=" * 70)
    total_cr = 0
    ok_count = 0
    label_w = max((len(lbl) for lbl, *_ in results), default=9)
    for label, path, status, credits in results:
        if status == "OK":
            total_cr += credits
            ok_count += 1
            log.info("  %-*s OK    -> %s  (+%d cr)",
                     label_w, label, path.name if path else "?", credits)
        else:
            log.info("  %-*s FAIL  %s", label_w, label, status)
    log.info("Total: %d/%d ok · %d credits used",
             ok_count, len(results), total_cr)
    log.info("Results at: %s", out_dir)

    return 0 if ok_count == len(results) and ok_count > 0 else 2


if __name__ == "__main__":
    sys.exit(main())
