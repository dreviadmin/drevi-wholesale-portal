# Retrofit baseline (R0)

Generated 2026-07-28T14:41:01.390Z · project `qvnvxcdyvcsgxulbcmzm`

## Migrations

- Files on disk: 21, max `0021_notify_me.sql`

## Tables & row counts

| Table | Present | Rows |
|---|---|---|
| `sku_registry` | yes | 362 |
| `vendors` | yes | 0 |
| `goods_receipts` | yes | 0 |
| `goods_receipt_lines` | yes | 0 |
| `designs` | yes | 188 |
| `design_angles` | yes | 1116 |
| `image_candidates` | yes | 124 |
| `design_images` | **NO** | — |
| `design_copy` | yes | 1 |
| `publish_targets` | yes | 376 |
| `pipeline_jobs` | yes | 2 |
| `product_images` | yes | 2 |
| `devices` | **NO** | — |
| `wholesale_products` | yes | 200 |
| `orders` | yes | 23 |
| `buyers` | yes | 22 |
| `notify_me` | yes | 0 |
| `stock_movements` | **NO** | — |

## Detail

- `design_angles` by angle: `{"closeup":186,"detail_1":186,"detail_2":186,"back":186,"side":186,"front":186}`
- `image_candidates` by status: `{"approved":112,"generated":12}`
- `publish_targets` by portal: `{"wholesale":188,"shopify":188}`
- `publish_targets` by state: `{"not_ready":375,"live":1}`
- `designs` specs_verified: `{"false":188}`
- `designs` tier: `{"standard":188}`
- `wholesale_products` with stock > 0: **1**
- `design_angles` with a legacy `source_ref`: **258**
- `design_angles` with an approved image: **112**

## Assumption checks

| Assumption | Observed |
|---|---|
| A1 · Stage 8 cutover complete | SHEET_SYNC_ENABLED=(unset → sync ON) |
| A2 · images status/source_ref shape | image_candidates.status present=true, design_angles.source_ref present=true |
| A3 · angle set | ["closeup","detail_1","detail_2","back","side","front"] |
| A4 · receipts do not write products | receipt save writes only receipt tables (verified by code read) |
| A5 · buyer storefront reads product_images | product_images rows=2 |

## Flags

| Flag | Value |
|---|---|
| `SHEET_SYNC_ENABLED` | *(unset)* |
| `SKU_DUAL_MODE` | *(unset)* |
| `SHOPIFY_ENABLED` | *(unset)* |
| `OPENAI_BG_ENABLED` | *(unset)* |
| `RECEIPT_INTAKE_V2` | *(unset)* |
| `DRIVE_DESIGN_FOLDER_ID` | *(unset)* |
| `DRIVE_PHOTOS_FOLDER_ID` | set |

## Legacy Drive

- designs linked to a legacy INPUT folder: **125**
- linked to TRYON: **4** · to PHOTOS/processed: **113**
- `image_candidates` rows (all hold Drive file ids that stay valid across folder moves): **124**

