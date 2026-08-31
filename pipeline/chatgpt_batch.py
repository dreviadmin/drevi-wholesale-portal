#!/usr/bin/env python3
"""
chatgpt_batch.py — batch background/lighting normalisation via OpenAI Image Edits.
For each SKU folder in the INPUT root, edits every image with the approved catalog
prompt and uploads the results to Drive under CHATGPT_TEST/<SKU>/<name>.png.
"""
import os, io, sys, time, base64, requests
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from drevi_common import (get_drive_service, list_drive_subfolders,
    list_drive_folder, get_or_create_subfolder, setup_logger, LOCAL_LOGS)
from googleapiclient.http import MediaIoBaseDownload, MediaIoBaseUpload
from PIL import Image
import pillow_heif
pillow_heif.register_heif_opener()

OPENAI_KEY = os.environ['OPENAI_API_KEY']
MODEL = 'gpt-image-2'   # newest — user asked for best

PROMPT = """Edit this fashion product photograph for a luxury Indian ethnic-wear catalog. Do NOT alter the garment or the person in any way — only the background and lighting change.

BACKGROUND: Replace the current background with a plain, seamless studio backdrop in a warm light-grey tone (approx. #a8a4a0). No environment, no props, no store fixtures, no visible floor–wall seam — just a clean, uniform seamless backdrop. If the subject is standing full-body, add a subtle, soft-edged natural floor shadow directly under the feet.

LIGHTING: Apply soft, even, diffused studio catalog lighting. Eliminate harsh shadows, hot spots, and colour casts. Keep the garment's true colours — do not shift, over-saturate, or desaturate the outfit's fabric or embellishments.

PRESERVE EXACTLY (critical — this is a garment catalog):
- Every fabric detail, embellishment, embroidery, sequin, bead, mirror-work, print, drape, silhouette, and construction line of the outfit — do not redraw, reinterpret, smooth, blur, or "clean up" any part of the garment.
- The subject (whether a person, mannequin, or dress form): identity, face, pose, body proportions, hands, feet, and how the outfit fits on them — all unchanged.
- Framing and composition — keep the subject centred as in the original; do not crop or reposition.

OUTPUT: Photorealistic, catalog-quality, highest available resolution, sharp fabric detail. No watermarks, text, or signatures."""

SKUS = [
    'DD-SAR-PRD-033-L-GRN', 'DD-SUT-PLZ-021-L-GRY', 'DD-KUR-TUN-021-L-GLD', 'DD-SUT-PLZ-024-L-BLK',
    'DD-SUT-PLZ-024-L-IVR', 'DD-SUT-PLZ-021-L-GRN', 'DD-SUT-PLZ-024-L-ORG', 'DD-SUT-PLZ-028-L-WIN',
    'DD-SAR-PRD-033-L-IVR', 'DD-SUT-PLZ-024-L-BLU', 'DD-SUT-PLZ-023-L-BLK', 'DD-SUT-PLZ-022-XL-BLU',
    'DD-SAR-PRD-034-L-IVR', 'DD-SAR-PRD-021-L-GRN', 'DD-SAR-PRD-034-L-TLG', 'DD-SUT-PLZ-020-L-YLW',
]

def norm(s: str) -> str:
    """Uppercase + strip all whitespace so 'DD-SUT -PLZ-024-L-BLU' matches 'DD-SUT-PLZ-024-L-BLU'."""
    return ''.join((s or '').upper().split())


def download_bytes(drive, fid: str) -> bytes:
    buf = io.BytesIO()
    req = drive.files().get_media(fileId=fid, supportsAllDrives=True)
    dl = MediaIoBaseDownload(buf, req)
    done = False
    while not done:
        _, done = dl.next_chunk()
    return buf.getvalue()


def to_png_bytes(raw: bytes, max_edge: int = 2048) -> bytes:
    img = Image.open(io.BytesIO(raw))
    if img.mode == 'RGBA':
        bg = Image.new('RGB', img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[3])
        img = bg
    elif img.mode != 'RGB':
        img = img.convert('RGB')
    if max(img.size) > max_edge:
        img.thumbnail((max_edge, max_edge))
    out = io.BytesIO()
    img.save(out, format='PNG', optimize=True)
    return out.getvalue()


