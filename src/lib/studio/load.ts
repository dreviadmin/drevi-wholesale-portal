import "server-only";

import { defaultAnglePrompt } from "./prompts";
import { defaultCopyPrompt } from "./copy";
import { defaultCopyModel } from "./copy-models";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
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
  approvedAiCount: number; // of the 4 AI-eligible angles
  copyStatus: "none" | "draft" | "approved";
  targets: { portal: PortalKey; enabled: boolean; state: TargetState }[];
  gates: Record<PortalKey, { ready: boolean; blockers: string[] }>;
  thumb: string | null;
  wholesalePriceSet: boolean;
  notifyCount: number; // open back-in-stock requests (Stage 9)
}

export async function loadBoard(): Promise<BoardRow[]> {
  const admin = createAdminClient();
  const [designs, angles, generatedAngleIds, copies, targets, products, notifies] = await Promise.all([
    fetchAll<{ id: string; base_sku: string; color: string; title: string | null; category: string | null; tier: "standard" | "hero"; specs_verified: boolean }>(
      admin, "designs", "id, base_sku, color, title, category, tier, specs_verified"),
    fetchAll<{ id: string; design_id: string; angle: Angle; approved_image_id: string | null; source_ref: string | null }>(
      admin, "design_angles", "id, design_id, angle, approved_image_id, source_ref"),
    fetchAll<{ angle_id: string }>(admin, "design_images", "angle_id", (q) => q.eq("status", "active")),
    fetchAll<{ design_id: string; status: "none" | "draft" | "approved" }>(admin, "design_copy", "design_id, status"),
    fetchAll<{ design_id: string; portal: PortalKey; enabled: boolean; state: TargetState }>(
      admin, "publish_targets", "design_id, portal, enabled, state"),
    fetchAll<{ sku: string; wholesale_price: number; image_urls: string[] | null }>(
      admin, "wholesale_products", "sku, wholesale_price, image_urls"),
    fetchAll<{ sku_base: string; color: string }>(admin, "notify_me", "sku_base, color", (q) => q.is("fulfilled_at", null)),
  ]);
  const notifyByGroup = new Map<string, number>();
  for (const n of notifies) {
    const key = `${n.sku_base.toUpperCase()}|${n.color.toUpperCase()}`;
    notifyByGroup.set(key, (notifyByGroup.get(key) ?? 0) + 1);
  }

  const reviewAngles = new Set(generatedAngleIds.map((c) => c.angle_id));
  const anglesByDesign = new Map<string, typeof angles>();
  for (const a of angles) {
    const list = anglesByDesign.get(a.design_id) ?? [];
    list.push(a);
    anglesByDesign.set(a.design_id, list);
  }
  const copyByDesign = new Map(copies.map((c) => [c.design_id, c.status]));
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

  return designs.map((d) => {
    const key = `${d.base_sku}|${d.color}`;
    const dAngles = anglesByDesign.get(d.id) ?? [];
    const approvedAngles: Partial<Record<Angle, boolean>> = {};
    const review: Partial<Record<Angle, boolean>> = {};
    for (const a of dAngles) {
      if (a.approved_image_id) approvedAngles[a.angle] = true;
      if (reviewAngles.has(a.id)) review[a.angle] = true;
    }
    const input: DesignStateInput = {
      specsVerified: d.specs_verified,
      approvedAngles,
      reviewAngles: review,
      copyStatus: copyByDesign.get(d.id) ?? "none",
      targets: targetsByDesign.get(d.id) ?? [],
      wholesalePriceSet: priceSet.has(key),
      tier: d.tier,
    };
    const { badge, portals } = deriveBadge(input);
    return {
      id: d.id,
      baseSku: d.base_sku,
      color: d.color,
      title: d.title,
      category: d.category,
      tier: d.tier,
      specsVerified: d.specs_verified,
      badge,
      badgeLabel: badgeLabelWithPortals(badge, portals),
      approvedAiCount: (["front", "back", "side", "lifestyle"] as Angle[]).filter((a) => approvedAngles[a]).length,
      copyStatus: input.copyStatus,
      targets: input.targets,
      gates: {
        wholesale: gateFor("wholesale", input),
        shopify: gateFor("shopify", input),
      },
      thumb: groupThumb.get(key) ?? null,
      wholesalePriceSet: input.wholesalePriceSet,
      notifyCount: notifyByGroup.get(key.toUpperCase()) ?? 0,
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
  engine: "fashn" | "openai_bg" | "raw" | "seedream";
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
  const rows = await loadBoard();
  const board = rows.find((r) => r.id === designId);
  if (!board) return null;
  const admin = createAdminClient();
  const [{ data: angles }, { data: jobs }, { data: copyRow }, { data: poolRows }, { data: designRow }] = await Promise.all([
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
    admin.from("designs").select("ident_image_id, drive_folder_id, title, category, sub_category, color, fabric, handwork, origin, tier").eq("id", designId).maybeSingle(),
  ]);
  const promptDesign = {
    title: designRow?.title, category: designRow?.category, subCategory: designRow?.sub_category,
    color: designRow?.color, fabric: designRow?.fabric, handwork: designRow?.handwork,
    origin: designRow?.origin, tier: designRow?.tier,
  };
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
