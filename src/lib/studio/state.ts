// Studio derived state (build guide §7.2) — ONE implementation used by the
// board, its filter chips, the cockpit inbox and (Stage 7) the publish gates.
// Pure functions over plain inputs: no imports from server-only modules so
// both server components and unit tests can consume it.

export const AI_ANGLES = ["front", "back", "side", "lifestyle"] as const;
export const DETAIL_ANGLES = ["detail_1", "detail_2"] as const;
export const ALL_ANGLES = [...AI_ANGLES, ...DETAIL_ANGLES] as const;
export type Angle = (typeof ALL_ANGLES)[number];

export type PortalKey = "wholesale" | "shopify";
export type TargetState = "not_ready" | "ready" | "pushing" | "live" | "changes_pending" | "error";

export interface DesignStateInput {
  specsVerified: boolean;
  /** angle -> has an approved candidate */
  approvedAngles: Partial<Record<Angle, boolean>>;
  /** angle -> has at least one candidate awaiting review (status 'generated') */
  reviewAngles?: Partial<Record<Angle, boolean>>;
  copyStatus: "none" | "draft" | "approved";
  targets: { portal: PortalKey; enabled: boolean; state: TargetState }[];
  /** from wholesale_products for the group */
  wholesalePriceSet: boolean;
  tier: "standard" | "hero" | null;
}

export type DesignBadge =
  | "awaiting_specs"
  | "needs_photos"
  | "in_review"
  | "needs_copy"
  | "ready"
  | "live"
  | "changes_pending";

export const BADGE_LABEL: Record<DesignBadge, string> = {
  awaiting_specs: "Awaiting specs",
  needs_photos: "Needs photos",
  in_review: "In review",
  needs_copy: "Needs copy",
  ready: "Ready",
  live: "Live",
  changes_pending: "Changes pending",
};

export interface GateResult {
  ready: boolean;
  blockers: string[];
}

// Wholesale gate: ≥1 approved image AND a wholesale price on the group.
export function wholesaleGate(s: DesignStateInput): GateResult {
  const blockers: string[] = [];
  if (!Object.values(s.approvedAngles).some(Boolean)) blockers.push("No approved image yet");
  if (!s.wholesalePriceSet) blockers.push("Wholesale price not set");
  return { ready: blockers.length === 0, blockers };
}

// Shopify gate: front + back approved AND copy approved AND tier set.
export function shopifyGate(s: DesignStateInput): GateResult {
  const blockers: string[] = [];
  if (!s.approvedAngles.front) blockers.push("Front image not approved");
  if (!s.approvedAngles.back) blockers.push("Back image not approved");
  if (s.copyStatus !== "approved") blockers.push("Copy not approved");
  if (!s.tier) blockers.push("Tier not set");
  return { ready: blockers.length === 0, blockers };
}

export function gateFor(portal: PortalKey, s: DesignStateInput): GateResult {
  return portal === "wholesale" ? wholesaleGate(s) : shopifyGate(s);
}

// The board badge — the design's single most-actionable state, in pipeline
// order (§7.2): Awaiting specs → Needs photos → In review → Needs copy →
// Ready · <portal> → Live · <portals> → Changes pending.
export function deriveBadge(s: DesignStateInput): { badge: DesignBadge; portals: PortalKey[] } {
  const enabled = s.targets.filter((t) => t.enabled);
  if (enabled.some((t) => t.state === "changes_pending")) {
    return { badge: "changes_pending", portals: enabled.filter((t) => t.state === "changes_pending").map((t) => t.portal) };
  }
  const livePortals = enabled.filter((t) => t.state === "live").map((t) => t.portal);
  if (livePortals.length > 0) return { badge: "live", portals: livePortals };

  if (!s.specsVerified) return { badge: "awaiting_specs", portals: [] };

  const anyApproved = Object.values(s.approvedAngles).some(Boolean);
  const anyInReview = Object.values(s.reviewAngles ?? {}).some(Boolean);
  if (!anyApproved && !anyInReview) return { badge: "needs_photos", portals: [] };
  if (!anyApproved && anyInReview) return { badge: "in_review", portals: [] };

  const readyPortals = enabled.filter((t) => gateFor(t.portal, s).ready).map((t) => t.portal);
  if (readyPortals.length > 0) return { badge: "ready", portals: readyPortals };

  // Photos exist but no portal is ready — copy is the usual missing piece.
  if (s.copyStatus !== "approved") return { badge: "needs_copy", portals: [] };
  return { badge: "in_review", portals: [] };
}

export function badgeLabelWithPortals(badge: DesignBadge, portals: PortalKey[]): string {
  const label = BADGE_LABEL[badge];
  if ((badge === "ready" || badge === "live" || badge === "changes_pending") && portals.length > 0) {
    return `${label} · ${portals.map((p) => (p === "wholesale" ? "WS" : "SH")).join(" ")}`;
  }
  return label;
}
