# Drevi Photography Pipeline

End-to-end automation that turns raw on-tag-SKU photos in Google Drive into AI try-on imagery and brand-voice product copy in the Drevi Product Master sheet.

The pipeline was restructured in April–May 2026 and the May 9 cleanup pass:

- **Color correction was removed** — store lighting (ring + track + window) made white-card sampling unreliable; uncorrected source colour is closer to the garment.
- **Copy generation was absorbed into vision** — the deprecated `03_copy_generator.py` is replaced by Stage 2, which runs Claude Opus 4.7 with vision and produces per-angle FASHN prompts, product copy, tags, dominant hex, and a quality-tier recommendation in **one call** per group.
- **The pipeline is now three stages**: format-only preprocess → vision analysis → FASHN tryon.

## High-level flow

```
                    ┌───────────────────────────────────────────────┐
                    │           Drevi Product Master (Sheet)        │
                    │  Master tab + Brand Model Map +               │
                    │  Tryon Prompt Map + Tag Vocabulary            │
                    └───────────────┬───────────────────────────────┘
                                    │ reads triggers, writes back state
                                    ▼
  Drive INPUT/<SKU>/  ──▶  01_preprocess.py   ──▶  Drive PROCESSED/<SKU>/
   front.heic                (HEIC→JPEG q98,         front.jpg
   back.heic                  4:5 detail crop;       back.jpg
   side.heic                  no colour shift)       side.jpg
   lifestyle.heic                                    lifestyle.jpg
   detail.heic                                       detail.jpg
   detail2.heic                                      detail2.jpg
                                    │
                                    ▼
  Tag Vocabulary    ──▶  02_vision_analyze.py ──▶  Master Sheet
   Spec sheet              (Claude Opus 4.7,        Tryon Prompt - F/B/S/L
                            vision on 6 INPUT       Product Name
                            images per group;       Description, Meta
                            JSON-only output)       Dominant Hex, Tags
                                                    Image Quality Tier
                                    │
                                    ▼
  Brand-model poses ──▶  03_fashn_runner.py   ──▶  Drive TRYON/<SKU>/
   (model-a/poses/,         (FASHN tryon-max         front.png
    model-b/poses/)          per angle, per-SKU      back.png
                             prompts from sheet,     side.png
                             then re-encodes         lifestyle.png
                             detail.* from           detail.jpg  (re-encoded)
                             PROCESSED into TRYON)   detail2.jpg (re-encoded)
```

`04_orchestrator.py` runs the three stages as subprocesses. State flows through the **Master Sheet only** — no on-disk hand-off between stages.

## Repository layout

| File | Role |
|---|---|
| [drevi_common.py](drevi_common.py) | Shared config, Google auth, sheet schema, Drive helpers, SKU + sibling-group utilities, FASHN credit math, vision message builder, status enums. |
| [01_preprocess.py](01_preprocess.py) | Stage 1 — format normalisation. HEIC→JPEG for mannequins, 4:5 centre-crop for details. **No colour correction.** |
| [02_vision_analyze.py](02_vision_analyze.py) | Stage 2 — Claude Opus 4.7 vision: per-angle FASHN prompts + product copy + tags + dominant hex + tier recommendation, all in one JSON. |
| [03_fashn_runner.py](03_fashn_runner.py) | Stage 3 — FASHN tryon-max for the four mannequin angles. Skips angles that already exist in TRYON (idempotent re-runs); pass `--regenerate` to override. Re-encodes `detail.*` from PROCESSED into TRYON as JPEG. |
| [04_orchestrator.py](04_orchestrator.py) | Runs the three stages with shared CLI flags (`--sku`, `--dry-run`, `--max`, `--force`, `--skip-*`, `--regenerate`, `--allow-empty-prompts`). |
| [requirements.txt](requirements.txt) | Python deps (gspread, Google API, Pillow, pillow-heif, requests, anthropic). |
| [.env.example](.env.example) | Template — copy to `.env` and fill in real values. |
| [.gitignore](.gitignore) | Keeps secrets and the venv out of any commit. |

## Sheet schema (the contract)

Workbook ID is `1FbI2SBWqBC6Wy8oTLtModXXvDKHbpIdQPRO32g2ivr0` (`SHEET_ID` in `drevi_common.py`). The Master tab uses a 2-row header:

