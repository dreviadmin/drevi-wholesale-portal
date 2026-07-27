import "server-only";

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
    fetchAll<{ id: string; design_id: string; angle: Angle; approved_candidate_id: string | null; source_ref: string | null }>(
      admin, "design_angles", "id, design_id, angle, approved_candidate_id, source_ref"),
    fetchAll<{ angle_id: string }>(admin, "image_candidates", "angle_id", (q) => q.eq("status", "generated")),
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
      if (a.approved_candidate_id) approvedAngles[a.angle] = true;
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
      approvedAiCount: (["front", "back", "side", "closeup"] as Angle[]).filter((a) => approvedAngles[a]).length,
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
  approvedCandidateId: string | null;
  candidates: { id: string; engine: string; fileRef: string; status: string; createdAt: string; costCredits: number }[];
}

export interface CopyDetail { title: string; description: string; tags: Record<string, string>; status: "none" | "draft" | "approved"; model: string | null; editedBy: string | null; approvedBy: string | null }

export async function loadDesignDetail(designId: string): Promise<{ board: BoardRow; angles: AngleDetail[]; copy: CopyDetail | null; activeJobs: { angleId: string | null; type: string; status: string; progress: number }[] } | null> {
  const rows = await loadBoard();
  const board = rows.find((r) => r.id === designId);
  if (!board) return null;
  const admin = createAdminClient();
  const [{ data: angles }, { data: jobs }, { data: copyRow }] = await Promise.all([
    admin
      .from("design_angles")
      // Two FKs link these tables (angle_id + approved_candidate_id) — the
      // !angle_id hint picks the one-to-many history relation.
      .select("id, angle, source_ref, prompt, prompt_edited_by_human, engine, approved_candidate_id, image_candidates!angle_id(id, engine, file_ref, status, created_at, cost_credits)")
      .eq("design_id", designId),
    admin
      .from("pipeline_jobs")
      .select("angle_id, type, status, progress")
      .eq("design_id", designId)
      .in("status", ["queued", "claimed", "running"]),
    admin.from("design_copy").select("title, description, tags, status, model, edited_by, approved_by").eq("design_id", designId).maybeSingle(),
  ]);
  const order: Record<string, number> = { front: 0, back: 1, side: 2, closeup: 3, detail_1: 4, detail_2: 5 };
  return {
    board,
    copy: copyRow
      ? { title: copyRow.title ?? "", description: copyRow.description ?? "", tags: (copyRow.tags as Record<string, string>) ?? {}, status: copyRow.status, model: copyRow.model, editedBy: copyRow.edited_by, approvedBy: copyRow.approved_by }
      : null,
    angles: (angles ?? [])
      .map((a) => ({
        id: a.id,
        angle: a.angle as Angle,
        sourceRef: a.source_ref,
        prompt: a.prompt ?? "",
        promptEditedByHuman: a.prompt_edited_by_human,
        engine: a.engine as AngleDetail["engine"],
        approvedCandidateId: a.approved_candidate_id,
        candidates: ((a.image_candidates as { id: string; engine: string; file_ref: string; status: string; created_at: string; cost_credits: number }[] | null) ?? [])
          .map((c) => ({ id: c.id, engine: c.engine, fileRef: c.file_ref, status: c.status, createdAt: c.created_at, costCredits: Number(c.cost_credits ?? 0) }))
          .sort((x, y) => y.createdAt.localeCompare(x.createdAt)),
      }))
      .sort((x, y) => order[x.angle] - order[y.angle]),
    activeJobs: (jobs ?? []).map((j) => ({ angleId: j.angle_id, type: j.type, status: j.status, progress: j.progress })),
  };
}
