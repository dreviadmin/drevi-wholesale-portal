import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { listDesignParentFolders, listFolderImages, ensureDesignFolder, uploadsEnabled } from "@/lib/drive-design";
import { ingestDriveFolder } from "@/lib/design-image-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Does Drive hold photos we never ingested? (Ansh, 19 Sep)
//
// The imagery report counts design_images rows — the DATABASE's record of Drive
// files — so a folder full of photos that was never ingested reads as "no image
// anywhere". That is a report that lies in the one direction that matters: it
// sends someone out to re-shoot a garment already photographed.
//
// This answers the question against Drive itself. Read-only by default: it
// reports what each design's folder holds and how much of it is unknown to the
// database. POST {"ingest": true} registers the unknown files (ingestDriveFolder,
// the same call the Workbench's Sync Drive button makes) — it never uploads,
// deletes, or creates a folder, because a design with no folder has nothing to
// find and creating one would only manufacture an empty answer.
//
// It must run server-side: the Drive service account lives in the deployment,
// not on anyone's laptop.
export async function POST(req: Request) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }
  if (!uploadsEnabled()) {
    return NextResponse.json({ error: "Drive photo folder not configured in this environment" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { ingest?: boolean; onlyEmpty?: boolean; limit?: number };
  const ingest = body.ingest === true;
  // Default to the designs the report calls imageless — they are the whole
  // question. onlyEmpty:false widens it to every design.
  const onlyEmpty = body.onlyEmpty !== false;
  const limit = Math.max(1, Math.min(body.limit ?? 400, 400));

  const admin = createAdminClient();
  const designs = await fetchAll<{ id: string; base_sku: string; color: string; drive_folder_id: string | null }>(
    admin,
    "designs",
    "id, base_sku, color, drive_folder_id",
    (q) => q.order("base_sku"),
  );
  const images = await fetchAll<{ design_id: string; file_ref: string }>(
    admin,
    "design_images",
    "design_id, file_ref",
    (q) => q.eq("status", "active"),
  );
  const knownByDesign = new Map<string, Set<string>>();
  for (const i of images) {
    if (!knownByDesign.has(i.design_id)) knownByDesign.set(i.design_id, new Set());
    knownByDesign.get(i.design_id)!.add(i.file_ref);
  }

  // One Drive listing for the whole parent, reused for every design — otherwise
  // this is one round trip per design and cannot finish inside the timeout.
  const cachedFolders = await listDesignParentFolders();

  const candidates = designs.filter((d) => (onlyEmpty ? !(knownByDesign.get(d.id)?.size ?? 0) : true)).slice(0, limit);

  const withPhotos: { designId: string; label: string; folderId: string; files: number; unregistered: number; ingested?: number }[] = [];
  const emptyFolder: string[] = [];
  const noFolder: string[] = [];
  const failures: { label: string; error: string }[] = [];

  for (const d of candidates) {
    const label = `${d.base_sku}-${d.color}`;
    try {
      let folderId = d.drive_folder_id;
      if (!folderId) {
        // create:false — we are looking for photos that already exist, not
        // making somewhere to put them.
        const match = await ensureDesignFolder(d.base_sku, d.color, { create: false, cachedFolders });
        folderId = match.folderId;
      }
      if (!folderId) { noFolder.push(label); continue; }

      const files = await listFolderImages(folderId);
      if (files.length === 0) { emptyFolder.push(label); continue; }

      const known = knownByDesign.get(d.id) ?? new Set<string>();
      const unregistered = files.filter((f) => !known.has(f.id)).length;
      const row: (typeof withPhotos)[number] = { designId: d.id, label, folderId, files: files.length, unregistered };

      if (ingest && unregistered > 0) {
        const res = await ingestDriveFolder(d.id, { cachedFolders });
        row.ingested = res.added;
        if (!res.ok && res.error) failures.push({ label, error: res.error });
      }
      withPhotos.push(row);
    } catch (e) {
      failures.push({ label, error: (e as Error).message });
    }
  }

  const totalUnregistered = withPhotos.reduce((n, r) => n + r.unregistered, 0);
  const totalIngested = withPhotos.reduce((n, r) => n + (r.ingested ?? 0), 0);

  return NextResponse.json({
    mode: ingest ? "ingest" : "read-only",
    scope: onlyEmpty ? "designs with no registered image" : "all designs",
    scanned: candidates.length,
    truncated: candidates.length < designs.filter((d) => (onlyEmpty ? !(knownByDesign.get(d.id)?.size ?? 0) : true)).length,
    designsWithDrivePhotos: withPhotos.length,
    totalUnregistered,
    totalIngested,
    emptyFolder: emptyFolder.length,
    noFolder: noFolder.length,
    failures,
    detail: withPhotos,
    emptyFolderLabels: emptyFolder,
    noFolderLabels: noFolder,
    summary: ingest
      ? `Ingested ${totalIngested} file(s) from ${withPhotos.length} Drive folder(s). ${emptyFolder.length} folder(s) empty, ${noFolder.length} design(s) have no folder.`
      : `${withPhotos.length} design(s) have photos in Drive, ${totalUnregistered} file(s) not yet registered. ${emptyFolder.length} folder(s) empty, ${noFolder.length} design(s) have no folder.`,
  });
}
