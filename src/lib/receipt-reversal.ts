// Undoing a goods receipt (30 Sep) — the PURE half: what a delete or a line
// replacement must do to stock and to the catalog, decided from rows the
// server action has already read. No I/O here, so every rule is under test.
//
// Log delivery posts one 'receipt' movement per line (ref_type
// 'goods_receipt_line', ref_id = the line) and, for a SKU it has never seen,
// creates a catalog row that is billable at once (e5c347c). Deleting the
// receipt used to leave both standing: stock for garments that never arrived,
// on a SKU the order editor, the booth and price check would all happily sell.
//
// THE RULE: a receipt line's stock is live until a later stock count
// supersedes it. While it is live, the ledger follows the line — delete it and
// its pieces go back out, edit it and the difference moves. Once a count has
// come after it, the count owns the SKU's stock and the receipt is a record
// only; taking pieces back then would subtract them from a number someone
// physically counted.

import { canonicalFromMovements, type Movement } from "./stock-ledger-core";

export const RECEIPT_LINE_REF = "goods_receipt_line";

export interface ReceiptLineRef { id: string; sku: string; qty: number }
export interface NewReceiptLine { sku: string; qty: number }

export interface CatalogRow {
  sku: string;
  wholesale_visible: boolean;
  buyer_visible?: boolean | null;
  shopify_live_url?: string | null;
  shopify_product_id?: string | null;
}

export interface ReversalInput {
  mode: "delete" | "replace";
  receiptNumber: string;
  /**
   * goods_receipts.created_at. Sales after this are the ones that can have
   * taken this receipt's pieces — an edit re-creates lines, so the current
   * lines' own movements can be younger than the sale that matters.
   */
  receivedAt?: string;
  /** Every line being removed: all of them on delete, the old set on replace. */
  oldLines: ReceiptLineRef[];
  /** replace only — the lines that take their place. */
  newLines?: NewReceiptLine[];
  /** Every ledger movement for every SKU on the old and new lines. */
  movements: Movement[];
  /** SKUs that also have a line on some OTHER receipt. */
  otherReceiptSkus: Iterable<string>;
  /** SKU → the orders / bills that name it, by number. */
  documents: Map<string, string[]>;
  catalog: CatalogRow[];
}

export interface PlannedReversal { lineId: string; sku: string; qty: number }

export interface ReversalPlan {
  /** One negative movement per old line whose stock is still live. */
  reversals: PlannedReversal[];
  /** replace only — per new line (same order): does it post a +qty receipt movement? */
  post: boolean[];
  /** SKUs that existed only because of this receipt: take them out of billing. */
  withdraw: string[];
  /** What was decided and why, for the person who pressed the button. */
  notes: string[];
}

export type ReversalDecision = { ok: true; plan: ReversalPlan } | { ok: false; error: string };

const norm = (s: string) => (s ?? "").trim().toUpperCase();
const sum = (ms: Movement[]) => ms.reduce((n, m) => n + (Number(m.delta) || 0), 0);
const day = (iso: string) => iso.slice(0, 10);

function latestReset(ms: Movement[]): string | null {
  let at: string | null = null;
  for (const m of ms) if (m.reason === "reset" && (at === null || m.created_at > at)) at = m.created_at;
  return at;
}

