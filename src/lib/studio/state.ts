// Studio derived state (build guide §7.2) — ONE implementation used by the
// board, its filter chips, the cockpit inbox and (Stage 7) the publish gates.
// Pure functions over plain inputs: no imports from server-only modules so
// both server components and unit tests can consume it.
//
// 17 Sep (owner): the approval step is no longer a gate. A slot counts the
// moment it holds an EFFECTIVE image — the approved candidate if one exists,
// else the angle's source. A human still looks before pushing; the push
// itself stays a manual act, which is where that control lives now.

export const AI_ANGLES = ["front", "back", "side", "lifestyle"] as const;
export const DETAIL_ANGLES = ["detail_1", "detail_2"] as const;
export const ALL_ANGLES = [...AI_ANGLES, ...DETAIL_ANGLES] as const;
export type Angle = (typeof ALL_ANGLES)[number];

export type PortalKey = "wholesale" | "shopify";
export type TargetState = "not_ready" | "ready" | "pushing" | "live" | "changes_pending" | "error";

export interface DesignStateInput {
  specsVerified: boolean;
  /** angle -> has an effective image (approved candidate, else a source) */
  filledAngles: Partial<Record<Angle, boolean>>;
  /** angle -> has a generated/imported candidate that nobody has looked at */
  reviewAngles?: Partial<Record<Angle, boolean>>;
  copyStatus: "none" | "draft" | "approved";
  /** copy exists with a non-empty title AND description — draft is enough */
  copyPresent: boolean;
  targets: { portal: PortalKey; enabled: boolean; state: TargetState }[];
  /** from wholesale_products for the group */
  wholesalePriceSet: boolean;
  tier: "standard" | "hero" | null;
  /** designs.origin — 'drevi_original' | 'curated' | null. Shopify only. */
  origin?: string | null;
  /** designs.discontinued_at is set (0063). Blocks BOTH portals. */
  discontinued?: boolean;
  /** mrp_override ?? auto_mrp is a real number > 0. Shopify only. */
  retailPriceSet?: boolean;
}

// Retiring a product and then publishing it are contradictory acts, and until
// this blocker existed the second silently undid the first: publishWholesale
// writes buyer_visible: true for every size, which is the exact flag
// setDiscontinued clears, so a retired garment went back in the buyer catalog
// with discontinued_at still set and the board still hiding it. Reachable from
// the board with "Show discontinued" on and Select-all, and nothing on screen
// said so.
//
// It belongs in the GATE rather than in the two publish functions because the
// gate is what the board, the batch routes and the workbench button all already
// consult — one blocker disables the button, makes the bulk route count the
// design as `blocked` instead of pushing it, and covers whatever calls it next.
const DISCONTINUED_BLOCKER = "Discontinued — restore it first";

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

// Wholesale gate: ≥1 filled slot AND a wholesale price on the group.
export function wholesaleGate(s: DesignStateInput): GateResult {
  const blockers: string[] = [];
  if (s.discontinued) blockers.push(DISCONTINUED_BLOCKER);
  if (!Object.values(s.filledAngles).some(Boolean)) blockers.push("No image yet");
  if (!s.wholesalePriceSet) blockers.push("Wholesale price not set");
  return { ready: blockers.length === 0, blockers };
}

// Shopify gate: front + back filled AND copy present AND tier set AND origin
// set. Copy no longer needs the approved stamp — a real draft (title AND
// description) publishes; whoever pushes reads it on the way.
//
// ORIGIN (Ansh, 22 Sep: "why did you allow products to show as 'Ready' when
// the origin was not set ... Now that this feeds into shopify directly: It
// must be set"). He is right, and the gate simply predates the dependency:
// origin started picking the Shopify size ladder on 19-20 Sep and nothing came
// back to close the gate behind it. Without origin a product is pushed in only
// the sizes physically in stock — which is how 21 of 103 products reached the
// store listed in a single size — and custom.origin is omitted, which the
// product page keys size behaviour, pricing tiers and payment terms off.
//
// Wholesale is deliberately NOT gated on it: nothing in the wholesale push
// reads origin, and blocking that would stop a garment going on sale over a
// field it does not use.
export function shopifyGate(s: DesignStateInput): GateResult {
  const blockers: string[] = [];
  if (s.discontinued) blockers.push(DISCONTINUED_BLOCKER);
  if (!s.filledAngles.front) blockers.push("Front image missing");
  if (!s.filledAngles.back) blockers.push("Back image missing");
  if (!s.copyPresent) blockers.push("Copy not written");
  if (!s.tier) blockers.push("Tier not set");
  if (!(s.origin ?? "").trim()) blockers.push("Origin not set");
  // Ansh, 23 Sep: "I also saw a product being shown as ready(SH) even though
  // it had no price set."
  //
  // Nothing gated on it, and the push reads
  // `Number(mrp_override ?? auto_mrp ?? 0)` — so a design with no price read
  // READY and would have created a Shopify product priced at 0.00, on every
  // size. Four designs on prod were in exactly that state, none of them
  // pushed yet.
  //
  // The wholesale gate has always checked its own price; this is the same
  // check the other side of the house was missing.
  if (!s.retailPriceSet) blockers.push("Retail price not set");
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

  const anyFilled = Object.values(s.filledAngles).some(Boolean);
  const anyInReview = Object.values(s.reviewAngles ?? {}).some(Boolean);
  // needs_photos = zero slots filled. A candidate implies its angle had a
  // source (so it is filled) — the 0-filled in_review arm survives only for
  // legacy rows whose candidate outlived its source.
  if (!anyFilled && !anyInReview) return { badge: "needs_photos", portals: [] };
  if (!anyFilled) return { badge: "in_review", portals: [] };

  const readyPortals = enabled.filter((t) => gateFor(t.portal, s).ready).map((t) => t.portal);
  if (readyPortals.length > 0) return { badge: "ready", portals: readyPortals };

  // Photos exist but no portal is ready — copy is the usual missing piece;
  // otherwise something still needs a look or a price before pushing.
  if (!s.copyPresent) return { badge: "needs_copy", portals: [] };
  return { badge: "in_review", portals: [] };
}

export function badgeLabelWithPortals(badge: DesignBadge, portals: PortalKey[]): string {
  const label = BADGE_LABEL[badge];
  if ((badge === "ready" || badge === "live" || badge === "changes_pending") && portals.length > 0) {
    return `${label} · ${portals.map((p) => (p === "wholesale" ? "WS" : "SH")).join(" ")}`;
  }
  return label;
}
