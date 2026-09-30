import { describe, it, expect } from "vitest";
import type { Movement, MovementReason } from "./stock-ledger-core";
import { planReceiptReversal, sameLines, nextFirstReceipt, skuInDesign, RECEIPT_LINE_REF, type ReversalInput, type CatalogRow } from "./receipt-reversal";

const NEW = "DD-LEH-FLR-126-M-RED"; // born in the mistaken delivery
const OLD = "DD-LEH-FLR-040-L-GRN"; // a sheet-era product, restocked

let seq = 0;
function mv(sku: string, reason: MovementReason, opts: { delta?: number; snapshot?: number; day: number; hour?: number; line?: string; refType?: string; note?: string }): Movement {
  return {
    id: `m${seq++}`,
    sku,
    delta: opts.delta ?? 0,
    snapshot_qty: opts.snapshot ?? null,
    reason,
    ref_type: opts.line ? RECEIPT_LINE_REF : opts.refType ?? null,
    ref_id: opts.line ?? null,
    note: opts.note ?? null,
    created_by: null,
    created_at: `2026-09-${String(opts.day).padStart(2, "0")}T${String(opts.hour ?? 10).padStart(2, "0")}:00:00.000Z`,
  };
}
const received = (sku: string, line: string, qty: number, day = 30) => mv(sku, "receipt", { delta: qty, day, line });
const sold = (sku: string, qty: number, day = 30, note = "Order DX-20260930-004 confirmed") =>
  mv(sku, "order", { delta: -qty, day, hour: 12, refType: "order", note });
const counted = (sku: string, qty: number, day: number) => mv(sku, "reset", { snapshot: qty, day, hour: 11 });

const app = (sku: string, extra: Partial<CatalogRow> = {}): CatalogRow => ({ sku, wholesale_visible: true, buyer_visible: false, ...extra });

function input(over: Partial<ReversalInput>): ReversalInput {
  return {
    mode: "delete",
    receiptNumber: "GR-20260930-002",
    oldLines: [],
    movements: [],
    otherReceiptSkus: [],
    documents: new Map(),
    catalog: [],
    ...over,
  };
}

function plan(over: Partial<ReversalInput>) {
  const d = planReceiptReversal(input(over));
  if (!d.ok) throw new Error(`expected a plan, got refusal: ${d.error}`);
  return d.plan;
}

describe("deleting a receipt takes its stock back out", () => {
  it("reverses each line's receipt movement and withdraws a SKU born there", () => {
    const p = plan({
      oldLines: [{ id: "L1", sku: NEW, qty: 3 }],
      movements: [received(NEW, "L1", 3)],
      catalog: [app(NEW)],
    });
    expect(p.reversals).toEqual([{ lineId: "L1", sku: NEW, qty: 3 }]);
    expect(p.withdraw).toEqual([NEW]);
    expect(p.notes).toEqual([]);
  });

  it("reverses nothing for a record-only receipt that never posted stock", () => {
    const p = plan({
      oldLines: [{ id: "L1", sku: OLD, qty: 5 }],
      movements: [counted(OLD, 1, 14)],
      catalog: [app(OLD, { shopify_live_url: "https://drevifashion.com/products/x" })],
    });
    expect(p.reversals).toEqual([]);
    expect(p.withdraw).toEqual([]);
  });

  it("is idempotent — a retry after a half-finished delete reverses nothing twice", () => {
    const p = plan({
      oldLines: [{ id: "L1", sku: NEW, qty: 3 }],
      movements: [received(NEW, "L1", 3), mv(NEW, "receipt_reversed", { delta: -3, day: 30, hour: 13, line: "L1" })],
      catalog: [app(NEW)],
    });
    expect(p.reversals).toEqual([]);
    expect(p.withdraw).toEqual([NEW]); // the hide is re-applied, harmlessly
  });

  it("adds up two lines of the same SKU", () => {
    const p = plan({
      oldLines: [{ id: "L1", sku: NEW, qty: 2 }, { id: "L2", sku: NEW, qty: 1 }],
      movements: [received(NEW, "L1", 2), received(NEW, "L2", 1)],
      catalog: [app(NEW)],
    });
    expect(p.reversals.map((r) => r.qty)).toEqual([2, 1]);
    expect(p.withdraw).toEqual([NEW]);
  });

  it("matches SKUs case-insensitively", () => {
    const p = plan({
      oldLines: [{ id: "L1", sku: NEW.toLowerCase(), qty: 1 }],
      movements: [received(NEW, "L1", 1)],
      catalog: [app(NEW)],
    });
    expect(p.reversals).toEqual([{ lineId: "L1", sku: NEW, qty: 1 }]);
    expect(p.withdraw).toEqual([NEW]);
  });
});