export function planReceiptReversal(input: ReversalInput): ReversalDecision {
  const bySku = new Map<string, Movement[]>();
  for (const m of input.movements) {
    const k = norm(m.sku);
    bySku.set(k, [...(bySku.get(k) ?? []), m]);
  }
  const oldIds = new Set(input.oldLines.map((l) => l.id));
  const isOwn = (m: Movement) => m.ref_type === RECEIPT_LINE_REF && !!m.ref_id && oldIds.has(m.ref_id);
  const notes: string[] = [];

  // Per old line: what it posted, and how much of that still counts.
  type LineState = { line: ReceiptLineRef; sku: string; posted: boolean; live: number; superseded: string | null };
  const states: LineState[] = input.oldLines.map((line) => {
    const sku = norm(line.sku);
    const ms = bySku.get(sku) ?? [];
    const own = ms.filter((m) => m.ref_type === RECEIPT_LINE_REF && m.ref_id === line.id);
    const reset = latestReset(ms);
    const live = sum(own.filter((m) => reset === null || m.created_at > reset));
    const superseded = reset !== null && own.some((m) => m.created_at <= reset) ? reset : null;
    return { line, sku, posted: own.length > 0, live: Math.max(0, live), superseded };
  });

  const reversals: PlannedReversal[] = states
    .filter((s) => s.live > 0)
    .map((s) => ({ lineId: s.line.id, sku: s.sku, qty: s.live }));

  for (const sku of new Set(states.filter((s) => s.superseded && s.posted).map((s) => s.sku))) {
    const at = states.find((s) => s.sku === sku && s.superseded)!.superseded!;
    notes.push(`${sku} was counted on ${day(at)}, after this receipt — the count stands, so its stock is not changed.`);
  }

  // New lines post stock when the receipt they join still carries live stock.
  // A SKU already on the receipt follows its own lines; a SKU new to it
  // follows the receipt as a whole. A receipt that never posted anything
  // (history imports, the old record-only editor) stays record-only.
  const receiptLive = states.some((s) => s.posted && !s.superseded);
  const newLines = input.mode === "replace" ? input.newLines ?? [] : [];
  const post = newLines.map((l) => {
    const mine = states.filter((s) => s.sku === norm(l.sku));
    if (mine.length === 0) return receiptLive;
    return mine.some((s) => s.posted) && !mine.some((s) => s.superseded);
  });

  // Refuse anything that would take back pieces that have already left.
  // Stock is fungible, so the test is the SKU's canonical count: if taking
  // this receipt's pieces back would leave it below zero, some of them were
  // sold or moved. A SKU with other stock can lose these pieces and stay
  // non-negative — exactly right when the delivery never happened.
  const problems: string[] = [];
  const stockAfter = new Map<string, number>();
  const skus = [...new Set([...states.map((s) => s.sku), ...newLines.map((l) => norm(l.sku))])];
  for (const sku of skus) {
    const back = reversals.filter((r) => r.sku === sku).reduce((n, r) => n + r.qty, 0);
    const added = newLines.reduce((n, l, i) => n + (post[i] && norm(l.sku) === sku ? Math.max(0, Math.trunc(l.qty)) : 0), 0);
    const net = added - back;
    const ms = bySku.get(sku) ?? [];
    const stock = canonicalFromMovements(ms);
    stockAfter.set(sku, stock + net);
    if (net >= 0) continue;
    if (stock + net >= 0) continue;
    // Capped at what this change takes back: a SKU already oversold before the
    // receipt arrived cannot have lost more of THESE pieces than there were.
    const gone = Math.min(-(stock + net), -net);
    const since = [input.receivedAt, ...ms.filter(isOwn).map((m) => m.created_at)]
      .reduce<string | null>((a, t) => (!t ? a : a === null || t < a ? t : a), null);
    const why = [...new Set(
      // Only what took pieces OUT — a sale, a bill, a manual edit. Receipt-line
      // movements never did (an earlier edit's reversal is this receipt's own).
      ms.filter((m) => m.ref_type !== RECEIPT_LINE_REF && (Number(m.delta) || 0) < 0 && (since === null || m.created_at >= since))
        .map((m) => (m.note ?? "").trim())
        .filter(Boolean),
    )].slice(0, 3);
    const where = why.length ? ` (${why.join("; ")})` : ` (${sku} is at ${stock} in stock)`;
    problems.push(
      input.mode === "delete"
        ? `${sku}: ${gone} of the ${back} piece${back === 1 ? "" : "s"} this receipt brought in ${gone === 1 ? "has" : "have"} already left stock${where}`
        : `${sku}: ${gone} of the pieces this edit takes back ${gone === 1 ? "has" : "have"} already left stock${where} — keep the quantity at ${added + gone} or more`,
    );
  }
  if (problems.length) {
    const head = input.mode === "delete" ? `Can't delete ${input.receiptNumber}` : `Can't save ${input.receiptNumber}`;
    const tail = input.mode === "delete" ? " Cancel the order or take the pieces back as a return first, then delete." : "";
    return { ok: false, error: `${head} — sold or moved since it was received. ${problems.join(". ")}.${tail}` };
  }

  // Which SKUs existed ONLY because of this receipt? Every test has to pass;
  // any doubt keeps the SKU billable, because withdrawing a real product stops
  // a sale while a leftover one only needs a manual hide.
  const staying = new Set(newLines.map((l) => norm(l.sku)));
  const elsewhere = new Set([...input.otherReceiptSkus].map(norm));
  const catalog = new Map(input.catalog.map((c) => [norm(c.sku), c]));
  const withdraw: string[] = [];
  for (const sku of new Set(states.map((s) => s.sku))) {
    if (staying.has(sku) || elsewhere.has(sku)) continue;
    const ms = bySku.get(sku) ?? [];
    // Posted by this receipt, and nothing else has ever touched it: no count,
    // no sale, no manual edit. A SKU the receipt never posted (a record-only
    // line) was not brought into being here. A receipt line that was received
    // and fully reversed — this receipt's own line before an edit replaced it,
    // or an earlier mistaken delivery already deleted — contributed nothing,
    // so it is not history either.
    const lineNet = new Map<string, number>();
    for (const m of ms) if (m.ref_type === RECEIPT_LINE_REF && m.ref_id) lineNet.set(m.ref_id, (lineNet.get(m.ref_id) ?? 0) + (Number(m.delta) || 0));
    const undone = (m: Movement) => m.ref_type === RECEIPT_LINE_REF && !!m.ref_id && lineNet.get(m.ref_id) === 0;
    if (!ms.some(isOwn)) continue;
    const row = catalog.get(sku);
    if (ms.some((m) => !isOwn(m) && !undone(m))) {
      // Real history of its own, so it stays — but a SKU this receipt alone
      // delivered, left at nothing, is worth a human look. (A later count
      // already has its own note.)
      if (row?.wholesale_visible && (stockAfter.get(sku) ?? 0) <= 0 && !states.some((s) => s.sku === sku && s.superseded)) {
        notes.push(`${sku} stays billable at 0 in stock — it has sales or edits of its own. Hide it in Manage Catalog if it never existed.`);
      }
      continue;
    }
    if (!row || !row.wholesale_visible) continue;
    // A sheet or Shopify product predates the delivery.
    if (row.shopify_live_url || row.shopify_product_id) continue;
    const docs = input.documents.get(sku) ?? [];
    if (docs.length) {
      notes.push(`${sku} stays billable — it is on ${docs.join(", ")}. Take it off there if it never arrived.`);
      continue;
    }
    // Buyers can only see it because someone pushed it from Studio. That is a
    // decision about the product, not a side effect of the delivery.
    if (row.buyer_visible) {
      notes.push(`${sku} stays billable — it is live in the buyer catalog. Withdraw it in Manage Catalog if it never arrived.`);
      continue;
    }
    withdraw.push(sku);
  }

  return { ok: true, plan: { reversals, post, withdraw, notes } };
}

