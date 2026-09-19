import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { ensureDesignImagery } from "@/lib/design-imagery";
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
 *
 * Bytes only — the design_images row is the caller's to write, so the imagery
 * rule (ensureDesignImagery) runs in the caller once that row exists.
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

/**
 * The name a downloaded copy of `ref` should carry, without its extension:
 * "DD-LEH-FLR-115-GRN-front-production". A stockroom folder of files called
 * image.jpg is useless, and these are the four facts an operator already knows
 * the picture by — design, colour, angle, and which image of that angle it is.
 *
 * Resolved HERE rather than passed in by the page on purpose: the caller knows
 * nothing the database does not, and a client-supplied name is a string that
 * ends up in a response header. Returns null for a ref that is not a design
 * photo (vendor cards, note photos, tracking sheets) so the route can fall
 * back to a generic name.
 */
export async function downloadNameForRef(ref: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("design_images")
    .select("id, role, engine, created_at, design_id, angle_id")
    .eq("file_ref", ref)
    // A ref can be registered more than once (the same file re-used across
    // angles); oldest wins so the saved name is stable between downloads.
    .order("created_at", { ascending: true })
    .limit(1);
  const img = rows?.[0];
  if (!img) return null;

  const angleId: string | null = img.angle_id ?? null;
  const [designRes, angleRes] = await Promise.all([
    admin.from("designs").select("base_sku, color").eq("id", img.design_id).maybeSingle(),
    angleId ? admin.from("design_angles").select("angle, approved_image_id").eq("id", angleId).maybeSingle() : null,
  ]);
  const design = designRes.data;
  if (!design?.base_sku) return null; // nothing distinctive to say — let the caller decide

  // "production" is not a role: it is the one image the angle publishes, so it
  // has to be read off the angle (17 Sep semantics — approved candidate, else
  // the source). Everything else keeps its own role: source / candidate /
  // import / crop / ident.
  const isProduction = Boolean(angleRes?.data && angleRes.data.approved_image_id === img.id);
  const kind = isProduction ? "production" : img.role;

  // Production is the ONE image of its angle, so sku·colour·angle·kind already
  // names it uniquely. Every entry in the "Previous attempts" strip is not:
  // they share all four, so three downloads land as candidate.jpg,
  // candidate (1).jpg, candidate (2).jpg — the "folder of image.jpg" problem
  // one level down. The engine and the moment it ran are what the strip itself
  // labels them by, so they are what tells them apart on disk too.
  const attempt = isProduction || img.role !== "candidate"
    ? null
    : [img.engine, istStamp(img.created_at)].filter(Boolean).join("-");
  return [design.base_sku, design.color, angleRes?.data?.angle, kind, attempt].filter(Boolean).join("-");
}

/** "20250919-143207" in IST — the showroom's clock, matching every other date the studio prints. */
function istStamp(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const digits = d
    .toLocaleString("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    })
    .replace(/\D/g, "");
  return digits.length === 14 ? `${digits.slice(0, 8)}-${digits.slice(8)}` : null;
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
  let added = 0;
  if (fresh.length > 0) {
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
    added = (written ?? []).length;
  }
  // Runs even when nothing was fresh: a design whose photos an earlier sync
  // already registered still needs its identifier and front filling in.
  await ensureDesignImagery(admin, designId);
  return { ok: true, added, folderId };
}
