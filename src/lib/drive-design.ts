import "server-only";

import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { google, type drive_v3 } from "googleapis";
import { driveDesignFolderId } from "@/lib/env";

// The shared client in lib/drive.ts is drive.readonly (photo serving). Folder
// creation and uploads need write scope, so this module holds its own client.
let writeClient: drive_v3.Drive | null = null;
async function getDriveClient(): Promise<drive_v3.Drive> {
  if (writeClient) return writeClient;
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "").trim();
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  const sa = JSON.parse(raw.startsWith("{") ? raw : readFileSync(raw, "utf8")) as { client_email: string; private_key: string };
  const auth = new google.auth.JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/drive"] });
  await auth.authorize();
  writeClient = google.drive({ version: "v3", auth });
  return writeClient;
}

// Retrofit R2 (§4) — one Drive folder per design group.
//
// The parent is DRIVE_DESIGN_FOLDER_ID and ships EMPTY (ANSH-19: Ansh is
// consolidating each SKU's photos by hand first). While it is empty:
//   · ensureDesignFolder() returns null and NO folder is ever created
//   · every upload path is disabled with a clear message (uploadsEnabled())
//   · everything else — receipts, minting, supply, specs, copy, publishing of
//     already-known images — keeps working
// There is deliberately NO fallback to the legacy INPUT folder: a silent
// fallback would scatter new files into the very folders being consolidated.

export interface FolderMatch {
  folderId: string | null;
  rule: "exact" | "base" | "variant" | "created" | "none" | "ambiguous";
  candidates?: { id: string; name: string }[];
}

export function uploadsEnabled(): boolean {
  return driveDesignFolderId().length > 0;
}

export const UPLOADS_DISABLED_MESSAGE = "Drive photo folder not configured yet.";

let warned = false;
export function warnIfUnconfigured(): void {
  if (!uploadsEnabled() && !warned) {
    warned = true;
    console.warn("[drive-design] DRIVE_DESIGN_FOLDER_ID is empty — image uploads are disabled (ANSH-19).");
  }
}

export function groupFolderName(baseSku: string, color: string): string {
  return `${baseSku.trim().toUpperCase()}-${color.trim().toUpperCase()}`;
}

