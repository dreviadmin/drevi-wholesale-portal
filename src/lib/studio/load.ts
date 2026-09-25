import "server-only";

import { defaultAnglePrompt } from "./prompts";
import { defaultCopyPrompt } from "./copy-prompt";
import { defaultCopyModel } from "./copy-models";
import { promptDesignFrom } from "./facts";
import { missingFields, type MissingKey } from "./missing";
import { createAdminClient } from "@/lib/supabase/admin";
import { sweepStaleJobs } from "@/lib/pipeline/sweep";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { loadVocab } from "@/lib/sku/vocab-live";
import {
  deriveBadge, badgeLabelWithPortals, gateFor,
  type Angle, type DesignBadge, type DesignStateInput, type PortalKey, type TargetState,
} from "./state";

// One loader feeding the board, the cockpit's studio counts and the scan
// sheet's design lookup — state derivation stays in studio/state.ts.

export interface BoardRow {
  id: string;
  baseSku: string;
  color: string;
  title: string | null;
  category: string | null;
  tier: "standard" | "hero";
  specsVerified: boolean;
  badge: DesignBadge;
  badgeLabel: string;
  filledCount: number; // of all 6 angles — effective image present (approved candidate, else source)
  copyStatus: "none" | "draft" | "approved";
  copyPresent: boolean; // non-empty title AND description — draft is enough now
  targets: { portal: PortalKey; enabled: boolean; state: TargetState }[];
  gates: Record<PortalKey, { ready: boolean; blockers: string[] }>;
  thumb: string | null;
  wholesalePriceSet: boolean;
  notifyCount: number; // open back-in-stock requests (Stage 9)
  /** Spec fields this design is still short of — drives the board's Missing
   *  chips. Empty on a complete design. */
  missing: MissingKey[];
  /** Retired (0063). The board hides these unless "Discontinued" is on. */
  discontinuedAt: string | null;
  discontinuedBy: string | null;
  discontinuedNote: string | null;
  createdAt: string; // ISO from designs.created_at ('' if null)
}

/**
 * opts.includeDiscontinued — retired designs are EXCLUDED by default (0063).
 *
 * Correct-by-default on purpose. This loader feeds the board, the staff
 * attention inbox and the scan sheet, and the inbox counted retired designs
 * while the board hid them: "9 designs awaiting photos" linking to a list of
 * 7. Anything that wants them must now say so, and only two callers do — the
 * board, which has a switch for them, and loadDesignDetail, which must still
 * be able to open one to restore it.
 */