- Row 1 = section labels (`IDENTITY`, `AUTO FROM SKU`, `AI PIPELINE`, …) — merged cells.
- Row 2 = column names.
- Row 3 onward = data.

Effective headers are joined as `SECTION/COLUMN` and resolved by suffix match in `find_column()`. The logical-key → display-name map is the `COLS` dict.

`SheetSchema` looks up by either logical key (`"processed_url"`) or raw header (`"Processed Folder URL"`). Two method names are exposed for that lookup:

```python
schema.col_letter("processed_url")     # → "AC"
schema.get_col_letter("processed_url") # alias
```

Three sibling tabs are also read:

- **Brand Model Map** — `(cat_code, sub_code) → (brand_model, movement_pose)` with `(cat, *)` and `(*, *)` fallbacks. If everything misses, falls back to env defaults `DREVI_DEFAULT_BRAND_MODEL` / `DREVI_DEFAULT_MOVEMENT_POSE` and **logs a warning** so silent fallbacks are visible.
- **Tryon Prompt Map** — fallback only since Stage 2 began producing per-SKU prompts. Used when a SKU was somehow not seen by vision.
- **Tag Vocabulary** — `axis → [{tag_value, display_label}]` for `occasion`, `color`, `fabric`, `handwork`, `style`, `merch`. Used as a closed vocabulary the LLM is constrained to.

## Sibling groups

Master often has multiple rows for the same design+colour at different sizes (L, XL, XXL). They share photos, AI outputs, and copy. The pipeline operates on `(base_sku, color_code)` groups:

- `group_master_rows_by_base_color()` builds the groups.
- All siblings get the same writeback in one shot, via a single `ws.batch_update` per row.
- `--sku` accepts either full Drevi SKU or Base SKU and matches against any sibling.
- Stage 3 also has a **propagate** mode: when a group already has a Tryon URL on at least one sibling but other siblings are still empty, it skips API calls and copies the existing URL, copy text, tags, and statuses across.

Each row dict carries both `_row` and `_row_index` (same value, two names) so any caller can use either.

## State machine

The pipeline runs on **two columns**, each with a clear owner. The values come from a **named LoV on the `Reference` tab** of the same workbook (column V for Photo Status, column X for Pipeline Status), and the dropdowns on Master are bound to those ranges.

### `Photo Status` — machine-owned. Single source of truth for triggers.

```
   Pending Photos             initial (sheet default)
         │  Arushi uploads + flips
         ▼
   Photos Uploaded            ← Stage 1 trigger
         │  Stage 1 (preprocess)
         ▼
   Preprocessed               ← Stage 2 trigger
         │  Stage 2 (vision)
         ▼
   Vision Done                ← Stage 3 trigger
         │  Stage 3 (FASHN tryon)
         ▼
   Tryon Done                 ← Stage 4 trigger (planned: Shopify draft)
         │  Stage 4 (planned)
         ▼
   Shopify Draft Created

   On stage failure:  Failed - Preprocess  |  Failed - Vision
                      Failed - Tryon       |  Failed - Shopify
```

Each stage **reads only `Photo Status`** to find work and **atomically advances it** in the same `batch_update` as the rest of its row writeback. No more multi-column gating like "status uploaded AND prompt empty AND processed URL set" — the status column is the contract.

| Stage | Trigger value | On success → | On failure → |
|---|---|---|---|
| 1 — preprocess | `Photos Uploaded` | `Preprocessed` | `Failed - Preprocess` |
| 2 — vision | `Preprocessed` | `Vision Done` | `Failed - Vision` |
| 3 — FASHN tryon | `Vision Done` | `Tryon Done` | `Failed - Tryon` |
| 4 — Shopify draft *(planned)* | `Tryon Done` | `Shopify Draft Created` | `Failed - Shopify` |

**Partial success in Stage 3** still counts as `Tryon Done`. The `Tryon Failed Angles` JSON column carries the detail of which specific angles failed, so Grishma can re-run with `--regenerate` if she wants those redone — without blocking the rest of the pipeline.

### `Pipeline Status` — human-owned listing lifecycle.

```
  Awaiting Specs ─▶ Awaiting Photos ─▶ Ready for Review ─▶ Published
                                              │
                                              ├─▶ On Hold
                                              └─▶ Cancelled
```

