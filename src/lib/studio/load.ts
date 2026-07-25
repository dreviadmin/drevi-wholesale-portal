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
}

export async function loadBoard(): Promise<BoardRow[]> {
  const admin = createAdminClient();
  const [designs, angles, generatedAngleIds, copies, targets, products] = await Promise.all([
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
  ]);

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
    };
  });
}