export async function loadBoard(opts?: { includeDiscontinued?: boolean }): Promise<BoardRow[]> {
  // Auto-kill, on the read path (Ansh, 20 Sep). The old sweep lived inside
  // regenAngle, which the Workbench hides while a job is in flight — the only
  // thing that could free a stuck angle was the button that angle had taken
  // away. Opening the studio now clears anything that has outlived its budget.
  await sweepStaleJobs(createAdminClient());
  const admin = createAdminClient();
  const [designs, angles, activeImages, copies, targets, products, notifies, publishedFronts, vocab] = await Promise.all([
    fetchAll<{
      id: string; base_sku: string; color: string; title: string | null; category: string | null;
      tier: "standard" | "hero"; specs_verified: boolean; created_at: string | null;
      // Read for the Missing chips (22 Sep). They ride along on the query
      // the board already runs rather than costing a second pass.
      origin: string | null; fabric: string | null; handwork: string | null;
      color_name: string | null; sub_category: string | null;
      mrp_override: number | null; auto_mrp: number | null;
      discontinued_at: string | null; discontinued_by: string | null; discontinued_note: string | null;
    }>(
      admin, "designs",
      "id, base_sku, color, title, category, sub_category, tier, specs_verified, created_at, " +
      "origin, fabric, handwork, color_name, mrp_override, auto_mrp, " +
      "discontinued_at, discontinued_by, discontinued_note",
      // Board default: newest design first (§7.4 / Item 4). nullsFirst:false —
      // the column is nullable and Postgres floats NULLs to the top on DESC.
      // id desc is the stable tiebreak so paging never reshuffles equal stamps.
      (q) => q.order("created_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false })),
    fetchAll<{ id: string; design_id: string; angle: Angle; approved_image_id: string | null; source_ref: string | null }>(
      admin, "design_angles", "id, design_id, angle, approved_image_id, source_ref"),
    // id + file_ref so a board tile can fall back to the design's own front
    // image when the wholesale group has no published photo yet; role so a
    // source row never reads as a candidate awaiting review.
    fetchAll<{ id: string; angle_id: string | null; file_ref: string; role: string }>(
      admin, "design_images", "id, angle_id, file_ref, role", (q) => q.eq("status", "active")),
    fetchAll<{ design_id: string; status: "none" | "draft" | "approved"; title: string | null; description: string | null }>(
      admin, "design_copy", "design_id, status, title, description"),
    fetchAll<{ design_id: string; portal: PortalKey; enabled: boolean; state: TargetState }>(
      admin, "publish_targets", "design_id, portal, enabled, state"),
    fetchAll<{ sku: string; wholesale_price: number; image_urls: string[] | null }>(
      admin, "wholesale_products", "sku, wholesale_price, image_urls"),
    fetchAll<{ sku_base: string; color: string }>(admin, "notify_me", "sku_base, color", (q) => q.is("fulfilled_at", null)),
    // The PUBLISHED front, which is what a pushed product actually shows.
    fetchAll<{ sku_base: string; color: string; storage_path: string; published_at: string | null }>(
      admin, "product_images", "sku_base, color, storage_path, published_at", (q) => q.eq("angle", "front")),
    // For the colour check only: a design carrying GLD with no color_name is
    // not missing a colour, because the vocabulary answers "Gold" — and that
    // is the name the title and the metafield already use.
    loadVocab(),
  ]);
  // Keyed the same way as groupThumb. `?v=` is the published stamp: a reshoot
  // reuses the same deterministic storage path, so without it the URL never
  // changes and a cached copy keeps showing the old photograph.
  const { data: pubUrl } = admin.storage.from("product-images").getPublicUrl("x");
  const bucketBase = pubUrl.publicUrl.replace(/\/x$/, "");
  const publishedFront = new Map<string, string>();
  for (const f of publishedFronts) {
    const k = `${f.sku_base}|${f.color}`.toUpperCase();
    const v = f.published_at ? `?v=${Date.parse(f.published_at)}` : "";
    if (!publishedFront.has(k)) publishedFront.set(k, `${bucketBase}/${f.storage_path}${v}`);
  }

  const notifyByGroup = new Map<string, number>();
  for (const n of notifies) {
    const key = `${n.sku_base.toUpperCase()}|${n.color.toUpperCase()}`;
    notifyByGroup.set(key, (notifyByGroup.get(key) ?? 0) + 1);
  }

  const imageRefById = new Map(activeImages.map((c) => [c.id, c.file_ref]));
  // Candidates awaiting a look: active, attached to an angle, and NOT a source
  // row (sources are inputs — under effective semantics they already count as
  // filled, so only generated/imported/cropped output waits for eyes).
  const reviewImagesByAngle = new Map<string, string[]>();
  for (const c of activeImages) {
    if (!c.angle_id || c.role === "source") continue;
    const list = reviewImagesByAngle.get(c.angle_id) ?? [];
    list.push(c.id);
    reviewImagesByAngle.set(c.angle_id, list);
  }
  const anglesByDesign = new Map<string, typeof angles>();
  for (const a of angles) {
    const list = anglesByDesign.get(a.design_id) ?? [];
    list.push(a);
    anglesByDesign.set(a.design_id, list);
  }
  const copyByDesign = new Map(copies.map((c) => [c.design_id, c]));
  const targetsByDesign = new Map<string, BoardRow["targets"]>();
  for (const t of targets) {
    const list = targetsByDesign.get(t.design_id) ?? [];
    list.push({ portal: t.portal, enabled: t.enabled, state: t.state });
    targetsByDesign.set(t.design_id, list);
  }
  // Per (base|color) group: any variant priced → price set; first photo → thumb.
  const priceSet = new Set<string>();
  const groupThumb = new Map<string, string>();
  for (const p of products) {
    const parts = p.sku.toUpperCase().split("-");
    if (parts.length < 5 || !/^\d{2,4}$/.test(parts[3])) continue;
    const key = `${parts.slice(0, 4).join("-")}|${parts[parts.length - 1]}`;
    if ((p.wholesale_price ?? 0) > 0) priceSet.add(key);
    const img = (p.image_urls ?? [])[0];
    if (img && !groupThumb.has(key)) groupThumb.set(key, img);
  }

  const keep = opts?.includeDiscontinued
    ? designs
    : designs.filter((d) => !d.discontinued_at);

  return keep.map((d) => {
    const key = `${d.base_sku}|${d.color}`;
    const dAngles = anglesByDesign.get(d.id) ?? [];
    const filledAngles: Partial<Record<Angle, boolean>> = {};
    const review: Partial<Record<Angle, boolean>> = {};
    let frontRef: string | null = null;
    for (const a of dAngles) {
      // Effective image = approved candidate, else the angle's source.
      if (a.approved_image_id || a.source_ref) filledAngles[a.angle] = true;
      if ((reviewImagesByAngle.get(a.id) ?? []).some((id) => id !== a.approved_image_id)) review[a.angle] = true;
      if (a.angle === "front") {
        frontRef = (a.approved_image_id ? imageRefById.get(a.approved_image_id) : null) ?? a.source_ref ?? null;
      }
    }
    const copyRow = copyByDesign.get(d.id);
    const input: DesignStateInput = {
      specsVerified: d.specs_verified,
      filledAngles,
      reviewAngles: review,
      copyStatus: copyRow?.status ?? "none",
      copyPresent: (copyRow?.status ?? "none") !== "none" && !!copyRow?.title?.trim() && !!copyRow?.description?.trim(),
      targets: targetsByDesign.get(d.id) ?? [],
      wholesalePriceSet: priceSet.has(key),
      tier: d.tier,
      origin: d.origin,
      discontinued: !!d.discontinued_at,
      // The same expression the Shopify push uses to price every variant.
      retailPriceSet: Number(d.mrp_override ?? d.auto_mrp ?? 0) > 0,
    };
    const { badge, portals } = deriveBadge(input);
    return {
      id: d.id,
      baseSku: d.base_sku,
      color: d.color,
      // The GENERATED name wins once it exists (Ansh, 21 Sep: "the name shown
      // here in studio is not getting updated even after copy is generated").
      // designs.title is whatever was typed at Log delivery — "beeds zari and
      // sequin work" — and the board kept showing that after Opus had written
      // the real product name. The copy row was already loaded here for
      // copyPresent; only the board never read it.
      title: copyRow?.title?.trim() || d.title,
      category: d.category,
      tier: d.tier,
      specsVerified: d.specs_verified,
      badge,
      badgeLabel: badgeLabelWithPortals(badge, portals),
      filledCount: (Object.keys(filledAngles) as Angle[]).filter((a) => filledAngles[a]).length,
      copyStatus: input.copyStatus,
      copyPresent: input.copyPresent,
      targets: input.targets,
      gates: {
        wholesale: gateFor("wholesale", input),
        shopify: gateFor("shopify", input),
      },
      // THE PUBLISHED FRONT WINS (Ansh, 25 Sep: "only the front image is used as
      // the thumbnail for pushed products, not the older image from catalog").
      //
      // This used to read image_urls[0] first. That column is catalog data — the
      // master sheet writes it, and publishWholesale only overwrites it when a
      // design is actually pushed through that path. Anything published before
      // the lock existed, or photographed outside it, kept an old
      // product-photos/<sku>.png there and the board showed that instead of the
      // front the design actually has. product_images is the published set; if a
      // front is registered, it IS the thumbnail. image_urls stays as the
      // fallback for designs with no published front, and the staff-gated
      // /api/drive-photo ref as the last resort.
      thumb: publishedFront.get(key.toUpperCase())
        ?? groupThumb.get(key)
        ?? (frontRef ? `/api/drive-photo?id=${encodeURIComponent(frontRef)}&s=200` : null),
      wholesalePriceSet: input.wholesalePriceSet,
      notifyCount: notifyByGroup.get(key.toUpperCase()) ?? 0,
      missing: missingFields({
        origin: d.origin, fabric: d.fabric, handwork: d.handwork,
        color: d.color, colorName: d.color_name,
        category: d.category, subCategory: d.sub_category,
        mrpOverride: d.mrp_override, autoMrp: d.auto_mrp,
        wholesalePriceSet: input.wholesalePriceSet,
      }, vocab),
      discontinuedAt: d.discontinued_at,
      discontinuedBy: d.discontinued_by,
      discontinuedNote: d.discontinued_note,
      createdAt: d.created_at ?? "",
    };
  });
}

// Per-design detail for the workbench (§9): angles with their full candidate
// history (D1), newest first.
export interface AngleDetail {
  id: string;
  angle: Angle;
  sourceRef: string | null;
  prompt: string;
  promptEditedByHuman: boolean;
  engine: "fashn" | "openai_bg" | "raw" | "seedream" | "nano_banana" | "matte";
  approvedImageId: string | null;
  sourceImageId: string | null;
  candidates: { id: string; role: string; engine: string; fileRef: string; status: string; createdAt: string; costCredits: number }[];
}

export interface DesignImage {
  id: string; role: string; angle: string | null; engine: string | null;
  fileRef: string; fileName: string | null; status: string; createdAt: string; derivedFrom: string | null;
}

export interface CopyDetail {
  title: string; description: string; tags: Record<string, string>;
  status: "none" | "draft" | "approved";
  model: string | null; editedBy: string | null; approvedBy: string | null;
  /** §8 — the prompt this design would run: the saved override, or the default rebuilt from its specs. */
  prompt: string;
  promptEdited: boolean;
  /** The model this design would run: the saved override, or the tier default. */
  effectiveModel: string;
  modelOverridden: boolean;
}

export async function loadDesignDetail(designId: string): Promise<{
  board: BoardRow;
  angles: AngleDetail[];
  copy: CopyDetail;
  pool: DesignImage[];
  identImageId: string | null;
  driveFolderId: string | null;
  activeJobs: { angleId: string | null; type: string; status: string; progress: number }[];
} | null> {
  // Retired designs included: the workbench is where the restore button is,
  // so refusing to open one would strand it.
  const rows = await loadBoard({ includeDiscontinued: true });
  const board = rows.find((r) => r.id === designId);
  if (!board) return null;
  const admin = createAdminClient();
  const [{ data: angles }, { data: jobs }, { data: copyRow }, { data: poolRows }, { data: designRow }, vocab] = await Promise.all([
    admin
      .from("design_angles")
      // Two FKs link these tables (angle_id + approved_image_id) — the
      // !angle_id hint picks the one-to-many history relation.
      .select("id, angle, source_ref, source_image_id, prompt, prompt_edited_by_human, engine, approved_image_id, design_images!angle_id(id, role, engine, file_ref, status, created_at, cost_credits)")
      .eq("design_id", designId),
    admin
      .from("pipeline_jobs")
      .select("angle_id, type, status, progress")
      .eq("design_id", designId)
      .in("status", ["queued", "claimed", "running"]),
    admin.from("design_copy").select("title, description, tags, status, model, edited_by, approved_by, prompt, model_override").eq("design_id", designId).maybeSingle(),
    // §7.2 picker pool: EVERY image of the design, incl. ident and images
    // detached from closeup angles by migration 0023.
    admin
      .from("design_images")
      .select("id, role, angle_id, engine, file_ref, file_name, status, created_at, derived_from")
      .eq("design_id", designId)
      .order("created_at", { ascending: false }),
    admin.from("designs").select("ident_image_id, drive_folder_id, title, category, sub_category, color, color_name, fabric, handwork, origin, tier, bg_style, base_sku").eq("id", designId).maybeSingle(),
    loadVocab(),
  ]);
  // Codes → names (Saree / Pre-Draped, Gold) for both the copy and angle defaults.
  const promptDesign = promptDesignFrom(designRow, vocab);
  const order: Record<string, number> = { front: 0, back: 1, side: 2, lifestyle: 3, detail_1: 4, detail_2: 5 };
  const angleNameById = new Map((angles ?? []).map((a) => [a.id, a.angle as string]));
  const pool: DesignImage[] = (poolRows ?? []).map((r) => ({
    id: r.id,
    role: r.role,
    angle: r.angle_id ? angleNameById.get(r.angle_id) ?? null : null,
    engine: r.engine,
    fileRef: r.file_ref,
    fileName: r.file_name,
    status: r.status,
    createdAt: r.created_at,
    derivedFrom: r.derived_from,
  }));
  return {
    board,
    pool,
    identImageId: designRow?.ident_image_id ?? null,
    driveFolderId: designRow?.drive_folder_id ?? null,
    copy: {
      title: copyRow?.title ?? "",
      description: copyRow?.description ?? "",
      tags: (copyRow?.tags as Record<string, string>) ?? {},
      status: (copyRow?.status ?? "none") as CopyDetail["status"],
      model: copyRow?.model ?? null,
      editedBy: copyRow?.edited_by ?? null,
      approvedBy: copyRow?.approved_by ?? null,
      prompt: copyRow?.prompt?.trim() ? copyRow.prompt : defaultCopyPrompt(promptDesign),
      promptEdited: !!copyRow?.prompt?.trim(),
      effectiveModel: copyRow?.model_override || defaultCopyModel(designRow?.tier),
      modelOverridden: !!copyRow?.model_override,
    },
    angles: (angles ?? [])
      .map((a) => ({
        id: a.id,
        angle: a.angle as Angle,
        sourceRef: a.source_ref,
        // §7.1 — an unedited angle shows the uniform grey-studio default,
        // built from this design's own specs. Saved prompts always win.
        // prompt defaults to '' in 0016 — ?? would keep the empty string.
        prompt: a.prompt?.trim() ? a.prompt : defaultAnglePrompt(a.angle, a.engine, promptDesign),
        promptEditedByHuman: a.prompt_edited_by_human,
        engine: a.engine as AngleDetail["engine"],
        approvedImageId: a.approved_image_id,
        sourceImageId: a.source_image_id ?? null,
        candidates: ((a.design_images as { id: string; role: string; engine: string | null; file_ref: string; status: string; created_at: string; cost_credits: number }[] | null) ?? [])
          // Sources live in their own pane — except when one has been approved
          // outright (mode B), where it IS the production image.
          .filter((c) => c.role !== "source" || c.id === a.approved_image_id)
          .map((c) => ({ id: c.id, role: c.role, engine: c.engine ?? "raw", fileRef: c.file_ref, status: c.status, createdAt: c.created_at, costCredits: Number(c.cost_credits ?? 0) }))
          .sort((x, y) => y.createdAt.localeCompare(x.createdAt)),
      }))
      .sort((x, y) => order[x.angle] - order[y.angle]),
    activeJobs: (jobs ?? []).map((j) => ({ angleId: j.angle_id, type: j.type, status: j.status, progress: j.progress })),
  };
}
