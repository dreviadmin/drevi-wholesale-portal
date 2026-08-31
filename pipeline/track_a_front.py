#!/usr/bin/env python3
"""
track_a_front.py — Track A: ChatGPT background conversion, FRONT image only.
For every INPUT folder that matches a wholesale-sheet row, converts front.*
to the grey-backdrop catalog version and uploads to CHATGPT_TEST/<SKU>/front.png.

Per-SKU stepwise audit trail written to:
  - "Track A Log" tab on the wholesale sheet (live, user-visible)
  - ~/drevi/logs/track_a_records.jsonl (machine-readable)

Steps recorded per SKU: MATCH → FRONT_FOUND → SKIP/DOWNLOAD → OPENAI_EDIT → UPLOAD → DONE
Aborts the whole run after 3 consecutive OpenAI billing failures.
"""
import argparse, io, json, os, sys, time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pillow_heif; pillow_heif.register_heif_opener()

from drevi_common import (
    LOCAL_LOGS, SHEET_ID, get_drive_service, get_master_ws, get_sheets_client,
    get_or_create_subfolder, list_drive_folder, list_drive_subfolders,
    load_master_schema, now_ist_iso, read_master_rows, setup_logger,
)
from chatgpt_batch import (PROMPT, download_bytes, to_png_bytes,
                           upload_bytes, norm)
from image_providers import (OUTPUT_FOLDER_NAME, PROVIDERS, classify_error,
                             edit_image)

OUTPUT_ROOT = '166YqXyW8ogCTtYQKAQdr3mtpieYkWKxj'   # CHATGPT_TEST (openai)
EXTS = ('.png', '.jpg', '.jpeg', '.heic', '.heif', '.webp')
RECORDS = Path.home() / 'drevi/logs/track_a_records.jsonl'


def b4(s):
    p = norm(s).split('-'); return '-'.join(p[:4]) if len(p) >= 4 else norm(s)
def colr(s):
    p = norm(s).split('-'); return p[-1] if len(p) >= 5 else ''


class Recorder:
    """Thread-safe step recorder; flushes rows to the sheet tab."""
    def __init__(self, sh):
        try:
            self.tab = sh.worksheet('Track A Log')
        except Exception:
            self.tab = sh.add_worksheet('Track A Log', rows=4000, cols=6)
            self.tab.update(values=[['Timestamp', 'INPUT Folder', 'Sheet SKU',
                                     'Step', 'Status', 'Detail']],
                            range_name='A1')
        self.buf = []
        self.lock = threading.Lock()

    def rec(self, folder, sku, step, status, detail=''):
        row = [now_ist_iso(), folder, sku, step, status, str(detail)[:400]]
        with self.lock:
            self.buf.append(row)
            with open(RECORDS, 'a') as f:
                f.write(json.dumps({'ts': row[0], 'folder': folder, 'sku': sku,
                                    'step': step, 'status': status,
                                    'detail': str(detail)[:800]}) + '\n')

    def flush(self):
        with self.lock:
            buf, self.buf = self.buf, []
        if buf:
            try:
                self.tab.append_rows(buf, value_input_option='RAW')
            except Exception:
                pass


