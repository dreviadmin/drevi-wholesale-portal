import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { ensureDesignImagery } from "@/lib/design-imagery";
import { storeDesignImage } from "@/lib/design-image-store";
import { uploadsEnabled as driveConfigured } from "@/lib/drive-design";

// Rakesh's imagery closure (17 Sep), read as four invariants plus a catch-all:
//
//   I1  thumbnail present -> a SOURCE exists. "A drive folder shall be created
//       with the thumbnail inside it (the folder becomes the source)."
//   I2  thumbnail present -> the FRONT angle is filled.
//   I3  front present     -> a thumbnail shows.
//   I4  front present     -> the front has a source.
//   I5  ANY image anywhere (catalog thumbnail, Drive, identifier, manual
//       upload) -> both thumbnail and front are populated.
//
// WHAT THIS SWEEP WRITES, AND WHAT IT DELIBERATELY DOES NOT:
//
// I3 and the thumbnail half of I5 need NO data change. The board's thumbnail is
// wholesale_products.image_urls[0], which is catalog data owned by the master
// sheet / Shopify sync — writing it here would be overwritten on the next sync
// and would put design imagery into the buyer-facing catalog without review.
// loadBoard already closes the gap at render: thumb = image_urls[0] ?? a
// /api/drive-photo URL for the front ref (src/lib/studio/load.ts). So a design
// with a front ALWAYS shows a thumbnail; this sweep only counts those cases.
//
// I1, I2 and the front half of I5 are the same repair: get one real image row
// onto the design, then let ensureDesignImagery fill the identifier and the
// front source from it. That rule is NOT reimplemented here — it is imported.
//
// I4 is the one case ensureDesignImagery cannot express: it treats an approved
// front as "not blank" and returns early, so a front carrying approved_image_id
// with no source_ref never reaches it. The Workbench renders source_ref, so
// such a front reads "Need source" while showing an approved photo. Repaired
// below by pointing source_ref / source_image_id at the approved image's own
// file_ref — the image is already ours, so nothing is fetched.
//
// NEVER writes approved_image_id: approval is a human quality gate and an
// auto-approved photo would publish unreviewed to the storefront.

/** Shopify CDN plus the Supabase projects whose public buckets we serve from. */
const ALLOWED_IMAGE_HOSTS = new Set([
  "qvnvxcdyvcsgxulbcmzm.supabase.co",
  "cofarxgywnrdjbizxbxw.supabase.co",
  "cdn.shopify.com",
]);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const SWEEP_SIGNATURE = "imagery-sweep"; // design_images.created_by marker

export type SweepActionKind =
  | "thumbnail-stored" // catalog photo copied into the design's own imagery
  | "ident-set"
  | "front-seeded"
  | "front-created"
  | "front-source-repaired"; // I4

export interface SweepAction {
  designId: string;
  label: string; // BASESKU-COLOR, the name staff recognise
  kind: SweepActionKind;
  invariant: "I1" | "I2" | "I4" | "I5";
  detail: string;
}

export interface SweepFailure {
  designId: string;
  label: string;
  reason: string;
}

/** Designs matching each invariant's BREACH condition, counted before any write. */
export interface SweepTotals {
  designs: number;
  /** I1 — a catalog thumbnail but no source anywhere on the design */
  i1ThumbnailWithoutSource: number;
  /** I2 — a catalog thumbnail but an empty front */
  i2ThumbnailWithoutFront: number;
  /** I3 — a front but no catalog thumbnail. Satisfied at render, never written. */
  i3FrontWithoutThumbnailRenderOnly: number;
  /** I4 — an approved front with no source_ref ("Need source" in the Workbench) */
  i4FrontWithoutSource: number;
  /** I5 — at least one image somewhere, yet the front is still empty */
  i5AnyImageFrontEmpty: number;
  /** designs with no image on any channel — the rule promises them nothing */
  noImageAtAll: number;
}

export interface SweepResult {
  dryRun: boolean;
  /** false locally without GOOGLE_SERVICE_ACCOUNT_JSON — stored bytes go to the bucket instead */
  driveConfigured: boolean;
  storageNote: string;
  before: SweepTotals;
  actions: SweepAction[];
  failures: SweepFailure[];
  /** designs that needed work and were attempted this run */
  attempted: number;
  /** designs that needed work but fell outside `limit` */
  remaining: number;
  moreWork: boolean;
  summary: string;
}

interface DesignRow {
  id: string;
  base_sku: string;
  color: string;
  title: string | null;
  ident_image_id: string | null;
  created_at: string | null;
}
interface AngleRow {
  id: string;
  design_id: string;
  angle: string;
  source_ref: string | null;
  source_image_id: string | null;
  approved_image_id: string | null;
}
interface ImageRow {
  id: string;
  design_id: string | null;
  file_ref: string;
  role: string;
  status: string;
  created_at: string | null;
}
interface ProductRow {
  sku: string;
  image_urls: string[] | null;
}