describe("refuses when received pieces have been sold or moved", () => {
  it("refuses when taking the pieces back would leave the SKU below zero", () => {
    const d = planReceiptReversal(input({
      oldLines: [{ id: "L1", sku: NEW, qty: 3 }],
      movements: [received(NEW, "L1", 3), sold(NEW, 2)],
      catalog: [app(NEW)],
    }));
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.error).toContain("Can't delete GR-20260930-002");
    expect(d.error).toContain(`${NEW}: 2 of the 3 pieces this receipt brought in have already left stock`);
    expect(d.error).toContain("Order DX-20260930-004 confirmed");
  });

  it("names a retail sale the same way", () => {
    const d = planReceiptReversal(input({
      oldLines: [{ id: "L1", sku: NEW, qty: 1 }],
      movements: [received(NEW, "L1", 1), sold(NEW, 1, 30, "Retail bill RB-20260930-001")],
      catalog: [app(NEW)],
    }));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toContain("1 of the 1 piece this receipt brought in has already left stock (Retail bill RB-20260930-001)");
  });

  it("lets a restock go when the shelf still covers it — stock is fungible", () => {
    // 10 on the shelf, 5 logged by mistake, 2 sold since: the real count is 8.
    const p = plan({
      oldLines: [{ id: "L1", sku: OLD, qty: 5 }],
      movements: [counted(OLD, 10, 14), received(OLD, "L1", 5), sold(OLD, 2)],
      otherReceiptSkus: [],
      catalog: [app(OLD, { shopify_live_url: "https://drevifashion.com/products/x" })],
    });
    expect(p.reversals).toEqual([{ lineId: "L1", sku: OLD, qty: 5 }]);
    expect(p.withdraw).toEqual([]); // a counted, sold product is real
  });

  it("does not blame the receipt for a sale made before it arrived", () => {
    const d = planReceiptReversal(input({
      oldLines: [{ id: "L1", sku: NEW, qty: 1 }],
      movements: [sold(NEW, 1, 29, "Order DX-20260929-001 confirmed"), received(NEW, "L1", 1), sold(NEW, 1, 30)],
    }));
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.error).toContain("Order DX-20260930-004 confirmed");
      expect(d.error).not.toContain("DX-20260929-001");
      // already oversold before it arrived: never more gone than it brought
      expect(d.error).toContain("1 of the 1 piece this receipt brought in has already left stock");
    }
  });
});

describe("a later stock count owns the SKU", () => {
  it("reverses nothing the count already superseded, and says so", () => {
    const p = plan({
      oldLines: [{ id: "L1", sku: NEW, qty: 3 }],
      movements: [received(NEW, "L1", 3, 20), counted(NEW, 0, 25)],
      catalog: [app(NEW)],
    });
    expect(p.reversals).toEqual([]);
    expect(p.notes).toEqual([`${NEW} was counted on 2026-09-25, after this receipt — the count stands, so its stock is not changed.`]);
    expect(p.withdraw).toEqual([]); // a count is someone else's evidence — keep it billable
  });

  it("a count BEFORE the receipt does not protect it", () => {
    const p = plan({
      oldLines: [{ id: "L1", sku: OLD, qty: 2 }],
      movements: [counted(OLD, 1, 14), received(OLD, "L1", 2)],
    });
    expect(p.reversals).toEqual([{ lineId: "L1", sku: OLD, qty: 2 }]);
  });
});

