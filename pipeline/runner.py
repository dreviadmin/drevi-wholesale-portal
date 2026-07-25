#!/usr/bin/env python3
"""Drevi App pipeline runner (build guide §8.2).

    python3 -m pipeline.runner --job <uuid> [--state supabase]

Claims the pipeline_jobs row, executes by type, streams JobReporter updates,
finalises done|error. A crash or kill mid-run always finalises to 'error' —
never a stuck 'running' row.

Implemented types (Stage 4):
  scan_drive — walk the PHOTOS / TRYON / INPUT Drive folders for one design
               (or params.all=true for the whole board), fill the designs'
               drive folder ids + angle source_refs, and register historic
               candidates so the board reflects pre-app work truthfully.

Parked types (documented in docs/DECISIONS.md):
  tryon / openai_bg / copy / vision / preprocess — land with Stages 5–6
  alongside the workbench/copy contracts (and ANSH-04/06 keys). Dispatching
  one today finalises to error with a clear message rather than pretending.
"""

from __future__ import annotations

import argparse
import os
import re
import socket
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from drevi_common import JobReporter, SupabaseRest, get_drive_service  # noqa: E402

# Same defaults as src/lib/drive.ts — env overrides win.
PHOTOS_FOLDER = os.environ.get("DRIVE_PHOTOS_FOLDER_ID", "166YqXyW8ogCTtYQKAQdr3mtpieYkWKxj")
TRYON_FOLDER = os.environ.get("DRIVE_TRYON_FOLDER_ID", "1wu1kvRjqWaTYs6YAtG_o2Pm7n3IjPjrs")
INPUT_ROOT = os.environ.get("DRIVE_INPUT_FOLDER_ID", "1QFASF3YmicOYyjLv6wIHr4N2Ixz__Pk9")

ANGLES = ["front", "back", "side", "closeup", "detail_1", "detail_2"]


def parse_base_color(name: str):
    parts = name.strip().upper().replace("_", "-").split("-")
    if len(parts) >= 4 and parts[0] == "DD" and re.fullmatch(r"\d{2,4}", parts[3]):
        return "-".join(parts[:4]), parts[-1]
    return None


def angle_for_filename(name: str) -> str | None:
    low = name.lower()
    for a, pat in (("front", "front"), ("back", "back"), ("side", "side"), ("closeup", "close")):
        if pat in low:
            return a
    return None


def list_child_folders(drive, parent: str):
    out, token = [], None
    while True:
        res = drive.files().list(
            q=f"'{parent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
            fields="nextPageToken, files(id,name)", pageSize=1000, pageToken=token,
            supportsAllDrives=True, includeItemsFromAllDrives=True,
        ).execute()
        out += res.get("files", [])
        token = res.get("nextPageToken")
        if not token:
            return out


def list_images(drive, folder: str):
    out, token = [], None
    while True:
        res = drive.files().list(
            q=f"'{folder}' in parents and mimeType contains 'image/' and trashed=false",
            fields="nextPageToken, files(id,name)", pageSize=1000, pageToken=token, orderBy="name",
            supportsAllDrives=True, includeItemsFromAllDrives=True,
        ).execute()
        out += res.get("files", [])
        token = res.get("nextPageToken")
        if not token:
            return out