interface World {
  designs: DesignRow[];
  frontByDesign: Map<string, AngleRow>;
  imagesByDesign: Map<string, ImageRow[]>;
  imageById: Map<string, ImageRow>;
  thumbByGroup: Map<string, string>;
}

async function readWorld(admin: SupabaseClient): Promise<World> {
  const [designs, angles, images, products] = await Promise.all([
    // Oldest first so a partial (limited) run always walks the same designs in
    // the same order — batch 2 resumes where batch 1 stopped.
    fetchAll<DesignRow>(admin, "designs", "id, base_sku, color, title, ident_image_id, created_at",
      (q) => q.order("created_at", { ascending: true, nullsFirst: true }).order("id", { ascending: true })),
    fetchAll<AngleRow>(admin, "design_angles", "id, design_id, angle, source_ref, source_image_id, approved_image_id"),
    fetchAll<ImageRow>(admin, "design_images", "id, design_id, file_ref, role, status, created_at",
      (q) => q.eq("status", "active")),
    fetchAll<ProductRow>(admin, "wholesale_products", "sku, image_urls"),
  ]);

  const frontByDesign = new Map<string, AngleRow>();
  for (const a of angles) if (a.angle === "front") frontByDesign.set(a.design_id, a);

  const imagesByDesign = new Map<string, ImageRow[]>();
  const imageById = new Map<string, ImageRow>();
  for (const i of images) {
    imageById.set(i.id, i);
    if (!i.design_id) continue;
    const list = imagesByDesign.get(i.design_id) ?? [];
    list.push(i);
    imagesByDesign.set(i.design_id, list);
  }

  // First catalog photo per (base|color) group — the SAME key walk loadBoard
  // uses, so "the thumbnail I can see" here means the one the board renders.
  const thumbByGroup = new Map<string, string>();
  for (const p of products) {
    const parts = p.sku.toUpperCase().split("-");
    if (parts.length < 5 || !/^\d{2,4}$/.test(parts[3])) continue;
    const key = `${parts.slice(0, 4).join("-")}|${parts[parts.length - 1]}`;
    const img = (p.image_urls ?? [])[0];
    if (img && !thumbByGroup.has(key)) thumbByGroup.set(key, img);
  }

  return { designs, frontByDesign, imagesByDesign, imageById, thumbByGroup };
}

interface Plan {
  label: string;
  thumb: string | null;
  front: AngleRow | null;
  /** an active, non-candidate image row already on the design */
  ownImages: ImageRow[];
  frontHasSource: boolean;
  frontFilled: boolean;
  anyImage: boolean;
  breaches: { i1: boolean; i2: boolean; i3: boolean; i4: boolean; i5: boolean };
  needsWork: boolean;
}

function planFor(world: World, d: DesignRow): Plan {
  const thumb = world.thumbByGroup.get(`${d.base_sku}|${d.color}`) ?? null;
  const front = world.frontByDesign.get(d.id) ?? null;
  // Candidates are generated output awaiting review, never a source in their
  // own right — and every candidate came FROM a source row already in this pool.
  const ownImages = (world.imagesByDesign.get(d.id) ?? []).filter((i) => i.role !== "candidate");

  const frontHasSource = !!front?.source_ref;
  // "Filled" matches loadBoard's effective-image test: approved candidate, else source.
  const frontFilled = !!(front && (front.approved_image_id || front.source_ref));
  const identImage = d.ident_image_id ? world.imageById.get(d.ident_image_id) : undefined;
  const anyImage = !!thumb || ownImages.length > 0 || !!identImage || frontFilled;

  // A "source" for I1 means the design owns actual image bytes we can point at,
  // not merely that a catalog URL exists on the wholesale row.
  const hasSourceAnywhere = frontHasSource || ownImages.length > 0 || !!identImage;

  const breaches = {
    i1: !!thumb && !hasSourceAnywhere,
    i2: !!thumb && !frontFilled,
    i3: frontFilled && !thumb, // render-only, counted not repaired
    i4: !!front?.approved_image_id && !front.source_ref,
    i5: anyImage && !frontFilled,
  };
  return {
    label: `${d.base_sku}-${d.color}`,
    thumb,
    front,
    ownImages,
    frontHasSource,
    frontFilled,
    anyImage,
    breaches,
    // I3 is satisfied by loadBoard's fallback, so it never makes a design "work".
    needsWork: breaches.i1 || breaches.i2 || breaches.i4 || breaches.i5,
  };
}