describe("only a SKU that exists because of this receipt leaves billing", () => {
  const base = { oldLines: [{ id: "L1", sku: NEW, qty: 1 }], movements: [received(NEW, "L1", 1)] };

  it("keeps a SKU another receipt also delivered", () => {
    expect(plan({ ...base, otherReceiptSkus: [NEW], catalog: [app(NEW)] }).withdraw).toEqual([]);
  });

  it("still withdraws after an earlier edit re-created the line", () => {
    const p = plan({
      oldLines: [{ id: "L1", sku: NEW, qty: 1 }],
      movements: [
        mv(NEW, "receipt", { delta: 2, day: 30, hour: 9, line: "L0" }),
        mv(NEW, "receipt_reversed", { delta: -2, day: 30, hour: 10, line: "L0" }),
        mv(NEW, "receipt", { delta: 1, day: 30, hour: 10, line: "L1" }),
      ],
      catalog: [app(NEW)],
    });
    expect(p.reversals).toEqual([{ lineId: "L1", sku: NEW, qty: 1 }]);
    expect(p.withdraw).toEqual([NEW]);
  });

  it("an earlier mistaken receipt, already deleted, is not history either", () => {
    const p = plan({
      oldLines: [{ id: "L1", sku: NEW, qty: 1 }],
      movements: [
        mv(NEW, "receipt", { delta: 1, day: 29, line: "GONE" }),
        mv(NEW, "receipt_reversed", { delta: -1, day: 29, hour: 11, line: "GONE" }),
        received(NEW, "L1", 1),
      ],
      catalog: [app(NEW)],
    });
    expect(p.withdraw).toEqual([NEW]);
  });

  it("keeps a SKU with any other ledger history", () => {
    const p = plan({ ...base, movements: [...base.movements, mv(NEW, "manual", { delta: 1, day: 30, hour: 14, refType: "master_editor" })], catalog: [app(NEW)] });
    expect(p.withdraw).toEqual([]);
    expect(p.notes).toEqual([]); // 1 piece still on the shelf — nothing to flag
  });

  it("flags a SKU it had to keep that is left at zero", () => {
    // sold, then the order was cancelled: real history, nothing on the shelf
    const p = plan({
      ...base,
      movements: [...base.movements, sold(NEW, 1), mv(NEW, "correction", { delta: 1, day: 30, hour: 13, refType: "order", note: "Order DX-20260930-004 cancelled — stock returned" })],
      catalog: [app(NEW)],
    });
    expect(p.withdraw).toEqual([]);
    expect(p.notes).toEqual([`${NEW} stays billable at 0 in stock — it has sales or edits of its own. Hide it in Manage Catalog if it never existed.`]);
  });

  it("keeps a sheet or Shopify product", () => {
    expect(plan({ ...base, catalog: [app(NEW, { shopify_product_id: "gid://shopify/Product/1" })] }).withdraw).toEqual([]);
    expect(plan({ ...base, catalog: [app(NEW, { shopify_live_url: "https://x" })] }).withdraw).toEqual([]);
  });

  it("keeps a SKU that is on an order, and says where", () => {
    const p = plan({ ...base, documents: new Map([[NEW, ["DW-20260930-001"]]]), catalog: [app(NEW)] });
    expect(p.withdraw).toEqual([]);
    expect(p.notes[0]).toBe(`${NEW} stays billable — it is on DW-20260930-001. Take it off there if it never arrived.`);
  });

  it("leaves a Studio push to buyers alone", () => {
    const p = plan({ ...base, catalog: [app(NEW, { buyer_visible: true })] });
    expect(p.withdraw).toEqual([]);
    expect(p.notes[0]).toContain("live in the buyer catalog");
  });

  it("does nothing for a SKU already hidden or with no catalog row", () => {
    expect(plan({ ...base, catalog: [app(NEW, { wholesale_visible: false })] }).withdraw).toEqual([]);
    expect(plan({ ...base, catalog: [] }).withdraw).toEqual([]);
  });
});