The pipeline writes this column **exactly once**: Stage 3 sets `Ready for Review` on success (and Stage 3's propagate mode does the same for siblings catching up). Everything else — Awaiting Specs / Awaiting Photos / Published / On Hold / Cancelled — is set by Grishma. On failure, Pipeline Status is **left alone** so it doesn't pretend a broken SKU is reviewable.

### Where the dropdowns live

The validation lists are on the `Reference` tab (`gid=189337531`):

- `Reference!V2:V11` — Photo Status values
- `Reference!X2:X7` — Pipeline Status values

If you add a new value, add it there and to `PHOTO_STATUS` / `PIPELINE_STATUS` in `drevi_common.py`. The constants in code are the canonical mapping; the dropdown is just the UI surface.

## Stage 1 — `01_preprocess.py`

Format normalisation only. Two parallel paths:

| Stem | Action |
|---|---|
| `front`, `back`, `side`, `lifestyle` (mannequin) | JPG → passthrough; HEIC → JPEG q98 (or HEIC passthrough if `DREVI_CONVERT_MANNEQUIN_HEIC=0`). |
| `detail`, `detail2` | Centre-crop to **4:5** (`DETAIL_RATIO`) to match brand-model PNGs (1856×2304 ≈ 4:5 once Uwear's 64-px-aligned rounding is normalised), saved as JPEG q98. HEIC + flag-off = passthrough with no crop (test mode). |

**Trigger** (catalog-wide): **Drive-sweep + status guard** — Stage 1 lists every subfolder in `DREVI_INPUT_FOLDER_ID`, matches each name to a `(base_sku, color_code)` group on Master, and queues the group if its `Photo Status` is `Pending Photos` or `Photos Uploaded`. Folder presence in INPUT counts as "photos uploaded" — no manual dropdown flip required. Unmatched folders (no matching SKU on Master) are logged with a warning. With `--sku`: data-driven, always runs.
**Hard prereq**: front + back stems must be present in INPUT — anything else and the group fails with `Failed - Preprocess` (Stage 2 cannot work without these two angles).
**Advances**: `Photo Status → Preprocessed` on success; `Failed - Preprocess` on any error.

**Per group:**

1. Resolve INPUT folder — prefer `Input Folder URL` from sheet, otherwise auto-discover by name in `DREVI_INPUT_FOLDER_ID` (full sibling SKU → `base+colour` → bare base). Returns the folder ID directly.
2. List files in INPUT, walk every canonical stem (`front, back, side, lifestyle, detail, detail2`).
3. Download to `tempfile.TemporaryDirectory`, run mannequin/detail handler, upload to PROCESSED with anyone-with-link read.
4. Writeback: `Processed Folder URL` to all sibling rows, in a single `batch_update` per row.

`upload_file_to_drive` is called with **keyword args** (`name=…, mime_type=…`) to avoid positional-order mistakes.

**Env flags:**

| Var | Default | Effect |
|---|---|---|
| `DREVI_CONVERT_MANNEQUIN_HEIC` | `1` | `0` = pass HEIC through unchanged (mannequins). |
| `DREVI_CONVERT_DETAIL_HEIC` | `1` | `0` = pass HEIC through, **no crop** (details). |
| `DREVI_JPEG_QUALITY` | `98` | JPEG quality for both mannequin and detail outputs. |

## Stage 2 — `02_vision_analyze.py`

**Trigger** (catalog-wide): `Photo Status == "Preprocessed"`. With `--sku`: data-driven.
**Image source**: PROCESSED folder (the JPGs Stage 1 wrote). Vision sees the same images FASHN will consume, so what Claude analyses is what gets rendered.
**Hard prereq**: `front.*` and `back.*` must exist in PROCESSED. If either is missing, the group fails with `Failed - Vision` and no Claude call is made.
**Backup**: every call (success or failure) is persisted as JSON to `VISION_LOGS/<base-sku>[-<color>]/<UTC-timestamp>[.suffix].json`. The file contains the spec block sent to Claude, the controlled-vocabulary block, the raw response text, the parsed JSON, and the token usage. Folder location is `DREVI_VISION_LOGS_FOLDER_ID` if set, else auto-created as a sibling of PROCESSED.
**Advances**: `Photo Status → Vision Done` on success; `Failed - Vision` on error.

**Per group, in one Anthropic call:**

1. Resolve INPUT folder (same as Stage 1).
2. For each canonical angle (`front, back, side, lifestyle, detail, detail2`), download → PIL → resize to ≤`DREVI_VISION_IMAGE_LONG_EDGE` (default 1568) → JPEG q`DREVI_VISION_IMAGE_QUALITY` (default 88) → base64. Cache key is `<file_id><ext>` so a re-upload (which gives Drive a new file ID) misses cache and re-downloads automatically. Cache lives under `$DREVI_LOCAL_ROOT/vision_input/`, not `/tmp`.
3. Build the spec block from sibling rows (color, fabric, handwork, authenticity, origin, care, sub-category, category, **vendor SKU**, notes).
4. Append the controlled-vocabulary block (occasion / fabric / handwork / color / style / merch) from the Tag Vocabulary tab.
5. Call Claude Opus 4.7 with the system prompt that enforces the Drevi voice contract (3-paragraph 90–130-word description; banned words; no exclamation marks; provenance grounded in spec; tier criteria), retry up to 2× on JSON-parse failure or transient API error.
6. Parse JSON, validate required keys, extract.
7. Writeback to **all sibling rows** in a single `batch_update` per row:
   - `Tryon Prompt - Front/Back/Side/Lifestyle`
   - `Product Name`, `Description`, `Meta Title`, `Meta Description`, `Copy Generated At`
   - `Dominant Color Hex`
   - `AI Suggested Occasions`, `AI Suggested Tags`
   - `Image Quality Tier` (only if currently empty — Rakesh/Grishma's pick wins)
   - `Style` (only if currently empty)

**Cost:** Opus 4.7 at $5/M in + $25/M out, ~$0.15/SKU at 6 images. Full ~155-SKU catalog ≈ $20–25.

**`--max N`** caps the run for cost control. The orchestrator forwards its own `--max` to vision.

**Anti-hallucination guardrails** baked into the system prompt:

- The model is told tryon-max defaults a long draped skirt to wide-leg pants if the prompt doesn't say otherwise — explicit "no pants" instruction is required.
- Provenance: never claim "Banarasi" / "handwoven" / "Real Zari" unless the spec says so. Visual ("shimmer tissue") is fine.
- Banned words: stunning, gorgeous, vibrant, exquisite. No exclamation marks.
- 8-word product-name limit, 60-char meta title, 155-char meta description, 90–130-word body.

The system prompt also defines the **Image Quality Tier** decision tree (standard / hero_lite / hero / bridal) so Grishma has a recommendation to override.

## Stage 3 — `03_fashn_runner.py`

**Trigger** (catalog-wide): `Photo Status == "Vision Done"`. With `--sku`: data-driven (Processed URL must exist; if Stage 2 prompts are missing, pass `--allow-empty-prompts` to override). With `--force`: requires `--sku`.
**Advances**: `Photo Status → Tryon Done` and `Pipeline Status → Ready for Review` on any-angle success; `Failed - Tryon` on full failure (Pipeline Status stays as-is).

**Per group:**

1. **Resolve config**:
   - Brand model + lifestyle movement pose from Brand Model Map. Falls back to env defaults with a logged warning when the map has no entry.
   - Per-angle prompts: prefer the row's `Tryon Prompt - …` columns (Stage 2), fall back to the Tryon Prompt Map by `(cat_code, sub_code)`.
   - **Per-angle params from `TIER_TO_ANGLE_PARAMS`**. Front + back are the primary listing images and get the best config the tier supports; side + lifestyle get a cheaper config. Tier comes from the row's `Image Quality Tier` column (empty = `standard`).

     | Tier | front | back | side | lifestyle | Total credits/SKU |
     |---|---|---|---|---|---|
     | **standard (default)** | 2k quality (4) | 2k quality (4) | 1k quality (3) | 1k quality (3) | **14** |
     | hero_lite | 2k quality (4) | 2k quality (4) | 2k quality (4) | 2k quality (4) | 16 |
     | hero | 4k quality (5) | 4k quality (5) | 2k quality (4) | 2k quality (4) | 18 |
     | bridal | 4k quality (5) | 4k quality (5) | 4k quality (5) | 4k quality (5) | 20 |

2. **Garment-image source**: PROCESSED folder (Stage 1 output). Stage 3 no longer reads from INPUT.
3. **Brand-model poses**: pre-staged in `DREVI_BRAND_MODEL_FOLDER_ID/model-{a,b}/poses/`. Listed once per SKU and cached for the four lookups.
   - `front` → `pose_01_front.png`
   - `back` → `pose_02_back.png`
   - `side` → `pose_03_three_quarter_left.png`
   - `lifestyle` → `<movement_pose>.png` (resolved per category)
4. **Idempotency**: before each FASHN call, check whether `<TRYON>/<sku>/<angle>.{png,jpg,jpeg}` already exists. If yes and `--regenerate` is not set, **skip the angle** (no credits charged). Pass `--regenerate` to force re-rendering.
5. **Per-angle FASHN call** to `https://api.fashn.ai/v1/run`:
   - `model_name=tryon-max`
   - `inputs.model_image` = pose URL, `inputs.product_image` = garment URL
   - `seed = (MD5(base_sku)[:8] + {front:0, back:1, side:2, lifestyle:3}) & 0xFFFFFFFF` — masked to FASHN's documented `[0, 2^32 − 1]`.
   - `resolution`, `generation_mode`, `prompt`, `output_format` (default `png`, override via `DREVI_FASHN_OUTPUT_FORMAT=jpeg`)
   - **Submit retries**: 5xx and connection errors are retried up to `DREVI_FASHN_SUBMIT_RETRIES` (default 2) with 1.5× exponential backoff. 4xx errors fail immediately.
   - Poll `/v1/status/<id>` every 3s up to 180s. On `completed`, download → upload to `DREVI_TRYON_FOLDER_ID/<folder>/<angle>.<ext>` with anyone-with-link read.
   - Failures collected per-angle; `Tryon Failed Angles` is the JSON list.
6. **Detail finalise**: download `detail.*` and `detail2.*` from PROCESSED, **re-encode any non-JPEG to JPEG q98**, upload to TRYON. Guarantees a uniformly JPG/PNG gallery even when `CONVERT_DETAIL_HEIC=0` was used during preprocess.
7. **Writeback** to all siblings in a single `batch_update` per row: `Brand Model`, `Movement Pose`, `Image Seed Base`, four `Tryon Prompt - …` (resolved), `Output Folder URL`, `Tryon Credit Cost`, `Tryon Failed Angles`, `Photo Status → AI Done` (or `Failed` if every angle failed), and `Pipeline Status → Ready for Review` on success.

Seeds are deterministic: re-running the same SKU produces the same outputs (pre-prompt-edit).

**`--regenerate`** forces a fresh render for every angle (overrides the idempotency skip).
**`--allow-empty-prompts`** lets FASHN run even when Stage 2 hasn't produced prompts (not recommended).

## Stage 4 — `04_orchestrator.py`

```
python 04_orchestrator.py                        # full run, catalog-wide
python 04_orchestrator.py --sku DD-LEH-FLR-007
python 04_orchestrator.py --skip-vision          # no Anthropic spend
python 04_orchestrator.py --skip-fashn           # no FASHN credits
python 04_orchestrator.py --max 3                # cap vision + FASHN to 3 SKUs
python 04_orchestrator.py --dry-run              # plan only
python 04_orchestrator.py --sku DD-… --force     # bypass state checks
python 04_orchestrator.py --sku DD-… --regenerate  # re-render existing TRYON
python 04_orchestrator.py --stop-on-failure
```

By default a stage failure is logged and the orchestrator continues; `--stop-on-failure` aborts. `--force` requires `--sku`. `--max N` is forwarded to **vision and FASHN** (both cost real money). `--regenerate` and `--allow-empty-prompts` are forwarded to FASHN only.

## Environment variables

Set per session via `source .env` (template in `.env.example`):

| Var | Used by | Purpose |
|---|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | All | Path to service-account JSON. |
| `DREVI_INPUT_FOLDER_ID` | 1, 2 | Drive folder containing per-SKU upload subfolders. |
| `DREVI_PROCESSED_FOLDER_ID` | 1, 3 | Drive folder where preprocess outputs live. |
| `DREVI_TRYON_FOLDER_ID` | 3 | Drive folder where FASHN outputs are written. |
| `DREVI_BRAND_MODEL_FOLDER_ID` | 3 | Folder containing `model-a/poses/` and `model-b/poses/`. |
| `DREVI_VISION_LOGS_FOLDER_ID` | 2 (optional) | Where Stage 2 writes Claude-call backups. If unset, auto-created as a sibling of PROCESSED. |
| `FASHN_API_KEY` | 3 | FASHN bearer token. |
| `ANTHROPIC_API_KEY` | 2 | Claude API key. |
| `DREVI_CONVERT_MANNEQUIN_HEIC` | 1 | `0` = HEIC passthrough (mannequins). |
| `DREVI_CONVERT_DETAIL_HEIC` | 1 | `0` = HEIC passthrough + no crop (details). |
| `DREVI_JPEG_QUALITY` | 1 | JPEG quality for preprocess outputs (default `98`). |
| `DREVI_VISION_IMAGE_LONG_EDGE` | 2 | Resize cap for vision images (default `1568`). |
| `DREVI_VISION_IMAGE_QUALITY` | 2 | JPEG quality for the base64 sent to Claude (default `88`). |
| `DREVI_FASHN_OUTPUT_FORMAT` | 3 | `png` or `jpeg`. Default `png`. |
| `DREVI_FASHN_SUBMIT_RETRIES` | 3 | Retries on FASHN `/run` 5xx (default `2`). |
| `DREVI_DEFAULT_BRAND_MODEL` | 3 | Fallback when Brand Model Map misses (default `A`). |
| `DREVI_DEFAULT_MOVEMENT_POSE` | 3 | Fallback when Brand Model Map misses (default `pose_06_turning`). |
| `DREVI_LOCAL_ROOT` | All (optional) | Override for local working dir; default `~/drevi`. |

## CLI cheatsheet

```sh
# Smoke test — verify creds + sheet access
python drevi_common.py

# Full pipeline on one SKU
python 04_orchestrator.py --sku DD-LEH-FLR-007

# Catalog-wide, but cap spend on vision + FASHN
python 04_orchestrator.py --max 5

# Reprocess one SKU end-to-end ignoring state
python 04_orchestrator.py --sku DD-LEH-FLR-007 --force

# Re-render FASHN only (after Grishma edits a prompt on the sheet)
python 04_orchestrator.py --sku DD-… --skip-preprocess --skip-vision --regenerate

# Stage by stage
python 01_preprocess.py     --sku DD-LEH-FLR-007
python 02_vision_analyze.py --sku DD-LEH-FLR-007 --dry-run
python 03_fashn_runner.py   --sku DD-LEH-FLR-007 --max 1
```

---

# What was fixed in the May 9 cleanup

Every issue from the prior critical review has been addressed. Summary, with the original issue numbers in parentheses for traceability:

## A. Pipeline-blocking bugs — all resolved

1. **`update_cells` signature (A.1)** — replaced with a single helper that accepts both `(ws, row, dict)` and `(ws, [(a1, value), ...])` shapes. Internally uses `ws.batch_update` so each row writeback is one network round-trip with no per-cell read.
2. **`SheetSchema.get_col_letter` AttributeError (A.2)** — `col_letter` now accepts either a logical key or a raw display header; `get_col_letter` is exposed as an alias for callers that used the old name.
3. **`_row_index` vs `_row` (A.3)** — `read_master_rows` now writes both keys; either is safe.
4. **`resolve_input_folder` arg order (A.4)** — function accepts both legacy positional shapes *and* keyword args; all current call sites use kwargs. It also returns the folder ID directly (not the dict), matching every caller.
5. **Stage 3 `siblings` NameError (A.5)** — `process_one_sku`'s parameter is now named `siblings` to match the four references inside it.
6. **Stage 1 `upload_file_to_drive` argument swap (A.6)** — every call site rewritten to `upload_file_to_drive(drive, local_path, output_folder_id, name=…, mime_type=…)`.

## B. State-machine and logic gaps — resolved

7. **`Pipeline Status` advances to `Ready for Review`** when Stage 3 succeeds (per your decision: copy + images go visible together). Propagate mode also writes it.
8. **Vendor field** — `vendor_sku` is now used in the vision spec block (per your decision); the spurious `vendor_name` reference is gone.
9. **Stage 3 gates on Stage 2** — `Tryon Prompt - Front` non-empty is required by default; pass `--allow-empty-prompts` to override.
10. **Detail finalise format** — Stage 3 now downloads `detail.*` from PROCESSED and re-encodes any HEIC to JPEG before uploading to TRYON. The gallery is uniform regardless of whether `DREVI_CONVERT_DETAIL_HEIC=0` was used during preprocess.

## C. Constant collisions and dead code — resolved

11. **`JPEG_QUALITY` deduped** — single definition, env-tunable via `DREVI_JPEG_QUALITY` (default 98).
12. **`ASPECT_RATIO_DETAIL` renamed** to `DETAIL_RATIO` (the tuple-typed live one); the dead float was deleted.
13. **Dead WB infrastructure deleted** — `WHITE_CARD_*`, `SKIP_WB`, `enforce_aspect_ratio`, `read_image`, `save_image`, `cv2`/`numpy` imports, and the `wb_correction` COLS entry are all gone.
14. **Dead `TIER_TO_FASHN_MODE` and tryon-v1.6 path deleted** — Stage 3 no longer carries the `mode` parameter through.
15. **Stale doc strings + duplicate log line in Stage 3** — fixed; file header now reflects Stage 3 + the new flow.

## D. Cost / performance — resolved

16. **`update_cells` does one round-trip per row** via `ws.batch_update` (was N reads + 1 write).
17. **Stage 3 caches the pose folder listing** once per SKU; the four angle lookups all reuse it.
18. **Stage 2 has `--max`** for cost control. Orchestrator forwards `--max` to both vision and FASHN.
19. **Stage 2 cache key uses Drive file ID** — re-uploads always re-download.

## E. Resilience — resolved

20. **FASHN seed masked to 32 bits** — `seed_for_sku` and `angle_seed` both `& 0xFFFFFFFF`. No more silent overflow risk on edge-case MD5 prefixes.
21. **`ensure_anyone_can_read` no longer swallows everything** — duplicate/already-public errors are filtered, real failures (auth, 4xx, 5xx) propagate so the per-angle log shows the upstream cause instead of an opaque "submit failed".
22. **FASHN `/run` submits retry on 5xx / network errors** — 1.5× exponential backoff, `DREVI_FASHN_SUBMIT_RETRIES` (default 2). 4xx errors still fail immediately.
23. **FASHN re-runs are idempotent** — Stage 3 skips angles whose output already exists in TRYON; `--regenerate` forces a re-render. (Per your decision.)
24. **Secrets scaffolded** — `.gitignore` ignores `.env`, `*-sa.json`, `__pycache__`, `.venv`, `.DS_Store`. `.env.example` is a sanitised template. **You still need to rotate the FASHN and Anthropic keys that were checked in to the previous `.env`** and rotate the service-account key in `drevi-pipeline-sa.json`.

## F. New parameterisation knobs

Everything below is now env-driven so Drevi can experiment without a code change:

| Env var | Default | Where it lives |
|---|---|---|
| `DREVI_JPEG_QUALITY` | 98 | Stage 1 output quality |
| `DREVI_VISION_IMAGE_LONG_EDGE` | 1568 | Vision input image cap |
| `DREVI_VISION_IMAGE_QUALITY` | 88 | JPEG quality for vision base64 |
| `DREVI_FASHN_OUTPUT_FORMAT` | `png` | `png` or `jpeg` |
| `DREVI_FASHN_SUBMIT_RETRIES` | 2 | Retries on FASHN /run |
| `DREVI_DEFAULT_BRAND_MODEL` | `A` | Brand Model Map miss fallback |
| `DREVI_DEFAULT_MOVEMENT_POSE` | `pose_06_turning` | Lifestyle pose fallback |

## G. Outstanding follow-ups (not done — by design)

- **`PHOTO_STATUS = "AI Processing"` is unused** today. Left in place because the Master tab's data-validation list almost certainly still has it, and removing the constant without coordinating the sheet's dropdown could break edit-time validation. Either (a) restore use (Stage 1 sets it on entry, Stage 3 clears it), or (b) drop the value from the sheet's validation list, then drop it from the constant. Pick one — for now status flows directly `Photos Uploaded → AI Done`.
- **Move the Stage 2 system prompt to a sidecar file** (e.g. `prompts/vision_system.txt`) so Shaila can edit voice rules without touching Python. Easy to do but skipped to keep this pass surgical.
- **Per-SKU prompt-edit protection on `--force`** — right now Stage 2 with `--force --sku X` will overwrite Grishma's manual edits. A `--no-overwrite-prompts` flag would be a five-line addition.
- **A `Pipeline Config` sheet tab** for runtime tunables (vision retries, FASHN tier matrix, etc.) so non-developers can adjust without an env var. Larger lift; recommend doing it once the rest of the pipeline has been used in production for a few weeks.