function tally(world: World): SweepTotals {
  const t: SweepTotals = {
    designs: world.designs.length,
    i1ThumbnailWithoutSource: 0,
    i2ThumbnailWithoutFront: 0,
    i3FrontWithoutThumbnailRenderOnly: 0,
    i4FrontWithoutSource: 0,
    i5AnyImageFrontEmpty: 0,
    noImageAtAll: 0,
  };
  for (const d of world.designs) {
    const p = planFor(world, d);
    if (p.breaches.i1) t.i1ThumbnailWithoutSource++;
    if (p.breaches.i2) t.i2ThumbnailWithoutFront++;
    if (p.breaches.i3) t.i3FrontWithoutThumbnailRenderOnly++;
    if (p.breaches.i4) t.i4FrontWithoutSource++;
    if (p.breaches.i5) t.i5AnyImageFrontEmpty++;
    if (!p.anyImage) t.noImageAtAll++;
  }
  return t;
}

/**
 * Fetch a catalog thumbnail's bytes. The URL comes from our own database, but
 * an allowlist is what stops a poisoned wholesale_products row from turning
 * this server-side fetch into request forgery against an internal address.
 * https only, exact hostname, real image content-type, size cap.
 */
async function fetchThumbnailBytes(rawUrl: string): Promise<{ bytes: Buffer; contentType: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`not a URL: ${rawUrl.slice(0, 80)}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`refused non-https URL (${parsed.protocol})`);
  if (!ALLOWED_IMAGE_HOSTS.has(parsed.hostname)) throw new Error(`host not allowlisted: ${parsed.hostname}`);

  // redirect:"error" — an allowlisted host must not be able to bounce us
  // somewhere unlisted after the check has already passed.
  const res = await fetch(parsed.href, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!/^image\/(png|jpe?g|webp)$/.test(contentType)) {
    throw new Error(`not an image: ${contentType || "(no content-type)"}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error(`bad size: ${bytes.length} bytes`);
  return { bytes, contentType };
}

/**
 * I1 — turn the catalog thumbnail into imagery the design actually owns.
 * storeDesignImage resolves (and creates) the design's Drive folder when Drive
 * is configured, which IS "a drive folder shall be created with the thumbnail
 * inside it"; without Drive credentials it stores to the design-images bucket
 * as an "sb:" ref, a correct degradation the whole app already serves.
 */
async function materialiseThumbnail(
  admin: SupabaseClient,
  d: DesignRow,
  thumbUrl: string,
): Promise<{ detail: string }> {
  const { bytes, contentType } = await fetchThumbnailBytes(thumbUrl);
  const stored = await storeDesignImage({
    designId: d.id,
    baseSku: d.base_sku,
    color: d.color,
    angle: "front",
    kind: "src",
    bytes,
    contentType,
  });

  // (design_id, file_ref) is unique from 0040 — conflict-ignore makes a re-run
  // after a partial failure reuse the row instead of inserting a duplicate.
  const { error } = await admin.from("design_images").upsert(
    {
      design_id: d.id,
      angle_id: null,
      role: "source",
      file_ref: stored.fileRef,
      file_name: stored.fileName,
      status: "active",
      created_by: SWEEP_SIGNATURE,
    },
    { onConflict: "design_id,file_ref", ignoreDuplicates: true },
  );
  if (error) throw new Error(`design_images insert failed: ${error.message}`);

  if (stored.driveFolderId) {
    // Remember the folder so later ingests skip the name search entirely.
    await admin.from("designs").update({ drive_folder_id: stored.driveFolderId }).eq("id", d.id).is("drive_folder_id", null);
    return { detail: `drive:${stored.driveFolderId}/${stored.fileName}` };
  }
  return { detail: stored.fileRef };
}

/**
 * I4 — an approved front with no source_ref reads "Need source" in the
 * Workbench even though it is showing a photo. The approved image is already
 * ours, so the repair is a pointer fix, never a download.
 */
async function repairFrontSource(admin: SupabaseClient, world: World, front: AngleRow): Promise<string | null> {
  const approved = front.approved_image_id ? world.imageById.get(front.approved_image_id) : undefined;
  if (!approved?.file_ref) return null;
  // Guarded on source_ref still being null: a Studio save between our read and
  // this write already did the job properly and must not be overwritten.
  const { data: hit, error } = await admin
    .from("design_angles")
    .update({ source_image_id: approved.id, source_ref: approved.file_ref, updated_at: new Date().toISOString() })
    .eq("id", front.id)
    .is("source_ref", null)
    .select("id");
  if (error) throw new Error(`front source repair failed: ${error.message}`);
  return (hit ?? []).length > 0 ? approved.file_ref : null;
}