describe("replacing a receipt's lines", () => {
  const replace = (over: Partial<ReversalInput>) => input({ mode: "replace", ...over });

  it("reverses the old line and re-posts the new one — the net is the difference", () => {
    const d = planReceiptReversal(replace({
      oldLines: [{ id: "L1", sku: NEW, qty: 3 }],
      newLines: [{ sku: NEW, qty: 2 }],
      movements: [received(NEW, "L1", 3)],
      catalog: [app(NEW)],
    }));
    expect(d.ok && d.plan.reversals).toEqual([{ lineId: "L1", sku: NEW, qty: 3 }]);
    expect(d.ok && d.plan.post).toEqual([true]);
    expect(d.ok && d.plan.withdraw).toEqual([]); // still on the receipt
  });

  it("allows an unchanged quantity even after a sale — nothing is taken back", () => {
    const d = planReceiptReversal(replace({
      oldLines: [{ id: "L1", sku: NEW, qty: 3 }],
      newLines: [{ sku: NEW, qty: 3 }],
      movements: [received(NEW, "L1", 3), sold(NEW, 2)],
    }));
    expect(d.ok).toBe(true);
  });

  it("refuses lowering a quantity below what has already left, and says the floor", () => {
    const d = planReceiptReversal(replace({
      oldLines: [{ id: "L1", sku: NEW, qty: 3 }],
      newLines: [{ sku: NEW, qty: 1 }],
      movements: [received(NEW, "L1", 3), sold(NEW, 2)],
    }));
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.error).toContain("Can't save GR-20260930-002");
      expect(d.error).toContain(`${NEW}: 1 of the pieces this edit takes back has already left stock (Order DX-20260930-004 confirmed) — keep the quantity at 2 or more`);
    }
  });

  it("names a sale that came before an earlier edit re-created the line", () => {
    // Received 3 (line L0, since replaced), sold 2, then an edit re-posted 3 on L1.
    const d = planReceiptReversal(replace({
      receivedAt: "2026-09-30T09:00:00.000Z",
      oldLines: [{ id: "L1", sku: NEW, qty: 3 }],
      newLines: [{ sku: NEW, qty: 1 }],
      movements: [
        mv(NEW, "receipt", { delta: 3, day: 30, hour: 9, line: "L0" }),
        sold(NEW, 2),
        mv(NEW, "receipt_reversed", { delta: -3, day: 30, hour: 14, line: "L0", note: "GR-20260930-002 edited — line replaced · −3 pc" }),
        mv(NEW, "receipt", { delta: 3, day: 30, hour: 14, line: "L1" }),
      ],
    }));
    expect(d.ok).toBe(false);
    // …and never blames the receipt's own earlier re-posting for it
    if (!d.ok) expect(d.error).toContain("(Order DX-20260930-004 confirmed) —");
  });

  it("withdraws a SKU removed from the receipt when nothing else holds it", () => {
    const d = planReceiptReversal(replace({
      oldLines: [{ id: "L1", sku: NEW, qty: 1 }, { id: "L2", sku: OLD, qty: 2 }],
      newLines: [{ sku: OLD, qty: 2 }],
      movements: [received(NEW, "L1", 1), counted(OLD, 1, 14), received(OLD, "L2", 2)],
      catalog: [app(NEW), app(OLD, { shopify_live_url: "https://x" })],
    }));
    expect(d.ok && d.plan.withdraw).toEqual([NEW]);
    expect(d.ok && d.plan.post).toEqual([true]);
  });

  it("a line added to a live delivery posts stock", () => {
    const d = planReceiptReversal(replace({
      oldLines: [{ id: "L1", sku: NEW, qty: 1 }],
      newLines: [{ sku: NEW, qty: 1 }, { sku: OLD, qty: 4 }],
      movements: [received(NEW, "L1", 1)],
    }));
    expect(d.ok && d.plan.post).toEqual([true, true]);
  });

  it("a record-only receipt stays record-only", () => {
    const d = planReceiptReversal(replace({
      oldLines: [{ id: "L1", sku: OLD, qty: 1 }],
      newLines: [{ sku: OLD, qty: 5 }, { sku: NEW, qty: 1 }],
      movements: [counted(OLD, 1, 14)],
    }));
    expect(d.ok && d.plan.reversals).toEqual([]);
    expect(d.ok && d.plan.post).toEqual([false, false]);
  });

  it("a SKU a count has superseded neither reverses nor re-posts", () => {
    const d = planReceiptReversal(replace({
      oldLines: [{ id: "L1", sku: OLD, qty: 2 }, { id: "L2", sku: NEW, qty: 1 }],
      newLines: [{ sku: OLD, qty: 5 }, { sku: NEW, qty: 1 }],
      movements: [received(OLD, "L1", 2, 20), counted(OLD, 3, 25), received(NEW, "L2", 1, 20)],
    }));
    expect(d.ok && d.plan.reversals).toEqual([{ lineId: "L2", sku: NEW, qty: 1 }]);
    expect(d.ok && d.plan.post).toEqual([false, true]);
  });
});