const q = (s: string) => s.replace(/'/g, "\\'");
const normKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

async function listChildFolders(drive: drive_v3.Drive, parent: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${q(parent)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "nextPageToken, files(id, name)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) if (f.id && f.name) out.push({ id: f.id, name: f.name });
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

// §4.3 — resolve exact group name → base-SKU folder → single variant folder of
// that group. Ambiguity is NEVER guessed: it is reported and skipped.
export function matchFolder(
  folders: { id: string; name: string }[],
  baseSku: string,
  color: string,
): FolderMatch {
  const base = baseSku.trim().toUpperCase();
  const group = normKey(groupFolderName(baseSku, color));
  const exact = folders.filter((f) => normKey(f.name) === group);
  if (exact.length === 1) return { folderId: exact[0].id, rule: "exact" };
  if (exact.length > 1) return { folderId: null, rule: "ambiguous", candidates: exact };

  const baseOnly = folders.filter((f) => normKey(f.name) === normKey(base));
  if (baseOnly.length === 1) return { folderId: baseOnly[0].id, rule: "base" };
  if (baseOnly.length > 1) return { folderId: null, rule: "ambiguous", candidates: baseOnly };

  // Any variant folder of this design group, e.g. DD-LEH-MRM-007-M-TLG
  const variants = folders.filter((f) => {
    const n = f.name.trim().toUpperCase();
    return n.startsWith(`${base}-`) && n.endsWith(`-${color.trim().toUpperCase()}`);
  });
  if (variants.length === 1) return { folderId: variants[0].id, rule: "variant" };
  if (variants.length > 1) return { folderId: null, rule: "ambiguous", candidates: variants };

  return { folderId: null, rule: "none" };
}

export async function listDesignParentFolders(): Promise<{ id: string; name: string }[]> {
  const parent = driveDesignFolderId();
  if (!parent) return [];
  const drive = await getDriveClient();
  return listChildFolders(drive, parent);
}

/**
 * Image files sitting directly in a design's folder (the _archive subfolder is
 * a separate child folder, so its contents never appear here). Used to pull
 * photos Ansh drops into wholesale_photos by hand into the picker pool.
 */
export async function listFolderImages(folderId: string): Promise<{ id: string; name: string; mimeType: string }[]> {
  const drive = await getDriveClient();
  const out: { id: string; name: string; mimeType: string }[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${q(folderId)}' in parents and mimeType contains 'image/' and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) if (f.id && f.name) out.push({ id: f.id, name: f.name, mimeType: f.mimeType ?? "image/jpeg" });
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/**
 * Resolve (and only when necessary, create) the folder for a design group.
 * Returns null when DRIVE_DESIGN_FOLDER_ID is empty or the match is ambiguous —
 * callers must treat null as "uploads unavailable", never as "make one up".
 */
export async function ensureDesignFolder(
  baseSku: string,
  color: string,
  opts: { create?: boolean; cachedFolders?: { id: string; name: string }[] } = {},
): Promise<FolderMatch> {
  const parent = driveDesignFolderId();
  if (!parent) {
    warnIfUnconfigured();
    return { folderId: null, rule: "none" };
  }
  const drive = await getDriveClient();
  const folders = opts.cachedFolders ?? (await listChildFolders(drive, parent));
  const match = matchFolder(folders, baseSku, color);
  if (match.folderId || match.rule === "ambiguous") return match;
  if (opts.create === false) return match;

  const created = await drive.files.create({
    requestBody: {
      name: groupFolderName(baseSku, color),
      mimeType: "application/vnd.google-apps.folder",
      parents: [parent],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  return { folderId: created.data.id ?? null, rule: "created" };
}

// §4.2 naming: <angle>__<src|import|engine>__<NN>[__cropN].<ext>, lowercase.
// Never overwrite: NN increments per (angle, kind) from what's already there.
export async function nextFileName(
  folderId: string,
  angle: string,
  kind: string,
  ext = "jpg",
  cropOf?: string,
): Promise<string> {
  const drive = await getDriveClient();
  const prefix = `${angle.toLowerCase()}__${kind.toLowerCase()}__`;
  const res = await drive.files.list({
    q: `'${q(folderId)}' in parents and trashed = false and name contains '${q(prefix)}'`,
    fields: "files(name)",
    pageSize: 1000,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  let max = 0;
  for (const f of res.data.files ?? []) {
    const m = (f.name ?? "").match(new RegExp(`^${prefix}(\\d+)`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const nn = String(max + 1).padStart(2, "0");
  return cropOf ? `${prefix}${nn}__${cropOf}.${ext}` : `${prefix}${nn}.${ext}`;
}

// Upload bytes into a design folder. `fixedName` is used for ident.jpg, whose
// previous version is archived rather than overwritten (§4.2).
export async function uploadDesignImage(
  folderId: string,
  bytes: Buffer,
  contentType: string,
  name: string,
  opts: { archivePrevious?: boolean } = {},
): Promise<{ fileId: string; fileName: string }> {
  const drive = await getDriveClient();
  if (opts.archivePrevious) {
    const existing = await drive.files.list({
      q: `'${q(folderId)}' in parents and name = '${q(name)}' and trashed = false`,
      fields: "files(id, name)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const prev = existing.data.files?.[0];
    if (prev?.id) {
      const archive = await ensureArchiveFolder(folderId);
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
      await drive.files.update({
        fileId: prev.id,
        addParents: archive,
        removeParents: folderId,
        requestBody: { name: `ident__prev${stamp}.jpg` },
        fields: "id",
        supportsAllDrives: true,
      });
    }
  }
  const created = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType: contentType, body: Readable.from(bytes) },
    fields: "id, name",
    supportsAllDrives: true,
  });
  return { fileId: created.data.id!, fileName: created.data.name ?? name };
}

export async function ensureArchiveFolder(designFolderId: string): Promise<string> {
  const drive = await getDriveClient();
  const found = await drive.files.list({
    q: `'${q(designFolderId)}' in parents and name = '_archive' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (found.data.files?.[0]?.id) return found.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name: "_archive", mimeType: "application/vnd.google-apps.folder", parents: [designFolderId] },
    fields: "id",
    supportsAllDrives: true,
  });
  return created.data.id!;
}

// §4.5 — the app NEVER deletes from Drive. Demotion/rejection archives.
export async function archiveFile(fileId: string, designFolderId: string): Promise<void> {
  const drive = await getDriveClient();
  const archive = await ensureArchiveFolder(designFolderId);
  await drive.files.update({
    fileId,
    addParents: archive,
    removeParents: designFolderId,
    fields: "id",
    supportsAllDrives: true,
  });
}

export async function fileParents(fileId: string): Promise<{ name: string; parents: string[] }> {
  const drive = await getDriveClient();
  const res = await drive.files.get({ fileId, fields: "name, parents", supportsAllDrives: true });
  return { name: res.data.name ?? "", parents: (res.data.parents as string[] | undefined) ?? [] };
}

export async function folderName(folderId: string): Promise<string> {
  const drive = await getDriveClient();
  try {
    const res = await drive.files.get({ fileId: folderId, fields: "name", supportsAllDrives: true });
    return res.data.name ?? folderId;
  } catch {
    return folderId;
  }
}

export type { drive_v3 };
export { google };