def main() -> int:
    ap = argparse.ArgumentParser(description='Track A front-image conversion')
    ap.add_argument('--provider', default=os.environ.get('IMAGE_PROVIDER', 'openai'),
                    choices=list(PROVIDERS),
                    help='image-edit backend (default openai/gpt-image-2)')
    ap.add_argument('--skus', default='',
                    help='comma-separated base SKUs to restrict the run to '
                         '(for cheap A/B comparisons)')
    ap.add_argument('--limit', type=int, default=0,
                    help='process at most N matched folders')
    args = ap.parse_args()
    provider = args.provider
    only = {norm(s) for s in args.skus.split(',') if s.strip()}

    log = setup_logger('drevi.track_a', LOCAL_LOGS / 'track_a.log')
    log.info('=' * 70)
    log.info('TRACK A (front-only) | provider=%s | skus=%s limit=%s',
             provider, args.skus or 'ALL', args.limit or 'none')

    drive = get_drive_service()
    sh = get_sheets_client().open_by_key(SHEET_ID)
    ws = get_master_ws(get_sheets_client())
    schema = load_master_schema(ws)
    rows = read_master_rows(ws, schema)
    rc = Recorder(sh)

    # sheet index: exact base+color, plus 1:1 sibling fallback
    by_bc, sheet_by_base = {}, {}
    for r in rows:
        sku = (r.get('drevi_sku') or '').strip()
        if sku:
            k = (b4(sku), colr(sku))
            by_bc.setdefault(k, r)
            sheet_by_base.setdefault(k[0], {})[k[1]] = r

    folders = list_drive_subfolders(drive, os.environ['DREVI_INPUT_FOLDER_ID'])
    fcolors = {}
    for f in folders:
        fcolors.setdefault(b4(f['name']), set()).add(colr(f['name']))

    def match(folder_name):
        k = (b4(folder_name), colr(folder_name))
        if k in by_bc:
            return by_bc[k], 'exact'
        scolors = sheet_by_base.get(k[0], {})
        orph_f = [c for c in fcolors.get(k[0], set()) if c not in scolors]
        orph_s = [c for c in scolors if c not in fcolors.get(k[0], set())]
        if k[1] in orph_f and len(orph_f) == 1 and len(orph_s) == 1:
            return scolors[orph_s[0]], f'sibling {k[1]}->{orph_s[0]}'
        return None, ('ambiguous siblings' if k[1] in orph_f and orph_s
                      else 'no sheet row')

    # Per-provider output root so runs can be compared side by side.
    if provider == 'openai':
        output_root = OUTPUT_ROOT
    else:
        parent = (drive.files().get(fileId=os.environ['DREVI_INPUT_FOLDER_ID'],
                                    fields='parents', supportsAllDrives=True)
                  .execute().get('parents') or [None])[0]
        output_root = get_or_create_subfolder(
            drive, parent or OUTPUT_ROOT, OUTPUT_FOLDER_NAME[provider])
    log.info('output root (%s): %s', OUTPUT_FOLDER_NAME[provider], output_root)

    # output subfolders that already exist (idempotency)
    out_subs = {norm(s['name']): s['id']
                for s in list_drive_subfolders(drive, output_root)}

    WORKERS = int(os.environ.get('TRACK_A_WORKERS', '6'))
    counts = {'ok': 0, 'fail': 0, 'skip': 0, 'nomatch': 0}
    counts_lock = threading.Lock()
    billing = {'streak': 0, 'abort': False}
    subs_lock = threading.Lock()

    # googleapiclient services are NOT thread-safe (httplib2) — sharing one
    # across workers corrupts SSL state (WRONG_VERSION_NUMBER etc.). Each
    # worker thread builds and reuses its own service.
    from drevi_common import get_drive_service as _gds
    _tls = threading.local()

    def tdrive():
        if not hasattr(_tls, 'drive'):
            _tls.drive = _gds()
        return _tls.drive

    def bump(k):
        with counts_lock:
            counts[k] += 1

    def process(f):
        name = f['name']
        if billing['abort']:
            return
        row, how = match(name)
        if not row:
            rc.rec(name, '', 'MATCH', 'FAIL', how)
            bump('nomatch'); return
        sku = (row.get('drevi_sku') or '').strip()
        rc.rec(name, sku, 'MATCH', 'OK', how)

        files = list_drive_folder(tdrive(), f['id'])
        imgs = [x for x in files if x['name'].lower().endswith(EXTS)]
        if not imgs:
            rc.rec(name, sku, 'FRONT_FOUND', 'FAIL', 'folder has no images')
            bump('fail'); return
        # Prefer a file literally named front.*; otherwise ANY image works —
        # the OpenAI edit doesn't care, and the wholesale portal only needs
        # one representative placeholder per SKU. Pick first by name for
        # determinism and record which file was used.
        front = next((x for x in imgs
                      if x['name'].lower().rsplit('.', 1)[0] == 'front'), None)
        if front:
            rc.rec(name, sku, 'FRONT_FOUND', 'OK', front['name'])
        else:
            front = sorted(imgs, key=lambda x: x['name'].lower())[0]
            rc.rec(name, sku, 'FRONT_FOUND', 'OK',
                   f'{front["name"]} (no front.* — first of {len(imgs)} images)')

        with subs_lock:
            sub_id = out_subs.get(norm(sku)) or out_subs.get(norm(name))
        if sub_id:
            existing = {x['name'].lower() for x in list_drive_folder(tdrive(), sub_id)}
            if 'front.png' in existing:
                rc.rec(name, sku, 'SKIP', 'OK', 'front.png already in CHATGPT_TEST')
                bump('skip'); return

        try:
            raw = download_bytes(tdrive(), front['id'])
            png = to_png_bytes(raw)
            rc.rec(name, sku, 'DOWNLOAD', 'OK', f'{len(raw)//1024} KB')
        except Exception as e:
            rc.rec(name, sku, 'DOWNLOAD', 'FAIL', e)
            bump('fail'); return

        t0 = time.time(); out = None; err = None
        for attempt in range(1, 5):
            if billing['abort']:
                return
            try:
                out = edit_image(png, PROMPT, provider)
                err = None; break
            except Exception as e:
                err = str(e)
                kind = classify_error(err)
                if kind == 'BILLING':
                    break
                if kind == 'SAFETY' and attempt >= 2:
                    break
                # 429 rate-limit or transient: back off harder under parallelism
                time.sleep(10 * attempt)
        if out is None:
            kind = classify_error(err or '')
            rc.rec(name, sku, 'EDIT', f'FAIL:{kind}', f'[{provider}] {err}')
            bump('fail')
            if kind == 'BILLING':
                with counts_lock:
                    billing['streak'] += 1
                    if billing['streak'] >= 3:
                        billing['abort'] = True
                        rc.rec('', '', 'RUN', 'ABORT',
                               '3 consecutive billing failures — top up and re-run')
                        log.error('ABORT: billing limit reached')
            return
        with counts_lock:
            billing['streak'] = 0
        rc.rec(name, sku, 'EDIT', 'OK',
               f'[{provider}] {time.time()-t0:.0f}s, {len(out)//1024} KB')

        try:
            if not sub_id:
                with subs_lock:
                    sub_id = out_subs.get(norm(sku))
                    if not sub_id:
                        sub_id = get_or_create_subfolder(tdrive(), output_root, sku)
                        out_subs[norm(sku)] = sub_id
            res = upload_bytes(tdrive(), sub_id, 'front.png', out)
            rc.rec(name, sku, 'UPLOAD', 'OK', res['id'])
            rc.rec(name, sku, 'DONE', 'OK', '')
            bump('ok')
        except Exception as e:
            rc.rec(name, sku, 'UPLOAD', 'FAIL', e)
            bump('fail')

    log.info('parallel workers: %d', WORKERS)
    todo = sorted(folders, key=lambda x: x['name'])
    if only:
        todo = [f for f in todo if b4(f['name']) in only or norm(f['name']) in only]
        log.info('restricted to %d folder(s) by --skus', len(todo))
    if args.limit:
        todo = todo[:args.limit]
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futs = [pool.submit(process, f) for f in todo]
        done_n = 0
        for fut in as_completed(futs):
            fut.result()
            done_n += 1
            if done_n % 5 == 0:
                rc.flush()
                log.info('progress: %d/%d folders | %s', done_n, len(todo), counts)
    rc.flush()
    ok, fail, skip, nomatch = (counts['ok'], counts['fail'],
                               counts['skip'], counts['nomatch'])

    rc.rec('', '', 'RUN', 'SUMMARY',
           f'ok={ok} skip={skip} fail={fail} nomatch={nomatch}')
    rc.flush()
    log.info('DONE | ok=%d skip=%d fail=%d nomatch=%d', ok, skip, fail, nomatch)
    log.info('TRACK_A_DONE')
    return 0


if __name__ == '__main__':
    sys.exit(main())