describe("sameLines", () => {
  const old = [
    { sku: "B", qty: 1, unit_cost: "500.00", description: null, position: 1 },
    { sku: "A", qty: 2, unit_cost: 250, description: "Red", position: 0 },
  ];
  it("treats a header-only edit as unchanged", () => {
    expect(sameLines(old, [
      { sku: "A", qty: 2, unit_cost: 250, description: "Red" },
      { sku: "B", qty: 1, unit_cost: 500, description: "" },
    ])).toBe(true);
  });
  it("sees a quantity, cost, order or count change", () => {
    expect(sameLines(old, [{ sku: "A", qty: 3, unit_cost: 250, description: "Red" }, { sku: "B", qty: 1, unit_cost: 500, description: "" }])).toBe(false);
    expect(sameLines(old, [{ sku: "A", qty: 2, unit_cost: 260, description: "Red" }, { sku: "B", qty: 1, unit_cost: 500, description: "" }])).toBe(false);
    expect(sameLines(old, [{ sku: "B", qty: 1, unit_cost: 500, description: "" }, { sku: "A", qty: 2, unit_cost: 250, description: "Red" }])).toBe(false);
    expect(sameLines(old, [{ sku: "A", qty: 2, unit_cost: 250, description: "Red" }])).toBe(false);
  });
});

describe("nextFirstReceipt", () => {
  it("re-points to the earliest remaining receipt holding the design, else clears", () => {
    const m = nextFirstReceipt(["d1", "d2"], [
      { design_id: "d1", receipt_id: "r3", receipt_date: "2026-10-02", created_at: "2026-10-02T09:00:00Z" },
      { design_id: "d1", receipt_id: "r2", receipt_date: "2026-10-01", created_at: "2026-10-01T09:00:00Z" },
      { design_id: "dX", receipt_id: "r9", receipt_date: "2026-09-01", created_at: "2026-09-01T09:00:00Z" },
    ]);
    expect(m.get("d1")).toBe("r2");
    expect(m.get("d2")).toBeNull();
  });
});

describe("skuInDesign", () => {
  it("matches a size variant of the (base, colour) group only", () => {
    expect(skuInDesign("dd-leh-flr-126-m-red", "DD-LEH-FLR-126", "RED")).toBe(true);
    expect(skuInDesign("DD-LEH-FLR-126-M-GRN", "DD-LEH-FLR-126", "RED")).toBe(false);
    expect(skuInDesign("DD-LEH-FLR-1260-M-RED", "DD-LEH-FLR-126", "RED")).toBe(false);
  });
});
