import { describe, it, expect } from "vitest";
import {
  computeAvailability,
  toBuyerAvailability,
  productionMoqFlag,
  supplyAge,
  BUYER_AVAILABILITY_KEYS,
  type SupplyInput,
} from "./availability";

const base = { handlingDays: 2, bufferDays: 3, limitedThreshold: 5, buyerMoq: 1 };
const supply = (o: Partial<SupplyInput> = {}): SupplyInput => ({
  supplyMode: "", vendorStockQty: null, makingDays: null, deliveryDays: null,
  makingMoq: null, supplyUpdatedAt: null, ...o,
});

describe("computeAvailability (§9.1)", () => {
  it("in stock when our own stock covers the buyer MOQ", () => {
    expect(computeAvailability({ ...base, ourStock: 20, supply: supply() })).toEqual({
      state: "in_stock", label: "In stock", orderable: true,
    });
  });

  it("limited shows the count left", () => {
    const a = computeAvailability({ ...base, ourStock: 3, supply: supply() });
    expect(a.state).toBe("limited");
    expect(a.label).toBe("Limited · 3 left");
    expect(a.remaining).toBe(3);
    expect(a.orderable).toBe(true);
  });

  it("on-order (ready stock) = delivery + handling + buffer", () => {
    const a = computeAvailability({
      ...base, ourStock: 0,
      supply: supply({ supplyMode: "ready_stock", vendorStockQty: 40, deliveryDays: 4 }),
    });
    expect(a.state).toBe("on_order_ready");
    expect(a.etaDays).toBe(9);
    expect(a.label).toBe("Available on order · ~9 days");
  });

  it("made to order = making + delivery + handling + buffer", () => {
    const a = computeAvailability({
      ...base, ourStock: 0,
      supply: supply({ supplyMode: "made_to_order", makingDays: 12, deliveryDays: 4 }),
    });
    expect(a.state).toBe("made_to_order");
    expect(a.etaDays).toBe(21);
  });

  it("'both' prefers the ready-stock path when the vendor has stock", () => {
    const a = computeAvailability({
      ...base, ourStock: 0,
      supply: supply({ supplyMode: "both", vendorStockQty: 10, makingDays: 12, deliveryDays: 4 }),
    });
    expect(a.state).toBe("on_order_ready");
    expect(a.etaDays).toBe(9);
  });

  it("'both' with no vendor stock falls to the made-to-order path", () => {
    const a = computeAvailability({
      ...base, ourStock: 0,
      supply: supply({ supplyMode: "both", vendorStockQty: 0, makingDays: 12, deliveryDays: 4 }),
    });
    expect(a.state).toBe("made_to_order");
    expect(a.etaDays).toBe(21);
  });

  it("drops the day count when any input is missing — never a number we cannot support", () => {
    const a = computeAvailability({
      ...base, ourStock: 0,
      supply: supply({ supplyMode: "made_to_order", makingDays: null, deliveryDays: 4 }),
    });
    expect(a.state).toBe("made_to_order");
    expect(a.etaDays).toBeUndefined();
    expect(a.label).toBe("Made to order");
    expect(a.label).not.toMatch(/\d/);
  });

  // §13.6 — the acceptance example, with its exact numbers.
  it("acceptance §13.6: making 12 + delivery 3 at default handling 2 and buffer 3 reads ~20 days", () => {
    const withDays = computeAvailability({
      ...base, ourStock: 0,
      supply: supply({ supplyMode: "made_to_order", makingDays: 12, deliveryDays: 3 }),
    });
    expect(withDays.label).toBe("Made to order · ~20 days");
    expect(withDays.orderable).toBe(true);

    const withoutMaking = computeAvailability({
      ...base, ourStock: 0,
      supply: supply({ supplyMode: "made_to_order", makingDays: null, deliveryDays: 3 }),
    });
    expect(withoutMaking.label).toBe("Made to order");
    expect(withoutMaking.etaDays).toBeUndefined();
    expect(JSON.stringify(withoutMaking)).not.toMatch(/\d/);
  });

  it("sold out when there is no usable supply data", () => {
    const a = computeAvailability({ ...base, ourStock: 0, supply: supply({ supplyMode: "ready_stock", vendorStockQty: 0 }) });
    expect(a).toEqual({ state: "sold_out", label: "Sold out", orderable: false });
  });

  it("discontinued is never orderable, even with stock on the shelf", () => {
    const a = computeAvailability({ ...base, ourStock: 30, supply: supply({ supplyMode: "discontinued" }) });
    expect(a).toEqual({ state: "discontinued", label: "No longer available", orderable: false });
  });

  it("always approximates — no hard dates", () => {
    const a = computeAvailability({
      ...base, ourStock: 0,
      supply: supply({ supplyMode: "made_to_order", makingDays: 12, deliveryDays: 4 }),
    });
    expect(a.label).toContain("~");
    expect(a.label).not.toMatch(/\d{4}|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/);
  });
});

