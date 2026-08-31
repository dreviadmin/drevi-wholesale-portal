// Retrofit R7 (spec v1.3 §9) — the ONE availability implementation.
//
// Buyer cards, product pages, cart and admin previews all call
// computeAvailability. There is no second copy anywhere: a promise shown in
// two places must be the same promise.
//
// §9.2 firewall: the object that crosses to a buyer carries only state, label,
// etaDays, orderable and remaining. Vendor identity, vendor_stock_qty,
// making_moq, the separate day components, cost and supply_note never leave
// the admin side — not as fields, and not as anything a buyer could derive.

export type SupplyMode = "ready_stock" | "made_to_order" | "both" | "discontinued" | "" | null;

export interface SupplyInput {
  supplyMode: SupplyMode;
  vendorStockQty: number | null;
  makingDays: number | null;
  deliveryDays: number | null;
  /** Internal only — informs Rakesh's buyer MOQ, never a buyer message (§9.2). */
  makingMoq: number | null;
  supplyUpdatedAt: string | null;
}

export type AvailabilityState =
  | "in_stock"
  | "limited"
  | "on_order_ready"
  | "made_to_order"
  | "sold_out"
  | "discontinued";

/** Exactly the five keys allowed to cross to a buyer (§9.2). */
export interface Availability {
  state: AvailabilityState;
  label: string;
  etaDays?: number;
  orderable: boolean;
  remaining?: number;
}

export const BUYER_AVAILABILITY_KEYS = ["state", "label", "etaDays", "orderable", "remaining"] as const;

export interface AvailabilityInput {
  ourStock: number;
  /** Reserved for future restock signals; never affects the buyer-facing shape. */
  restockable?: boolean;
  supply: SupplyInput;
  buyerMoq: number;
  handlingDays: number;
  bufferDays: number;
  limitedThreshold: number;
}

const n = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);

/**
 * Sum lead-time components. If ANY required component is missing we return
 * null and the caller drops the day count — never render a number you cannot
 * support (§9.1).
 */
function eta(parts: (number | null)[]): number | undefined {
  let total = 0;
  for (const p of parts) {
    if (p === null) return undefined;
    total += p;
  }
  return Math.max(1, Math.round(total));
}

/** "~18 days", never a hard date. */
function days(d: number | undefined): string {
  return d === undefined ? "" : ` · ~${d} days`;
}

export function computeAvailability(input: AvailabilityInput): Availability {
  const { ourStock, supply, buyerMoq, handlingDays, bufferDays, limitedThreshold } = input;
  const mode = supply.supplyMode ?? "";
  const stock = Math.max(0, Number(ourStock) || 0);
  const moq = Math.max(1, Number(buyerMoq) || 1);

  // Discontinued wins over everything — including stock on the shelf, because
  // the design is being retired and should not be re-promised.
  if (mode === "discontinued") {
    return { state: "discontinued", label: "No longer available", orderable: false };
  }

  if (stock >= moq) {
    // "Limited" is about a thin shelf, not about failing the MOQ.
    if (stock < limitedThreshold) {
      return { state: "limited", label: `Limited · ${stock} left`, orderable: true, remaining: stock };
    }
    return { state: "in_stock", label: "In stock", orderable: true };
  }

  if (stock > 0 && stock < limitedThreshold) {
    // Some on the shelf but under the buyer's MOQ: still orderable, and the
    // count is the honest thing to show.
    return { state: "limited", label: `Limited · ${stock} left`, orderable: true, remaining: stock };
  }

  const vendorQty = n(supply.vendorStockQty);
  const making = n(supply.makingDays);
  const delivery = n(supply.deliveryDays);
  const readyPath = (mode === "ready_stock" || mode === "both") && (vendorQty ?? 0) > 0;
  const madePath = mode === "made_to_order" || mode === "both";

  // 'both' prefers the ready-stock path — it is the faster promise.
  if (readyPath) {
    const d = eta([delivery, handlingDays, bufferDays]);
    return { state: "on_order_ready", label: `Available on order${days(d)}`, ...(d !== undefined ? { etaDays: d } : {}), orderable: true };
  }

  if (madePath) {
    const d = eta([making, delivery, handlingDays, bufferDays]);
    return { state: "made_to_order", label: `Made to order${days(d)}`, ...(d !== undefined ? { etaDays: d } : {}), orderable: true };
  }

  return { state: "sold_out", label: "Sold out", orderable: false };
}

/**
 * Belt-and-braces for the firewall: strip anything that is not one of the five
 * allowed keys. Any buyer-facing serialiser should pass through this.
 */
export function toBuyerAvailability(a: Availability): Availability {
  const out: Availability = { state: a.state, label: a.label, orderable: a.orderable };
  if (a.etaDays !== undefined) out.etaDays = a.etaDays;
  if (a.remaining !== undefined) out.remaining = a.remaining;
  return out;
}

/** §9.4 — "updated 3 weeks ago", shown next to the block wherever it appears. */
export function supplyAge(updatedAt: string | null): { days: number; label: string } | null {
  if (!updatedAt) return null;
  const then = new Date(updatedAt).getTime();
  if (!Number.isFinite(then)) return null;
  const d = Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
  if (d === 0) return { days: 0, label: "updated today" };
  if (d === 1) return { days: 1, label: "updated yesterday" };
  if (d < 14) return { days: d, label: `updated ${d} days ago` };
  if (d < 60) return { days: d, label: `updated ${Math.round(d / 7)} weeks ago` };
  return { days: d, label: `updated ${Math.round(d / 30)} months ago` };
}

/**
 * §9.3 — admin-only decision support on order review. Never blocks
 * confirmation; it surfaces the real commercial choice.
 */
export function productionMoqFlag(args: {
  ourStock: number;
  qty: number;
  supply: SupplyInput;
}): { qty: number; makingMoq: number; shortfall: number; message: string } | null {
  const mode = args.supply.supplyMode ?? "";
  const madePath = mode === "made_to_order" || mode === "both";
  const moq = n(args.supply.makingMoq);
  if (args.ourStock > 0 || !madePath || !moq || moq <= 0) return null;
  if (args.qty >= moq) return null;
  const shortfall = moq - args.qty;
  return {
    qty: args.qty,
    makingMoq: moq,
    shortfall,
    message: `Below vendor production minimum — order is ${args.qty} pcs, vendor makes minimum ${moq}. Aggregate with other orders or absorb ${shortfall}.`,
  };
}