def openai_edit(image_bytes: bytes, prompt: str, model: str,
                size: str = 'auto', quality: str = 'high') -> bytes:
    files = {'image': ('input.png', image_bytes, 'image/png')}
    data = {'model': model, 'prompt': prompt, 'size': size, 'quality': quality, 'n': 1}
    headers = {'Authorization': f'Bearer {OPENAI_KEY}'}
    r = requests.post('https://api.openai.com/v1/images/edits',
                      files=files, data=data, headers=headers, timeout=300)
    if r.status_code != 200:
        raise RuntimeError(f'OpenAI HTTP {r.status_code}: {r.text[:500]}')
    body = r.json()
    b64 = body['data'][0]['b64_json']
    return base64.b64decode(b64)


def upload_bytes(drive, folder_id: str, name: str, data: bytes,
                 mime: str = 'image/png') -> dict:
    body = {'name': name, 'parents': [folder_id]}
    media = MediaIoBaseUpload(io.BytesIO(data), mimetype=mime, resumable=False)
    return drive.files().create(body=body, media_body=media,
                                fields='id,webViewLink',
                                supportsAllDrives=True).execute()


def main() -> int:
    log = setup_logger('drevi.chatgpt', LOCAL_LOGS / 'chatgpt_batch.log')
    log.info('=' * 70)
    log.info('CHATGPT batch START | model=%s | %d SKUs', MODEL, len(SKUS))
    log.info('=' * 70)

    drive = get_drive_service()
    input_root = os.environ['DREVI_INPUT_FOLDER_ID']

    # CHATGPT_TEST placed as sibling of INPUT
    meta = drive.files().get(fileId=input_root, fields='parents',
                             supportsAllDrives=True).execute()
    parents = meta.get('parents', [])
    output_parent = parents[0] if parents else input_root
    output_root = get_or_create_subfolder(drive, output_parent, 'CHATGPT_TEST')
    log.info('Output folder (Drive id): %s', output_root)

    all_folders = list_drive_subfolders(drive, input_root)
    by_norm = {norm(f['name']): f for f in all_folders}

    total_ok = 0; total_fail = 0
    for i, sku in enumerate(SKUS, 1):
        log.info('')
        log.info('[%d/%d] === %s ===', i, len(SKUS), sku)
        f = by_norm.get(norm(sku))
        if not f:
            log.error('  folder not found under INPUT (normalised match)'); total_fail += 1; continue
        log.info('  matched folder: %r', f['name'])
        try:
            files = list_drive_folder(drive, f['id'])
        except Exception as e:
            log.error('  drive list failed: %s', e); total_fail += 1; continue
        imgs = [x for x in files if x['name'].lower().endswith(('.heic','.heif','.jpg','.jpeg','.png','.webp'))]
        log.info('  found %d image(s)', len(imgs))
        if not imgs:
            log.warning('  no images to process — skip')
            continue

        sku_out = get_or_create_subfolder(drive, output_root, sku)
        log.info('  output subfolder: %s', sku_out)

        # Idempotency — skip images whose output PNG already exists (from a
        # previous partial run). Re-running the batch only costs for the gaps.
        try:
            existing = {x['name'].lower() for x in list_drive_folder(drive, sku_out)}
        except Exception:
            existing = set()

        for j, im in enumerate(imgs, 1):
            n = im['name']
            new_name = os.path.splitext(n)[0] + '.png'
            if new_name.lower() in existing:
                log.info('  [%d/%d] %s — SKIP (output exists)', j, len(imgs), n)
                continue
            log.info('  [%d/%d] %s', j, len(imgs), n)
            t0 = time.time()
            last_err = None
            for attempt in range(1, 4):   # up to 3 attempts per image
                try:
                    raw = download_bytes(drive, im['id'])
                    png_in = to_png_bytes(raw)
                    out_bytes = openai_edit(png_in, PROMPT, MODEL)
                    res = upload_bytes(drive, sku_out, new_name, out_bytes)
                    log.info('     ✓ %s -> %s (%d KB, %.1fs, attempt %d)',
                             new_name, res['id'], len(out_bytes)//1024,
                             time.time()-t0, attempt)
                    total_ok += 1
                    last_err = None
                    break
                except Exception as e:
                    last_err = e
                    msg = str(e)
                    # Safety rejections: retry once (stochastic), then give up.
                    if 'safety' in msg and attempt >= 2:
                        break
                    log.warning('     attempt %d failed (%s) — retrying...',
                                attempt, msg[:120])
                    time.sleep(5 * attempt)
            if last_err is not None:
                log.error('     ✗ %s', last_err)
                total_fail += 1
            time.sleep(1)  # gentle rate-limit

    log.info('')
    log.info('=' * 70)
    log.info('DONE | ok=%d | fail=%d', total_ok, total_fail)
    log.info('CHATGPT_BATCH_DONE')
    log.info('=' * 70)
    return 0


if __name__ == '__main__':
    sys.exit(main())