// §9.2 — the firewall. Same spirit as the cost-leak tests: serialise what a
// buyer would receive and fail on ANY supply field beyond the five allowed.
describe("buyer firewall (§9.2)", () => {
  const secret: SupplyInput = {
    supplyMode: "both",
    vendorStockQty: 40,
    makingDays: 12,
    deliveryDays: 4,
    makingMoq: 10,
    supplyUpdatedAt: "2026-06-01T00:00:00Z",
  };

  it("leaks nothing beyond state, label, etaDays, orderable, remaining", () => {
    for (const ourStock of [0, 3, 50]) {
      const a = toBuyerAvailability(computeAvailability({ ...base, ourStock, supply: secret }));
      expect(Object.keys(a).every((k) => (BUYER_AVAILABILITY_KEYS as readonly string[]).includes(k))).toBe(true);
    }
  });

  it("never serialises vendor stock, making MOQ, the day components, or the supply note", () => {
    const json = JSON.stringify(
      toBuyerAvailability(computeAvailability({ ...base, ourStock: 0, supply: { ...secret, supplyMode: "made_to_order" } })),
    );
    for (const forbidden of ["vendorStockQty", "vendor_stock_qty", "makingMoq", "making_moq", "makingDays", "making_days", "deliveryDays", "delivery_days", "supplyNote", "supply_note", "vendor", "cost"]) {
      expect(json).not.toContain(forbidden);
    }
    // The separate components must not be derivable either: only the SUM ships.
    const parsed = JSON.parse(json);
    expect(parsed.etaDays).toBe(21);
    expect(json).not.toContain('"12"');
    expect(Object.values(parsed)).not.toContain(12);
    expect(Object.values(parsed)).not.toContain(10);
  });

  it("strips anything an upstream caller bolted on", () => {
    const dirty = {
      ...computeAvailability({ ...base, ourStock: 0, supply: secret }),
      vendorStockQty: 40, makingMoq: 10, supplyNote: "Rakesh's cousin in Surat",
    } as never;
    const clean = toBuyerAvailability(dirty);
    expect(Object.keys(clean).sort()).toEqual(["etaDays", "label", "orderable", "state"]);
  });
});

describe("production MOQ flag (§9.3) — admin only", () => {
  const s = supply({ supplyMode: "made_to_order", makingMoq: 10, makingDays: 12, deliveryDays: 4 });

  it("flags an order below the vendor's minimum run", () => {
    const f = productionMoqFlag({ ourStock: 0, qty: 3, supply: s });
    expect(f?.shortfall).toBe(7);
    expect(f?.message).toBe("Below vendor production minimum — order is 3 pcs, vendor makes minimum 10. Aggregate with other orders or absorb 7.");
  });

  it("stays quiet when we have stock, when the qty clears the minimum, or when there is no made-to-order path", () => {
    expect(productionMoqFlag({ ourStock: 5, qty: 3, supply: s })).toBeNull();
    expect(productionMoqFlag({ ourStock: 0, qty: 10, supply: s })).toBeNull();
    expect(productionMoqFlag({ ourStock: 0, qty: 3, supply: supply({ supplyMode: "ready_stock", makingMoq: 10 }) })).toBeNull();
    expect(productionMoqFlag({ ourStock: 0, qty: 3, supply: supply({ supplyMode: "made_to_order" }) })).toBeNull();
  });
});

describe("supply staleness (§9.4)", () => {
  it("reads as relative age", () => {
    const d = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    expect(supplyAge(null)).toBeNull();
    expect(supplyAge(d(0))?.label).toBe("updated today");
    expect(supplyAge(d(1))?.label).toBe("updated yesterday");
    expect(supplyAge(d(5))?.label).toBe("updated 5 days ago");
    expect(supplyAge(d(21))?.label).toBe("updated 3 weeks ago");
    expect(supplyAge(d(90))?.label).toBe("updated 3 months ago");
  });
});
