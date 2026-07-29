import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchDriveImage } from "@/lib/drive";
import {
  uploadsEnabled as driveConfigured,
  ensureDesignFolder,
  nextFileName,
  uploadDesignImage,
  archiveFile,
} from "@/lib/drive-design";

// UX sprint (29 Jul) — ONE front door for storing and serving design photos.
//
// Backend picked per upload, invisible to callers:
//   · Drive configured (ANSH-19 done)  → the per-design Drive folder, as spec'd
//   · Drive not configured             → the portal's own `design-images`
//     bucket, file_ref = "sb:<path>" so the two ref kinds never collide
//     (Drive ids never contain ':').
//
// This replaces "uploads disabled until ANSH-19": capture works today, and the
// moment the Drive folder id is set, NEW uploads go to Drive while existing
// sb: refs keep serving forever. Still no fallback to the legacy INPUT folder.

export const SB_PREFIX = "sb:";
const BUCKET = "design-images";

export const isStorageRef = (ref: string) => ref.startsWith(SB_PREFIX);

/** Capture is always available now — only the destination varies. */
export function captureEnabled(): boolean {
  return true;
}

export function captureDestinationNote(): string {
  return driveConfigured()
    ? ""
    : "Photos save to portal storage until the Drive folder is configured (ANSH-19).";
}

function extFor(contentType: string): string {
  return contentType.includes("png") ? "png" : "jpg";
}

/** Next free NN for `<angle>__<kind>__NN.<ext>` within a storage folder. */
async function nextStorageName(designId: string, angle: string, kind: string, ext: string): Promise<string> {
  const admin = createAdminClient();
  const { data } = await admin.storage.from(BUCKET).list(designId, { limit: 1000 });
  const stem = `${angle}__${kind}__`;
  let max = 0;
  for (const f of data ?? []) {
    const m = f.name.match(new RegExp(`^${stem}(\\d+)\\.`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${stem}${String(max + 1).padStart(2, "0")}.${ext}`;
}

export interface StoredImage {
  fileRef: string; // Drive file id, or "sb:<bucket path>"
  fileName: string;
}

/**
 * Store one design photo. `kind` follows the Drive naming convention
 * (src / import / crop / ident).
 */
export async function storeDesignImage(args: {
  designId: string;
  baseSku: string;
  color: string;
  angle: string; // angle name, or "design" for design-level images like ident
  kind: string;
  bytes: Buffer;
  contentType: string;
  /** Drive folder id when the caller already resolved it (skips a lookup). */
  driveFolderId?: string | null;
}): Promise<StoredImage & { driveFolderId?: string }> {
  const ext = extFor(args.contentType);

  if (driveConfigured()) {
    let folderId = args.driveFolderId ?? null;
    if (!folderId) {
      const match = await ensureDesignFolder(args.baseSku, args.color);
      if (!match.folderId) {
        throw new Error(
          match.rule === "ambiguous"
            ? "Several Drive folders match this design — resolve the folder audit first."
            : "Could not create the design's Drive folder.",
        );
      }
      folderId = match.folderId;
    }
    const name = await nextFileName(folderId, args.angle, args.kind, ext);
    const up = await uploadDesignImage(folderId, args.bytes, args.contentType, name);
    return { fileRef: up.fileId, fileName: up.fileName, driveFolderId: folderId };
  }

  const admin = createAdminClient();
  const name = await nextStorageName(args.designId, args.angle, args.kind, ext);
  const path = `${args.designId}/${name}`;
  const { error } = await admin.storage.from(BUCKET).upload(path, args.bytes, {
    contentType: args.contentType,
    upsert: false,
  });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  return { fileRef: `${SB_PREFIX}${path}`, fileName: name };
}

/**
 * Archive a superseded photo (§7.5): Drive files move to the folder's
 * _archive/; storage files move under <designId>/_archive/. Never deletes.
 */
export async function archiveImageFile(fileRef: string, driveFolderId?: string | null): Promise<void> {
  if (isStorageRef(fileRef)) {
    const path = fileRef.slice(SB_PREFIX.length);
    const parts = path.split("/");
    if (parts.length < 2 || parts[1] === "_archive") return;
    const admin = createAdminClient();
    const dest = `${parts[0]}/_archive/${parts.slice(1).join("/")}`;
    const { error } = await admin.storage.from(BUCKET).move(path, dest);
    if (error && !/not found/i.test(error.message)) {
      throw new Error(`Storage archive failed: ${error.message}`);
    }
    return;
  }
  if (driveFolderId) await archiveFile(fileRef, driveFolderId);
}

/** After an archive move, the ref changes for storage files. */
export function archivedRef(fileRef: string): string {
  if (!isStorageRef(fileRef)) return fileRef;
  const path = fileRef.slice(SB_PREFIX.length);
  const parts = path.split("/");
  if (parts.length < 2 || parts[1] === "_archive") return fileRef;
  return `${SB_PREFIX}${parts[0]}/_archive/${parts.slice(1).join("/")}`;
}

/**
 * Serve any image ref for /api/drive-photo. `bucket` widens it to the other
 * portal buckets (vendor-photos, order-attachments) via "sb:<bucket>:<path>"
 * — plain "sb:<path>" stays design-images for back-compat.
 */
export async function fetchImageByRef(
  ref: string,
  size?: number,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  if (!isStorageRef(ref)) return fetchDriveImage(ref, size);

  const rest = ref.slice(SB_PREFIX.length);
  const known = ["design-images", "vendor-photos", "order-attachments"];
  let bucket = BUCKET;
  let path = rest;
  const head = rest.split(":", 1)[0];
  if (known.includes(head)) {
    bucket = head;
    path = rest.slice(head.length + 1);
  }
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(bucket).download(path);
  if (error || !data) return null;
  const body = await data.arrayBuffer();
  const ext = path.split(".").pop()?.toLowerCase();
  const contentType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return { body, contentType };
}

/** Store an arbitrary photo in one of the auxiliary buckets. Returns "sb:<bucket>:<path>". */
export async function storeAuxPhoto(args: {
  bucket: "vendor-photos" | "order-attachments";
  path: string; // caller-chosen, e.g. "<vendorId>/card.jpg"
  bytes: Buffer;
  contentType: string;
}): Promise<string> {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(args.bucket).upload(args.path, args.bytes, {
    contentType: args.contentType,
    upsert: true,
  });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  return `${SB_PREFIX}${args.bucket}:${args.path}`;
}
