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

// Base (design) SKU = drop the last two segments (size, colour), mirroring the
// portal's variant grouping. e.g. DD-SUT-PLZ-008-L-CRM → DD-SUT-PLZ-008.
function baseSku(sku: string): string {
  const parts = sku.split("-");
  return parts.length >= 5 ? parts.slice(0, -2).join("-") : sku;
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

async function folderIdByName(drive: drive_v3.Drive, parent: string, name: string): Promise<string | null> {
  const res = await drive.files.list({
    q: `'${q(parent)}' in parents and name = '${q(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id ?? null;
}

// Resolve a scanned SKU to a Drive image file id (or null). Tries, in order:
// exact-SKU folder → base-SKU folder → a file directly named like the SKU.
export async function findSkuImage(rawSku: string): Promise<{ fileId: string } | null> {
  const parent = process.env.DRIVE_PHOTOS_FOLDER_ID;
  if (!parent) return null;
  const sku = rawSku.trim().toUpperCase();
  if (!sku) return null;
  const drive = await getDrive();

  for (const name of [sku, baseSku(sku)]) {
    const folderId = await folderIdByName(drive, parent, name);
    if (folderId) {
      const img = await firstImageIn(drive, folderId);
      if (img) return { fileId: img };
    }
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