/** Header-only edits re-send identical lines; replacing them would churn the ledger for nothing. */
export function sameLines(
  old: { sku: string; qty: number; unit_cost: number | string; description?: string | null; position?: number | null }[],
  next: { sku: string; qty: number; unit_cost: number; description: string }[],
): boolean {
  if (old.length !== next.length) return false;
  const sorted = [...old].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return sorted.every((o, i) =>
    norm(o.sku) === norm(next[i].sku) &&
    Number(o.qty) === next[i].qty &&
    Number(o.unit_cost) === next[i].unit_cost &&
    (o.description ?? "").trim() === next[i].description,
  );
}

/**
 * designs.first_receipt_id for designs that lose their first receipt: the
 * earliest remaining receipt that still holds one of the design's lines, else
 * null. "First stocked here" — if the mistaken receipt goes, the next real one
 * is the first.
 */
export function nextFirstReceipt(
  designIds: string[],
  remaining: { design_id: string | null; receipt_id: string; receipt_date: string; created_at: string }[],
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const id of designIds) {
    const best = remaining
      .filter((r) => r.design_id === id)
      .sort((a, b) => a.receipt_date.localeCompare(b.receipt_date) || a.created_at.localeCompare(b.created_at))[0];
    out.set(id, best?.receipt_id ?? null);
  }
  return out;
}

/** Same (base, colour) group rule as the receipt page: base is the first four parts, colour the last. */
export function skuInDesign(sku: string, baseSku: string, color: string): boolean {
  const s = norm(sku);
  return s.startsWith(`${norm(baseSku)}-`) && s.endsWith(`-${norm(color)}`) && s.length > norm(baseSku).length + norm(color).length + 2;
}
