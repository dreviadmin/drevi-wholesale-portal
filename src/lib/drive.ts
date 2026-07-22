import "server-only";

import { readFileSync } from "node:fs";
import { google, type drive_v3 } from "googleapis";

// Photo lookup for the tag-and-price prep flow. The team keeps one Drive folder
// per outfit (named by the full tag SKU) inside a parent folder. Scanning a QR
// resolves the SKU → that folder → its first image, which the /api/drive-photo
// route then streams (service-account authed) so staff can identify the outfit
// and stick its QR on.
//
// Setup (one-time): enable the Drive API on the drevi-pipeline GCP project,
// share the parent folder with the service-account email (Viewer), and set
// DRIVE_PHOTOS_FOLDER_ID to the parent folder id. Until then this returns null
// and the feature is simply off.

function loadServiceAccount(): { client_email: string; private_key: string } {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "").trim();
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  const json = raw.startsWith("{") ? raw : readFileSync(raw, "utf8");
  const parsed = JSON.parse(json) as { client_email?: string; private_key?: string };
  if (!parsed.client_email || !parsed.private_key) throw new Error("service account missing client_email / private_key");
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

let driveClient: drive_v3.Drive | null = null;
async function getDrive(): Promise<drive_v3.Drive> {
  if (driveClient) return driveClient;
  driveAuth = new google.auth.JWT({
    email: loadServiceAccount().client_email,
    key: loadServiceAccount().private_key,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  await driveAuth.authorize();
  driveClient = google.drive({ version: "v3", auth: driveAuth });
  return driveClient;
}
let driveAuth: InstanceType<typeof google.auth.JWT> | null = null;

export function drivePhotosEnabled(): boolean {
  return !!process.env.DRIVE_PHOTOS_FOLDER_ID;
}

// Base (design) SKU = DD-CAT-SUB-NNN. Tolerates every naming style seen in
// the Drive folders: full variant (…-NNN-L-CRM), colour-only tryon/input
// folders (…-NNN-CRM), or a bare base (…-NNN).
function baseSku(sku: string): string {
  const parts = sku.split("-");
  if (parts.length >= 4 && /^\d{2,4}$/.test(parts[3])) return parts.slice(0, 4).join("-");
  return parts.length >= 5 ? parts.slice(0, -2).join("-") : sku;
}

// The colour-only form a variant maps to in the tryon/input folders:
// DD-LEH-FLR-011-XL-SKY → DD-LEH-FLR-011-SKY (base + last segment).
function baseColourSku(sku: string): string | null {
  const parts = sku.split("-");
  if (parts.length >= 6 && /^\d{2,4}$/.test(parts[3])) {
    return [...parts.slice(0, 4), parts[parts.length - 1]].join("-");
  }
  return null;
}

const IMG = "(mimeType contains 'image/')";
const q = (s: string) => s.replace(/'/g, "\\'");

async function firstImageIn(drive: drive_v3.Drive, folderId: string): Promise<string | null> {
  const res = await drive.files.list({
    q: `'${q(folderId)}' in parents and ${IMG} and trashed = false`,
    fields: "files(id, name)",
    orderBy: "name",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id ?? null;
}

// Normalize a SKU/folder name for matching: uppercase, strip everything that
// isn't a letter or digit. Absorbs case drift ("Xl" vs "XL"), stray spaces,
// and hyphen/underscore differences between the sheet and folder names.
function normKey(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// One listing of the whole photos folder, cached briefly. Matching in code is
// both more robust than per-name Drive queries (those are case-sensitive) and
// far cheaper during a sync that checks dozens of SKUs.
// - byKey:  normalized FULL folder name → id
// - byBase: normalized BASE (design) SKU → id of a folder for that design.
//           Lets a variant borrow a sibling-colour folder's photo (the design
//           was shot once; only one colour's folder often exists).
interface FolderIndex { byKey: Map<string, string>; byBase: Map<string, string> }
// Cached per parent folder — the photo chain spans multiple Drive folders
// (photos → tryon → per-SKU input folders from the sheet).
const folderCaches = new Map<string, { at: number; idx: FolderIndex }>();
const FOLDER_CACHE_MS = 5 * 60 * 1000;

// Secondary source: the try-on shoot folder (same per-SKU layout, folder
// names usually omit the size segment).
export const tryonFolderId = () => process.env.DRIVE_TRYON_FOLDER_ID ?? "1wu1kvRjqWaTYs6YAtG_o2Pm7n3IjPjrs";
// Tertiary source: the pipeline's INPUT root (Arushi's per-SKU upload folders;
// same id the pipeline uses as DREVI_INPUT_FOLDER_ID — the sheet's "Input
// Folder URL" column was retired in favour of name-based discovery here).
export const inputRootFolderId = () => process.env.DRIVE_INPUT_FOLDER_ID ?? "1QFASF3YmicOYyjLv6wIHr4N2Ixz__Pk9";

async function listSkuFolders(parent: string): Promise<FolderIndex> {
  if (!parent) return { byKey: new Map(), byBase: new Map() };
  const cached = folderCaches.get(parent);
  if (cached && Date.now() - cached.at < FOLDER_CACHE_MS) return cached.idx;
  const drive = await getDrive();
  const byKey = new Map<string, string>();
  const byBase = new Map<string, string>();
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${q(parent)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "nextPageToken, files(id, name)",
      orderBy: "name", // deterministic → the same sibling colour wins every run
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) {
      if (!f.id || !f.name) continue;
      byKey.set(normKey(f.name), f.id);
      const bk = normKey(baseSku(f.name.trim().toUpperCase()));
      if (!byBase.has(bk)) byBase.set(bk, f.id); // first folder per design wins (name-sorted)
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  const idx = { byKey, byBase };
  folderCaches.set(parent, { at: Date.now(), idx });
  return idx;
}

// Resolve a SKU to an image file id within ONE parent folder. Tries, in order:
// exact-SKU folder → base-SKU-named folder → any sibling-colour folder of the
// same design → a file in the parent named like the SKU.
async function findSkuImageIn(parent: string, rawSku: string): Promise<{ fileId: string } | null> {
  if (!parent) return null;
  const sku = rawSku.trim().toUpperCase();
  if (!sku) return null;
  const drive = await getDrive();
  const { byKey, byBase } = await listSkuFolders(parent);

  const bc = baseColourSku(sku);
  const candidates = [
    byKey.get(normKey(sku)),                       // exact full-SKU folder
    bc ? byKey.get(normKey(bc)) : undefined,       // colour-only folder (tryon/input naming)
    byKey.get(normKey(baseSku(sku))),              // base-named folder
    byBase.get(normKey(baseSku(sku))),             // any sibling colour of the design
  ];
  for (const folderId of candidates) {
    if (!folderId) continue;
    const img = await firstImageIn(drive, folderId);
    if (img) return { fileId: img };
  }

  // Fallback: images stored as files named like the SKU (not in a subfolder).
  const byFile = await drive.files.list({
    q: `'${q(parent)}' in parents and ${IMG} and name contains '${q(sku)}' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const f = byFile.data.files?.[0]?.id;
  return f ? { fileId: f } : null;
}

// The full photo chain (business rule, 22 Jul 2026):
//   1. photos folder (DRIVE_PHOTOS_FOLDER_ID — tag/shoot photos)
//   2. try-on folder (DRIVE_TRYON_FOLDER_ID)
//   3. the pipeline INPUT root (DRIVE_INPUT_FOLDER_ID — raw upload folders)
// All three use the same per-SKU-subfolder lookup with size-tolerant matching.
export async function findSkuImage(rawSku: string): Promise<{ fileId: string } | null> {
  for (const parent of [process.env.DRIVE_PHOTOS_FOLDER_ID, tryonFolderId(), inputRootFolderId()]) {
    if (!parent) continue;
    try {
      const hit = await findSkuImageIn(parent, rawSku);
      if (hit) return hit;
    } catch { /* folder unreachable — keep falling through */ }
  }
  return null;
}

// Sync helper: resolve a SKU straight to image bytes (thumbnail-sized), for
// copying Drive photos into the public product-photos bucket.
export async function fetchSkuImageBytes(sku: string, size = 800): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const hit = await findSkuImage(sku);
  if (!hit) return null;
  return fetchDriveImage(hit.fileId, size);
}

// Stream an image (used by the proxy route). When `size` is given, serve
// Drive's resized thumbnail instead of the full file — the front.png originals
// are ~1.7 MB, far too heavy to load per scan on exhibition wifi; an s500
// thumbnail is ~150 KB. Falls back to the full file if no thumbnail exists.
export async function fetchDriveImage(fileId: string, size?: number): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const drive = await getDrive();
  try {
    const meta = await drive.files.get({ fileId, fields: "mimeType, thumbnailLink", supportsAllDrives: true });
    const thumb = meta.data.thumbnailLink as string | undefined;
    if (size && thumb && driveAuth) {
      const url = thumb.replace(/=s\d+$/, `=s${size}`);
      const token = (await driveAuth.getAccessToken()).token;
      const r = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (r.ok) return { body: await r.arrayBuffer(), contentType: r.headers.get("content-type") || "image/jpeg" };
    }
    const res = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" },
    );
    return { body: res.data as ArrayBuffer, contentType: (meta.data.mimeType as string) || "image/jpeg" };
  } catch {
    return null;
  }
}