def run_scan_drive(job: dict, rep: JobReporter, rest: SupabaseRest):
    drive = get_drive_service()
    scan_all = bool((job.get("params") or {}).get("all"))
    if scan_all:
        designs = rest.select("designs", "select=id,base_sku,color&limit=2000")
    else:
        if not job.get("design_id"):
            raise RuntimeError("scan_drive needs design_id or params.all=true")
        designs = rest.select("designs", f"id=eq.{job['design_id']}&select=id,base_sku,color")
    rep.log(f"scan_drive over {len(designs)} design(s)")

    # One folder index per Drive parent: (base|color) → folder id.
    folder_map: dict[str, dict[str, str]] = {}
    for label, parent in (("photos", PHOTOS_FOLDER), ("tryon", TRYON_FOLDER), ("input", INPUT_ROOT)):
        idx: dict[str, str] = {}
        for f in list_child_folders(drive, parent):
            key = parse_base_color(f["name"])
            if key:
                idx.setdefault(f"{key[0]}|{key[1]}", f["id"])
        folder_map[label] = idx
        rep.log(f"{label}: {len(idx)} per-design folders indexed")

    angles_rows = rest.select("design_angles", "select=id,design_id,angle,source_ref,approved_candidate_id&limit=5000")
    angles_by_design: dict[str, dict[str, dict]] = {}
    for a in angles_rows:
        angles_by_design.setdefault(a["design_id"], {})[a["angle"]] = a
    existing_cands = rest.select("image_candidates", "select=angle_id,file_ref&limit=10000")
    have_cand = {(c["angle_id"], c["file_ref"]) for c in existing_cands}

    filled_sources = new_candidates = approved = 0
    for i, d in enumerate(designs):
        key = f"{d['base_sku']}|{d['color']}"
        patch = {}
        if folder_map["input"].get(key):
            patch["drive_input_id"] = folder_map["input"][key]
        if folder_map["tryon"].get(key):
            patch["drive_tryon_id"] = folder_map["tryon"][key]
        if folder_map["photos"].get(key):
            patch["drive_processed_id"] = folder_map["photos"][key]
        if patch:
            rest.update("designs", f"id=eq.{d['id']}", patch)
        d_angles = angles_by_design.get(d["id"], {})

        # Sources from the INPUT folder (mannequin shots).
        if patch.get("drive_input_id"):
            imgs = list_images(drive, patch["drive_input_id"])
            unnamed = [f for f in imgs if not angle_for_filename(f["name"])]
            for f in imgs:
                angle = angle_for_filename(f["name"])
                if angle and d_angles.get(angle) and not d_angles[angle]["source_ref"]:
                    rest.update("design_angles", f"id=eq.{d_angles[angle]['id']}", {"source_ref": f["id"]})
                    d_angles[angle]["source_ref"] = f["id"]
                    filled_sources += 1
            # No angle-named files at all → first image becomes the front source.
            if unnamed and len(unnamed) == len(imgs) and d_angles.get("front") and not d_angles["front"]["source_ref"]:
                rest.update("design_angles", f"id=eq.{d_angles['front']['id']}", {"source_ref": imgs[0]["id"]})
                d_angles["front"]["source_ref"] = imgs[0]["id"]
                filled_sources += 1

        # Historic FASHN outputs → generated candidates.
        if patch.get("drive_tryon_id"):
            for f in list_images(drive, patch["drive_tryon_id"]):
                angle = angle_for_filename(f["name"]) or "front"
                row = d_angles.get(angle)
                if not row or (row["id"], f["id"]) in have_cand:
                    continue
                rest.insert("image_candidates", [{
                    "angle_id": row["id"], "engine": "fashn", "file_ref": f["id"],
                    "status": "generated", "created_by": "scan_drive",
                }])
                have_cand.add((row["id"], f["id"]))
                new_candidates += 1

        # The PHOTOS folder shot is what's publicly live → approved front.
        if patch.get("drive_processed_id"):
            row = d_angles.get("front")
            if row and not row["approved_candidate_id"]:
                imgs = list_images(drive, patch["drive_processed_id"])
                pick = next((f for f in imgs if "front" in f["name"].lower()), imgs[0] if imgs else None)
                if pick and (row["id"], pick["id"]) not in have_cand:
                    cand = rest.insert("image_candidates", [{
                        "angle_id": row["id"], "engine": "raw", "file_ref": pick["id"],
                        "status": "approved", "created_by": "scan_drive",
                    }])
                    rest.update("design_angles", f"id=eq.{row['id']}", {"approved_candidate_id": cand[0]["id"]})
                    row["approved_candidate_id"] = cand[0]["id"]
                    have_cand.add((row["id"], pick["id"]))
                    approved += 1

        if (i + 1) % 10 == 0 or i == len(designs) - 1:
            rep.progress(int((i + 1) / len(designs) * 100), f"{i + 1}/{len(designs)} designs")

    rep.log(f"sources filled: {filled_sources} · candidates registered: {new_candidates} · fronts approved: {approved}")


HANDLERS = {"scan_drive": run_scan_drive}
PARKED = {
    "tryon": "FASHN per-angle runs land with Stage 5 (workbench contract) — parked with ANSH-04.",
    "openai_bg": "Background engine lands with Stage 5 — parked (ANSH-06).",
    "copy": "Copy generation lands with Stage 6.",
    "vision": "Vision runs land with Stage 5.",
    "preprocess": "Preprocess runs land with Stage 5.",
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--state", default="supabase", choices=["sheet", "supabase"])
    args = ap.parse_args()
    os.environ["DREVI_STATE_BACKEND"] = args.state

    rest = SupabaseRest()
    rep = JobReporter(args.job, runner_id=f"{socket.gethostname()}:{os.getpid()}", rest=rest)
    try:
        job = rep.claim()
    except Exception as e:  # noqa: BLE001
        print(f"claim failed: {e}", file=sys.stderr)
        return 1
    try:
        handler = HANDLERS.get(job["type"])
        if not handler:
            raise RuntimeError(PARKED.get(job["type"], f"unknown job type {job['type']}"))
        handler(job, rep, rest)
        rep.done()
        return 0
    except KeyboardInterrupt:
        rep.error("runner interrupted")
        return 130
    except Exception as e:  # noqa: BLE001 — the row must NEVER stay 'running'
        rep.error(str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())
