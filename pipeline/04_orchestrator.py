#!/usr/bin/env python3
"""
04_orchestrator.py
====================
Drevi Photography Pipeline · End-to-end orchestrator.

Runs the three pipeline stages in sequence:
  1. 01_preprocess.py       → format normalisation + 4:5 detail crop
                              (reads INPUT, writes PROCESSED)
  2. 02_vision_analyze.py   → Claude Opus 4.7 vision: per-SKU FASHN prompts
                              + product copy + tags + tier recommendation
                              (reads INPUT, writes Master Sheet)
  3. 03_fashn_runner.py     → FASHN tryon-max for the 4 mannequin angles
                              + finalise step copies details from PROCESSED
                              into the SKU output folder
                              (reads PROCESSED + sheet prompts,
                               writes TRYON, advances Photo Status -> AI Done)

Stage 03_copy_generator.py is DEPRECATED — its work was absorbed into Stage
2 (vision) which generates copy from images directly.

Usage:
  python 04_orchestrator.py                 # full run on all eligible SKUs
  python 04_orchestrator.py --skip-fashn    # everything except FASHN credits
  python 04_orchestrator.py --skip-vision   # skip Claude (no LLM cost)
  python 04_orchestrator.py --max 3         # cap vision + FASHN stages to 3 SKUs
  python 04_orchestrator.py --dry-run       # report only, no writes
  python 04_orchestrator.py --sku DD-IWS-DHT-006-L-IVR --force
  python 04_orchestrator.py --sku DD-… --regenerate    # re-render FASHN angles

Each stage is invoked as a subprocess so failures isolate cleanly. State
flows through the Master Sheet — each stage reads its own trigger from the
sheet, no hand-off via files.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

from drevi_common import LOCAL_LOGS, now_ist_iso, setup_logger


SCRIPTS_DIR = Path(__file__).resolve().parent

STAGES = [
    ("preprocess", "01_preprocess.py",     "Format normalisation + 4:5 detail crop"),
    ("vision",     "02_vision_analyze.py", "Claude vision: prompts + copy + tags"),
    ("fashn",      "03_fashn_runner.py",   "FASHN tryon-max + detail finalise"),
]


def run_stage(
    name: str,
    script: str,
    log,
    extra_args: list[str],
) -> int:
    """Run a stage as a subprocess. Returns exit code."""
    cmd = [sys.executable, str(SCRIPTS_DIR / script)] + extra_args
    log.info("=" * 60)
    log.info("STAGE: %s · %s", name.upper(), script)
    log.info("CMD:   %s", " ".join(cmd))
    log.info("=" * 60)
    proc = subprocess.run(cmd, env=os.environ.copy())
    log.info("STAGE %s exit code: %d", name.upper(), proc.returncode)
    return proc.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description="Drevi pipeline orchestrator")
    parser.add_argument("--sku", help="Limit all stages to a single SKU/Base SKU")
    parser.add_argument("--force", action="store_true",
                        help="Bypass state checks. Pass to all stages. Requires --sku.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Pass --dry-run to all stages")
    parser.add_argument("--max", type=int, default=0,
                        help="Cap vision + FASHN stages to N SKUs (cost control). "
                             "Stage 1 ignores --max — preprocess is cheap.")
    parser.add_argument("--regenerate", action="store_true",
                        help="Forwarded to FASHN: re-render angles whose "
                             "output already exists in TRYON. Default skips them.")
    parser.add_argument("--allow-empty-prompts", action="store_true",
                        help="Forwarded to FASHN: run even if Stage 2 vision "
                             "hasn't filled Tryon Prompt - Front.")
    parser.add_argument("--skip-preprocess", action="store_true")
    parser.add_argument("--skip-vision", action="store_true",
                        help="Skip Claude vision stage (no LLM cost)")
    parser.add_argument("--skip-fashn", action="store_true")
    parser.add_argument("--stop-on-failure", action="store_true",
                        help="Stop pipeline if any stage exits non-zero")
    args = parser.parse_args()

    if args.force and not args.sku:
        print("ERROR: --force requires --sku to be specified.", file=sys.stderr)
        return 1

    log = setup_logger(
        "drevi.orchestrator",
        LOCAL_LOGS / f"orchestrator_{now_ist_iso().replace(':', '').replace(' ', '_')}.log"
    )

    log.info("")
    log.info("########################################")
    log.info("# Drevi Pipeline Orchestrator")
    log.info("# Started: %s", now_ist_iso())
    log.info("# Dry run: %s · SKU filter: %s · Max FASHN: %s · Force: %s",
             args.dry_run, args.sku or "(none)", args.max or "no limit", args.force)
    log.info("########################################")

    common_args = []
    if args.dry_run:
        common_args.append("--dry-run")
    if args.sku:
        common_args.extend(["--sku", args.sku])
    if args.force:
        common_args.append("--force")

    skip_map = {
        "preprocess": args.skip_preprocess,
        "vision":     args.skip_vision,
        "fashn":      args.skip_fashn,
    }

    overall_rc = 0
    for stage_name, script, description in STAGES:
        if skip_map[stage_name]:
            log.info("--- SKIPPING: %s (%s)", stage_name, description)
            continue
        stage_args = list(common_args)
        # --max applies to vision + FASHN (both cost real money).
        if stage_name in ("vision", "fashn") and args.max > 0:
            stage_args.extend(["--max", str(args.max)])
        if stage_name == "fashn":
            if args.regenerate:
                stage_args.append("--regenerate")
            if args.allow_empty_prompts:
                stage_args.append("--allow-empty-prompts")

        rc = run_stage(stage_name, script, log, stage_args)
        if rc != 0:
            overall_rc = rc
            if args.stop_on_failure:
                log.error("STAGE %s failed (rc=%d) · stopping due to --stop-on-failure",
                          stage_name, rc)
                break
            log.warning("STAGE %s failed (rc=%d) · continuing", stage_name, rc)

    log.info("")
    log.info("########################################")
    log.info("# Pipeline finished · exit %d", overall_rc)
    log.info("# Ended: %s", now_ist_iso())
    log.info("########################################")
    return overall_rc


if __name__ == "__main__":
    sys.exit(main())