export interface SweepOptions {
  dryRun: boolean;
  /** cap the designs REPAIRED this run so a batch fits inside maxDuration */
  limit?: number;
}

/**
 * Enforce the imagery invariants across every design.
 *
 * Idempotent: a second run reports zero actions, because every repair removes
 * the condition that selected the design.
 *
 * Deterministic: designs are walked oldest-first and ensureDesignImagery picks
 * the oldest active photo. The owner's "use random in case of confusion" asks
 * only that SOME photo be chosen when several would do — a stable choice
 * satisfies "any one" while staying reproducible and debuggable, where a random
 * pick would make two runs disagree and a reported result impossible to check.
 *
 * Never throws out of the loop: one unreachable image or one bad row must not
 * abort the sweep, so failures are collected and reported per design.
 */
export async function sweepDesignImagery(opts: SweepOptions): Promise<SweepResult> {
  const { dryRun, limit } = opts;
  const admin = createAdminClient();
  const world = await readWorld(admin);
  const before = tally(world);

  const driveOn = driveConfigured();
  const storageNote = driveOn
    ? "Drive is configured — a design's folder is created on demand and the thumbnail is stored inside it."
    : "Drive is not configured — thumbnails are stored in the design-images bucket as sb: refs, which the portal serves identically.";

  const actions: SweepAction[] = [];
  const failures: SweepFailure[] = [];
  let attempted = 0;
  let remaining = 0;

  for (const d of world.designs) {
    const plan = planFor(world, d);
    if (!plan.needsWork) continue;
    if (limit !== undefined && attempted >= limit) {
      remaining++;
      continue;
    }
    attempted++;

    try {
      // I1 / I5 — no bytes of our own yet, but a catalog thumbnail exists.
      if (plan.breaches.i1 && plan.thumb) {
        if (dryRun) {
          actions.push({ designId: d.id, label: plan.label, kind: "thumbnail-stored", invariant: "I1", detail: `would store ${plan.thumb.slice(0, 100)}` });
        } else {
          const { detail } = await materialiseThumbnail(admin, d, plan.thumb);
          actions.push({ designId: d.id, label: plan.label, kind: "thumbnail-stored", invariant: "I1", detail });
        }
      }

      // I2 / I5 — fill the identifier and the front SOURCE from whatever the
      // design now owns. One implementation of that rule, imported not copied.
      if (plan.breaches.i2 || plan.breaches.i5) {
        if (dryRun) {
          // The store above has not run, so a design whose only photo WOULD be
          // the thumbnail cannot be resolved for real here — say so plainly
          // rather than implying a row exists.
          const basis = plan.ownImages.length > 0 || plan.thumb ? "would seed front source and identifier" : "no photo to seed from";
          actions.push({ designId: d.id, label: plan.label, kind: "front-seeded", invariant: plan.breaches.i2 ? "I2" : "I5", detail: basis });
        } else {
          const r = await ensureDesignImagery(admin, d.id);
          const inv = plan.breaches.i2 ? "I2" : "I5";
          if (r.identSet) actions.push({ designId: d.id, label: plan.label, kind: "ident-set", invariant: inv, detail: "identifier filled" });
          if (r.frontCreated) actions.push({ designId: d.id, label: plan.label, kind: "front-created", invariant: inv, detail: "front angle row created" });
          else if (r.frontSeeded) actions.push({ designId: d.id, label: plan.label, kind: "front-seeded", invariant: inv, detail: "front source seeded" });
          if (!r.identSet && !r.frontSeeded && !r.frontCreated) {
            failures.push({ designId: d.id, label: plan.label, reason: "no usable photo to seed the front from" });
          }
        }
      }

      // I4 — approved front, no source_ref.
      if (plan.breaches.i4 && plan.front) {
        if (dryRun) {
          actions.push({ designId: d.id, label: plan.label, kind: "front-source-repaired", invariant: "I4", detail: "would point source at the approved image" });
        } else {
          const ref = await repairFrontSource(admin, world, plan.front);
          if (ref) actions.push({ designId: d.id, label: plan.label, kind: "front-source-repaired", invariant: "I4", detail: ref });
          else failures.push({ designId: d.id, label: plan.label, reason: "approved image row missing or source already set" });
        }
      }
    } catch (err) {
      failures.push({ designId: d.id, label: plan.label, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const summary = `${dryRun ? "Would repair" : "Repaired"} ${attempted} design(s): ${actions.length} action(s), ${failures.length} failure(s).`
    + (remaining > 0 ? ` ${remaining} more design(s) still need work — run again to continue.` : " No further work remains.");

  return {
    dryRun,
    driveConfigured: driveOn,
    storageNote,
    before,
    actions,
    failures,
    attempted,
    remaining,
    moreWork: remaining > 0,
    summary,
  };
}
