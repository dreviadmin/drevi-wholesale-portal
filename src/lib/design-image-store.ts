import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchDriveImage } from "@/lib/drive";
import {
  uploadsEnabled as driveConfigured,
  ensureDesignFolder,
  listFolderImages,
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
  // Some Androids hand the file input HEIC/WebP; the engines and OpenAI can't
  // decode those, so normalise anything exotic to JPEG at the door.
  let bytes = args.bytes;
  let contentType = args.contentType;
  if (!/png|jpe?g/.test(contentType)) {
    try {
      const sharp = (await import("sharp")).default;
      bytes = await sharp(bytes).jpeg({ quality: 92 }).toBuffer();
      contentType = "image/jpeg";
    } catch { /* unknown format sharp can't read — store as-is */ }
  }
  const ext = extFor(contentType);

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
    const up = await uploadDesignImage(folderId, bytes, contentType, name);
    return { fileRef: up.fileId, fileName: up.fileName, driveFolderId: folderId };
  }

  const admin = createAdminClient();
  const name = await nextStorageName(args.designId, args.angle, args.kind, ext);
  const path = `${args.designId}/${name}`;
  const { error } = await admin.storage.from(BUCKET).upload(path, bytes, {
    contentType,
    upsert: false,
  });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  return { fileRef: `${SB_PREFIX}${path}`, fileName: name };
}

/**
 * Archive a superseded photo (§7.5): Drive files move to the folder's
 * _archive/; storage files move under <designId>/_archive/ with a timestamp
 * suffix so a re-used active name never collides with an earlier archive.
 * Never deletes. Returns the ref the file lives at AFTER the call — callers
 * update the DB row with this value only once the move has succeeded, so a
 * failed move can never leave a row pointing at a path that does not exist.
 */
export async function archiveImageFile(fileRef: string, driveFolderId?: string | null): Promise<string> {
  if (isStorageRef(fileRef)) {
    const path = fileRef.slice(SB_PREFIX.length);
    const parts = path.split("/");
    if (parts.length < 2 || parts[1] === "_archive") return fileRef;
    const name = parts.slice(1).join("/");
    const dot = name.lastIndexOf(".");
    const stamped = dot > 0 ? `${name.slice(0, dot)}-${Date.now()}${name.slice(dot)}` : `${name}-${Date.now()}`;
    const dest = `${parts[0]}/_archive/${stamped}`;
    const admin = createAdminClient();
    const { error } = await admin.storage.from(BUCKET).move(path, dest);
    if (error) {
      if (/not found/i.test(error.message)) return fileRef; // object already gone — row state is authoritative
      throw new Error(`Storage archive failed: ${error.message}`);
    }
    return `${SB_PREFIX}${dest}`;
  }
  if (driveFolderId) await archiveFile(fileRef, driveFolderId);
  return fileRef; // Drive archiving moves between folders; the file id is stable
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
  const known = ["design-images", "vendor-photos", "order-attachments", "note-photos"];
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
  bucket: "vendor-photos" | "order-attachments" | "note-photos";
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

/**
 * Ansh (4 Aug): photos dropped straight into a design's wholesale_photos
 * folder never became picker options — the pool reads design_images, and only
 * uploads made THROUGH the portal wrote rows. This walks the design's Drive
 * folder and registers every image the DB doesn't know yet (role 'source',
 * angle-less), so the picker shows what Drive actually holds.
 */
export async function ingestDriveFolder(
  designId: string,
  opts: { cachedFolders?: { id: string; name: string }[] } = {},
): Promise<{ ok: boolean; error?: string; added: number; folderId?: string }> {
  const admin = createAdminClient();
  const { data: design } = await admin
    .from("designs")
    .select("id, base_sku, color, drive_folder_id")
    .eq("id", designId)
    .maybeSingle();
  if (!design) return { ok: false, error: "Design not found", added: 0 };

  let folderId = design.drive_folder_id as string | null;
  if (!folderId) {
    const match = await ensureDesignFolder(design.base_sku, design.color, { create: false, cachedFolders: opts.cachedFolders });
    folderId = match.folderId;
    if (!folderId) {
      return { ok: false, added: 0, error: match.rule === "ambiguous" ? "More than one Drive folder matches this design — tidy the folder names first" : "No Drive folder found for this design yet" };
    }
    await admin.from("designs").update({ drive_folder_id: folderId }).eq("id", designId);
  }

  const files = await listFolderImages(folderId);
  const { data: existing } = await admin.from("design_images").select("file_ref").eq("design_id", designId);
  const known = new Set((existing ?? []).map((r) => r.file_ref));
  const fresh = files.filter((f) => !known.has(f.id));
  if (fresh.length === 0) return { ok: true, added: 0, folderId };
  // Upsert-ignore + the 0040 unique index make this safe against a concurrent
  // portal upload or a second sync; select() returns only the rows actually
  // written, so `added` never overcounts.
  const { data: written, error } = await admin
    .from("design_images")
    .upsert(
      fresh.map((f) => ({
        design_id: designId,
        role: "source",
        file_ref: f.id,
        file_name: f.name,
        status: "active",
        created_by: "drive-sync",
      })),
      { onConflict: "design_id,file_ref", ignoreDuplicates: true },
    )
    .select("id");
  if (error) return { ok: false, added: 0, error: error.message, folderId };
  return { ok: true, added: (written ?? []).length, folderId };
}
