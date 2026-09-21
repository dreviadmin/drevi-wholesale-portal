"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/staff";
import { applyMovement, restockableFor } from "@/lib/stock-ledger";
import { validateBillDate } from "@/lib/order-lines-core";
import { captureBuyerSnapshot, snapshotSourceForDate } from "@/lib/buyer-snapshot";
import { formatINR } from "@/lib/format";
import { writeAuditEvent } from "@/lib/audit";
import {
  computeCreditTotals,
  remainingReturnable,
  returnedByBillLine,
  returnedByOrderLine,
  noteSettlement,
  validateCreditAmount,
  walletBalance,
  type BillLine,
  type CreditNoteLike,
  type SourceBill,
} from "@/lib/credit-core";
import type { OrderItem } from "@/lib/types";

// Credit notes, returns and wallet spend (11 Sep).
//
// The sequencing in createReturnCreditNote is the whole feature. Read it as:
// reserve the quantity on the ORDER LINE first (the CAS'd flag is the only
// real arbiter), THEN take a credit-note number, THEN write the document.
// An earlier shape — insert the note and re-verify the sums afterwards — let
// BOTH racers abort and burnt a number out of the CN series each time, and a
// gap in a GST series is an audit liability.

/**
 * A line coming back, as the picker sends it. `lineIndex` indexes the BILL's
 * items when the return is bill-anchored and the ORDER's items when it is
 * order-anchored (21 Sep) — the two are never mixed in one note, because a
 * return names exactly one document.
 */
export interface ReturnLineInput {
  lineIndex: number;
  qty: number;
  restock: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const CLIENT_REF = /^[0-9a-f-]{36}$/i;
const MAX_RETURN_LINES = 50;

type LinePatch = Partial<OrderItem> & { returned_qty?: number };
type FreshLine = OrderItem & { returned_qty?: number };

/** The IST calendar day an ISO timestamp falls on — the order's invoice date. */
function istDay(iso: string | null | undefined): string {
  if (!iso) return todayIst();
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return todayIst();
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function todayIst(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

const returnedQty = (it: FreshLine | undefined) => Math.max(0, Number(it?.returned_qty) || 0);

/** A raised plpgsql exception arrives as a bare message — show it as written. */
function rpcError(message: string | undefined, fallback: string): string {
  const clean = (message ?? "").replace(/^[a-z]+ error:\s*/i, "").trim();
  return clean || fallback;
}

/**
 * Merge a one-index items patch onto a fresh read, CAS-guarded on lines_rev —
 * the same helper admin/orders/actions.ts uses to mark a line billed (it is
 * module-private there). `patch` may be a function of the fresh line because
 * un-reserving has to subtract from whatever the line now holds, not from a
 * value read before the race. `expect` aborts inside the winning write.
 */
async function patchOrderLine(
  orderId: string,
  index: number,
  patch: LinePatch | ((fresh: FreshLine) => LinePatch),
  expect?: (fresh: FreshLine) => string | null,
): Promise<{ ok: boolean; error?: string; prev?: FreshLine }> {
  const admin = createAdminClient();
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: o } = await admin.from("orders").select("items, lines_rev").eq("id", orderId).maybeSingle();
    if (!o) return { ok: false, error: "Order not found." };
    const items = [...((o.items ?? []) as FreshLine[])];
    if (index < 0 || index >= items.length) return { ok: false, error: "Line not found — reload the page." };
    const prev = items[index];
    if (expect) {
      const bad = expect(prev);
      if (bad) return { ok: false, error: bad };
    }
    items[index] = { ...prev, ...(typeof patch === "function" ? patch(prev) : patch) };
    const { data: won, error } = await admin
      .from("orders")
      .update({ items, lines_rev: (Number(o.lines_rev) || 0) + 1 })
      .eq("id", orderId)
      .eq("lines_rev", Number(o.lines_rev) || 0)
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (won) return { ok: true, prev };
  }
  return { ok: false, error: "The order changed under you — reload and retry." };
}

/**
 * Which ORDER line each line of a bill snapshot came from. generateOrderBill
 * writes `items: billable.map(b => b.item)` and marks those same lines
 * `billed_in`, in array order — so the k-th line still carrying this bill id
 * is the k-th line of the snapshot. Returns null when the two no longer line
 * up, which means the order was edited and nothing may be resolved by guess.
 */
function resolveOrderLines(orderItems: OrderItem[], billId: string, billItems: OrderItem[]): number[] | null {
  const indexes = orderItems.map((it, i) => ({ it, i })).filter((x) => x.it.billed_in === billId).map((x) => x.i);
  if (indexes.length !== billItems.length) return null;
  for (let k = 0; k < indexes.length; k++) {
    if (orderItems[indexes[k]].sku !== billItems[k].sku) return null;
  }
  return indexes;
}

/**
 * Raise a credit note for goods coming back against one bill. The money comes
 * from the BILL snapshot (immutable, and the prices actually charged), never
 * from the order or the catalog.
 */
export async function createReturnCreditNote(input: {
  orderId: string;
  /** Omitted for an ORDER-anchored return — the order's own invoice (21 Sep). */
  orderBillId?: string | null;
  lines: ReturnLineInput[];
  reason: string;
  noteDate: string;
  clientRef: string;
}): Promise<{ ok: boolean; error?: string; warning?: string; noteId?: string; noteNumber?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();

  if (!CLIENT_REF.test(input.clientRef ?? "")) return { ok: false, error: "Missing a request id — reload and retry." };
  const clientRef = input.clientRef;

  // A replay of the same click resolves to the note the first attempt wrote.
  const { data: twin } = await admin
    .from("credit_notes").select("id, note_number").eq("client_ref", clientRef).maybeSingle();
  if (twin) return { ok: true, noteId: twin.id, noteNumber: twin.note_number };

  const reason = (input.reason ?? "").trim().slice(0, 300);
  if (!reason) return { ok: false, error: "Say why the goods came back." };

  const today = todayIst();
  const noteDate = input.noteDate?.trim() ? validateBillDate(input.noteDate, today) : today;
  if (!noteDate) return { ok: false, error: "Credit note date must be a valid date, today or earlier." };

  const requested = (input.lines ?? [])
    .map((l) => ({
      lineIndex: Math.trunc(Number(l?.lineIndex)),
      qty: Math.trunc(Number(l?.qty)) || 0,
      restock: !!l?.restock,
    }))
    .filter((l) => l.qty > 0);
  if (requested.length === 0) return { ok: false, error: "Pick at least one line to return." };
  if (requested.length > MAX_RETURN_LINES) {
    return { ok: false, error: `One credit note covers at most ${MAX_RETURN_LINES} lines — split the return.` };
  }
  if (new Set(requested.map((l) => l.lineIndex)).size !== requested.length) {
    return { ok: false, error: "The same line was picked twice — reload and retry." };
  }

  // FRESH reads: the order is the arbiter, the bill is the price.
  const { data: order } = await admin
    .from("orders")
    .select("id, order_number, buyer_id, status, source, items, submitted_at, discount_amount, tax_mode, tax_rate, buyer_business_name, buyer_owner_name, buyer_phone, buyer_city, buyer_gstin, buyer_address, buyer_snapshot_at, buyer_snapshot_source")
    .eq("id", input.orderId)
    .maybeSingle();
  if (!order) return { ok: false, error: "Order not found." };
  if (order.status === "cancelled") return { ok: false, error: "This order is cancelled — nothing can be returned against it." };

  const orderItems = (order.items ?? []) as FreshLine[];

  // ONE document is being reversed. Either a bill snapshot, or — since 21 Sep —
  // the order itself, whose own PDF is the tax invoice for every source but
  // portal_self_service. `doc` is what the rest of this function reads, so the
  // two paths diverge here and nowhere else.
  interface ReturnDoc {
    billId: string | null;
    number: string;
    date: string;
    /** The lines being returned against, in the index space the picker used. */
    lines: OrderItem[];
    /** lineIndex -> index into orders.items */
    orderLineFor: number[];
    source: SourceBill;
    party: Record<string, unknown>;
    alreadyReturned: (lineIndex: number) => number;
  }
  let doc: ReturnDoc;
  // Notes already raised on this document — their restock movements net off the
  // ledger cap so a second return cannot credit the same piece twice.
  let priorNoteIds: string[] = [];

  if (input.orderBillId) {
    const { data: bill } = await admin
      .from("order_bills")
      .select("id, order_id, bill_number, bill_date, items, subtotal, discount_amount, tax_mode, tax_rate, cancelled_at, buyer_business_name, buyer_owner_name, buyer_phone, buyer_city, buyer_gstin, buyer_address, buyer_snapshot_at, buyer_snapshot_source")
      .eq("id", input.orderBillId)
      .maybeSingle();
    if (!bill || bill.order_id !== order.id) return { ok: false, error: "That bill is not on this order — reload and retry." };
    if (bill.cancelled_at) return { ok: false, error: `${bill.bill_number} was cancelled — return against the order instead.` };

    const billItems = (bill.items ?? []) as OrderItem[];
    const map = resolveOrderLines(orderItems, bill.id, billItems);
    if (!map) {
      return { ok: false, error: "This order's lines no longer match the bill — it was edited since billing, so the return can't be placed." };
    }
    const { data: priorNotes } = await admin
      .from("credit_notes").select("id, status, order_bill_id, items").eq("order_bill_id", bill.id);
    const prior = returnedByBillLine((priorNotes ?? []) as CreditNoteLike[]);
    priorNoteIds = (priorNotes ?? []).map((n) => String(n.id));
    doc = {
      billId: bill.id,
      number: bill.bill_number,
      date: bill.bill_date,
      lines: billItems,
      orderLineFor: map,
      source: {
        subtotal: Number(bill.subtotal) || 0,
        discount_amount: Number(bill.discount_amount) || 0,
        tax_mode: bill.tax_mode ?? null,
        tax_rate: bill.tax_rate == null ? null : Number(bill.tax_rate),
      },
      // The party is INHERITED from the bill being reversed, not read live: a
      // note against a six-month-old bill must be addressed to whoever THAT
      // bill was addressed to, or the credit note contradicts the invoice it
      // reverses. The source rides along too.
      party: {
        buyer_business_name: bill.buyer_business_name,
        buyer_owner_name: bill.buyer_owner_name,
        buyer_phone: bill.buyer_phone,
        buyer_city: bill.buyer_city,
        buyer_gstin: bill.buyer_gstin,
        buyer_address: bill.buyer_address,
        buyer_snapshot_at: bill.buyer_snapshot_at,
        buyer_snapshot_source: bill.buyer_snapshot_source,
      },
      alreadyReturned: (i) => prior.get(`${bill.id}:${i}`) ?? 0,
    };
  } else {
    // A self-service order's PDF prints as an ORDER REQUEST, not an invoice
    // (order-pdf.tsx isInvoice), so there is no document to reverse. Zero prod
    // orders are in this state; the bill path is the way out if one ever is.
    if (order.source === "portal_self_service") {
      return { ok: false, error: "This is a portal order request, not an invoice. Raise a bill for it first, then return against that bill." };
    }
    const { data: priorNotes } = await admin
      .from("credit_notes").select("id, status, order_bill_id, items").eq("order_id", order.id);
    const prior = returnedByOrderLine((priorNotes ?? []) as CreditNoteLike[]);
    priorNoteIds = (priorNotes ?? []).map((n) => String(n.id));
    doc = {
      billId: null,
      number: order.order_number,
      date: istDay(order.submitted_at as string),
      lines: orderItems,
      orderLineFor: orderItems.map((_, i) => i),
      source: {
        // Σ(qty × unit_price) — the same figure order-pdf prints as the
        // subtotal, and the base discountShareFor prorates against. NOT
        // total_amount, which is already discounted and taxed.
        subtotal: r2(orderItems.reduce((sum, it) => sum + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0)),
        discount_amount: Number(order.discount_amount) || 0,
        tax_mode: (order.tax_mode as string | null) ?? null,
        tax_rate: order.tax_rate == null ? null : Number(order.tax_rate),
      },
      party: {
        buyer_business_name: order.buyer_business_name,
        buyer_owner_name: order.buyer_owner_name,
        buyer_phone: order.buyer_phone,
        buyer_city: order.buyer_city,
        buyer_gstin: order.buyer_gstin,
        buyer_address: order.buyer_address,
        buyer_snapshot_at: order.buyer_snapshot_at,
        buyer_snapshot_source: order.buyer_snapshot_source,
      },
      alreadyReturned: (i) => prior.get(i) ?? 0,
    };
  }

  const resolved: { line: BillLine; qty: number; restock: boolean; orderLineIndex: number; seenReturned: number }[] = [];
  for (const req of requested) {
    const idx = req.lineIndex;
    if (!Number.isInteger(idx) || idx < 0 || idx >= doc.lines.length) {
      return { ok: false, error: "A picked line is not on this document — reload and retry." };
    }
    const billItem = doc.lines[idx];
    const orderIndex = doc.orderLineFor[idx];
    const fresh = orderItems[orderIndex];
    if (!fresh || fresh.sku !== billItem.sku) {
      return { ok: false, error: `${billItem.sku} no longer sits on this ${doc.billId ? "bill" : "order"} — it was edited. Reload and retry.` };
    }
    // Bill-anchored only: the line must still BE on that bill. An
    // order-anchored return instead refuses a line that IS billed — that
    // return belongs to the bill, because a note names one document.
    if (doc.billId && fresh.billed_in !== doc.billId) {
      return { ok: false, error: `${billItem.sku} no longer sits on this bill — the order was edited. Reload and retry.` };
    }
    if (!doc.billId && fresh.billed_in) {
      return { ok: false, error: `${billItem.sku} was invoiced on a bill — raise that return against the bill.` };
    }
    const remaining = remainingReturnable(Math.trunc(Number(billItem.qty) || 0), doc.alreadyReturned(idx));
    if (req.qty > remaining) {
      return { ok: false, error: `Only ${remaining} of ${billItem.sku} can still be returned.` };
    }
    resolved.push({
      line: { item: billItem, index: idx },
      qty: req.qty,
      // A custom line holds no stock — restocking it would mint the pseudo-SKU
      // "CUSTOM" into the ledger, exactly as the retail and order paths guard.
      restock: req.restock && !!billItem.sku && !billItem.custom,
      orderLineIndex: orderIndex,
      seenReturned: returnedQty(fresh),
    });
  }

  // RESERVE first. The CAS'd returned_qty on the order line is what stops two
  // racers returning the same pieces; it survives Modify Order because
  // updateOrderItems spreads ...prev for kept lines.
  const reserved: { index: number; qty: number }[] = [];
  const unreserve = async () => {
    for (const rv of reserved) {
      await patchOrderLine(input.orderId, rv.index, (fresh) => ({
        returned_qty: Math.max(0, r2(returnedQty(fresh) - rv.qty)),
      }));
    }
  };

  for (const rl of resolved) {
    const w = await patchOrderLine(
      input.orderId,
      rl.orderLineIndex,
      (fresh) => ({ returned_qty: r2(returnedQty(fresh) + rl.qty) }),
      (fresh) => {
        const prev = returnedQty(fresh);
        const lineQty = Math.trunc(Number(fresh.qty) || 0);
        return doc.billId && fresh.billed_in !== doc.billId ? `${rl.line.item.sku} is no longer billed on ${doc.number}.`
          : !doc.billId && fresh.billed_in ? `${rl.line.item.sku} was invoiced on a bill while this return was being raised.`
          : fresh.sku !== rl.line.item.sku ? "The order's lines changed while the return was being raised."
          // lines_rev is a whole-array counter, so two lines of the same SKU at
          // different prices are otherwise indistinguishable.
          : Number(fresh.unit_price) !== Number(rl.line.item.unit_price) ? `${rl.line.item.sku} was repriced while this return was being raised.`
          : prev !== rl.seenReturned ? `Another return went through for ${rl.line.item.sku}.`
          : prev + rl.qty > lineQty ? `Only ${Math.max(0, lineQty - prev)} of ${rl.line.item.sku} can still be returned.`
          : null;
      },
    );
    if (!w.ok) {
      await unreserve();
      return { ok: false, error: `${w.error ?? "The order changed"} — nothing was returned, reload and retry.` };
    }
    reserved.push({ index: rl.orderLineIndex, qty: rl.qty });
  }

  // Only now take a number: a racer that lost above never consumes one.
  const source: SourceBill = doc.source;
  const totals = computeCreditTotals(
    resolved.map((r) => ({ line: r.line, qty: r.qty, restock: r.restock, orderLineIndex: r.orderLineIndex })),
    source,
  );

  const ymd = noteDate.replace(/-/g, "");
  let note: { id: string; note_number: string } | null = null;
  for (let attempt = 1; attempt <= 3 && !note; attempt++) {
    const { data: numData, error: numErr } = await admin.rpc("next_order_number", { p_prefix: "CN", p_day: ymd });
    if (numErr || !numData) {
      await unreserve();
      return { ok: false, error: numErr?.message ?? "Could not generate a credit note number." };
    }
    const { data, error } = await admin
      .from("credit_notes")
      .insert({
        note_number: numData as string,
        kind: "return",
        buyer_id: order.buyer_id,
        order_id: order.id,
        order_bill_id: doc.billId,
        // The document this note reverses: the bill, or the order's own
        // invoice. The PDF's "against invoice X dated Y" line reads these two
        // columns and needs no change either way.
        source_bill_number: doc.number,
        source_bill_date: doc.date,
        ...doc.party,
        items: totals.items,
        source_subtotal: totals.sourceSubtotal,
        discount_share: totals.discountShare,
        subtotal: totals.subtotal,
        tax_mode: totals.taxMode,
        tax_rate: totals.taxRate,
        tax_amount: totals.taxAmount,
        total: totals.total,
        reason,
        note_date: noteDate,
        client_ref: clientRef,
        created_by: staff.email,
      })
      .select("id, note_number")
      .single();
    if (data) note = data;
    else if (error && error.code === "23505") {
      // Either the retry's twin landed under our client_ref (give it back and
      // drop OUR duplicate reservation), or the number raced — loop for a new one.
      const { data: won } = await admin
        .from("credit_notes").select("id, note_number").eq("client_ref", clientRef).maybeSingle();
      if (won) {
        await unreserve();
        return { ok: true, noteId: won.id, noteNumber: won.note_number };
      }
    } else if (error) {
      await unreserve();
      return { ok: false, error: error.message };
    }
  }
  if (!note) {
    await unreserve();
    return { ok: false, error: "Could not reserve a credit note number — retry." };
  }

  // Goods back on the shelf. A failure NEVER rolls the note back (the pieces
  // physically came back) and never hides — staff are told which SKUs to fix.
  const moveFailed: string[] = [];
  // What this order actually took off the shelf and has not had back, read
  // from the LEDGER — stock_moved is stamped from order status by 0042 and
  // backs no movement row, so it cannot authorise a credit.
  const restockCap = await restockableFor(
    input.orderId,
    totals.items.filter((it) => it.restock && it.sku).map((it) => it.sku as string),
    priorNoteIds,
  );
  for (const it of totals.items) {
    if (!it.restock || !it.sku || it.sku.toUpperCase() === "CUSTOM") continue;
    const want = Math.trunc(it.qty);
    const cap = restockCap.get(it.sku.toUpperCase()) ?? 0;
    const within = Math.min(want, cap);
    const beyond = Math.max(0, want - cap);
    // A 'return' movement always nets a recorded issue, so it stays
    // reconcilable forever. Anything the operator ticked BEYOND what the
    // ledger saw leave is still posted — the pieces are physically back — but
    // as a 'correction' naming the note, which is what it actually is.
    if (within > 0) {
      const res = await applyMovement({
        sku: it.sku, delta: within, reason: "return",
        refType: "credit_note", refId: note.id,
        note: `${note.note_number} — returned against ${doc.number}`,
        createdBy: staff.email,
      });
      if (!res.ok) moveFailed.push(it.sku);
    }
    if (beyond > 0) {
      const res = await applyMovement({
        sku: it.sku, delta: beyond, reason: "correction",
        refType: "credit_note", refId: note.id,
        note: `${note.note_number} — ${beyond} back on the shelf beyond what ${doc.number} took out`,
        createdBy: staff.email,
      });
      if (!res.ok) moveFailed.push(it.sku);
    }
  }

  await writeAuditEvent({
    eventType: "return_credit_note_raised",
    buyerId: order.buyer_id as string | null,
    staffUserId: staff.id,
    notes: `${note.note_number} against ${doc.number}: ${totals.items.length} line(s), ${formatINR(totals.total)} — ${reason}`,
  });

  // No credit_ledger row: the note IS the grant (migration 0046), so the
  // credit can never go missing behind a document that was already shared.
  revalidatePath(`/admin/orders/${input.orderId}`);
  revalidatePath("/admin/orders");
  revalidatePath("/admin/credit-notes");
  if (order.buyer_id) revalidatePath(`/admin/buyers/${order.buyer_id}`);
  revalidatePath("/admin/dashboard");

  return {
    ok: true,
    noteId: note.id,
    noteNumber: note.note_number,
    ...(moveFailed.length > 0
      ? { warning: `Credit note raised, but stock did NOT post for ${moveFailed.join(", ")} — adjust in Stock take.` }
      : {}),
  };
}

/** A goodwill / adjustment credit: an amount and a reason, no goods, no stock. */
export async function createManualCreditNote(input: {
  buyerId: string;
  amount: number;
  reason: string;
  noteDate: string;
  clientRef: string;
}): Promise<{ ok: boolean; error?: string; noteId?: string; noteNumber?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();

  if (!CLIENT_REF.test(input.clientRef ?? "")) return { ok: false, error: "Missing a request id — reload and retry." };
  const clientRef = input.clientRef;
  const { data: twin } = await admin
    .from("credit_notes").select("id, note_number").eq("client_ref", clientRef).maybeSingle();
  if (twin) return { ok: true, noteId: twin.id, noteNumber: twin.note_number };

  const amount = validateCreditAmount(input.amount);
  if (!amount.ok) return { ok: false, error: amount.error };

  const reason = (input.reason ?? "").trim().slice(0, 300);
  if (!reason) return { ok: false, error: "Say what this credit is for." };

  const today = todayIst();
  const noteDate = input.noteDate?.trim() ? validateBillDate(input.noteDate, today) : today;
  if (!noteDate) return { ok: false, error: "Credit note date must be a valid date, today or earlier." };

  const { data: buyer } = await admin.from("buyers").select("id").eq("id", input.buyerId).maybeSingle();
  if (!buyer) return { ok: false, error: "Pick a party for this credit." };

  // No source bill to inherit from, so a manual note captures the party live —
  // the one credit-note path that does. A back-dated note stamps today's
  // identity on an earlier date, which the source flags rather than hides.
  const source = snapshotSourceForDate(noteDate, today);
  const party = await captureBuyerSnapshot(admin, buyer.id, source);

  const ymd = noteDate.replace(/-/g, "");
  let note: { id: string; note_number: string } | null = null;
  for (let attempt = 1; attempt <= 3 && !note; attempt++) {
    const { data: numData, error: numErr } = await admin.rpc("next_order_number", { p_prefix: "CN", p_day: ymd });
    if (numErr || !numData) return { ok: false, error: numErr?.message ?? "Could not generate a credit note number." };
    const { data, error } = await admin
      .from("credit_notes")
      .insert({
        note_number: numData as string,
        kind: "manual",
        buyer_id: buyer.id,
        items: [],
        source_subtotal: amount.value,
        discount_share: 0,
        subtotal: amount.value,
        tax_mode: "none",
        tax_rate: null,
        tax_amount: 0,
        total: amount.value,
        reason,
        note_date: noteDate,
        client_ref: clientRef,
        created_by: staff.email,
        ...party,
      })
      .select("id, note_number")
      .single();
    if (data) note = data;
    else if (error && error.code === "23505") {
      const { data: won } = await admin
        .from("credit_notes").select("id, note_number").eq("client_ref", clientRef).maybeSingle();
      if (won) return { ok: true, noteId: won.id, noteNumber: won.note_number };
    } else if (error) return { ok: false, error: error.message };
  }
  if (!note) return { ok: false, error: "Could not reserve a credit note number — retry." };

  revalidatePath("/admin/credit-notes");
  revalidatePath(`/admin/buyers/${buyer.id}`);
  revalidatePath("/admin/dashboard");
  return { ok: true, noteId: note.id, noteNumber: note.note_number };
}

/**
 * Void a note. The status CAS is the arbiter, so the balance is only re-checked
 * once this call owns the void — then, if the credit has already been spent,
 * the void is put back rather than driving the wallet negative.
 */
export async function voidCreditNote(noteId: string, reason: string): Promise<{ ok: boolean; error?: string; warning?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();

  const clean = (reason ?? "").trim().slice(0, 300);
  if (!clean) return { ok: false, error: "Say why this credit note is being voided." };

  const { data: won, error } = await admin
    .from("credit_notes")
    .update({ status: "void", voided_at: new Date().toISOString(), voided_by: staff.email, void_reason: clean })
    .eq("id", noteId)
    .eq("status", "issued")
    .select("id, note_number, buyer_id, order_id, order_bill_id, items, total")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!won) {
    const { data: exists } = await admin.from("credit_notes").select("status").eq("id", noteId).maybeSingle();
    return { ok: false, error: exists ? "This credit note is already void." : "Credit note not found." };
  }

  // PER-NOTE FIRST (21 Sep). The wallet check below is party-level, so it
  // passes whenever the party holds OTHER credit — leaving this note's own
  // consumption rows alive, and orders.credit_applied with them, funded by a
  // document that is now void. Ask the narrow question before the broad one.
  {
    const { data: consumed } = await admin
      .from("credit_ledger")
      .select("delta, reason, method, ref_id")
      .eq("source_note_id", noteId);
    const legs = noteSettlement(Number(won.total) || 0, (consumed ?? []).map((c) => ({
      reason: String(c.reason), delta: Number(c.delta) || 0,
    })));
    if (legs.refunded > 0 || legs.adjusted > 0) {
      await admin
        .from("credit_notes")
        .update({ status: "issued", voided_at: null, voided_by: null, void_reason: null })
        .eq("id", noteId);
      const parts = [
        legs.refunded > 0 ? `${formatINR(legs.refunded)} was refunded` : null,
        legs.adjusted > 0 ? `${formatINR(legs.adjusted)} was set against an order` : null,
      ].filter(Boolean).join(" and ");
      return {
        ok: false,
        error: `${won.note_number} cannot be voided — ${parts}. Reverse that on the party's wallet first, then void this note.`,
      };
    }
  }

  // The void now stands — does the wallet survive it? (The note is already
  // excluded from the grants by its new status.)
  if (won.buyer_id) {
    const [{ data: grantRows }, { data: entryRows }] = await Promise.all([
      admin.from("credit_notes").select("id, total, status, note_date, created_at").eq("buyer_id", won.buyer_id),
      admin.from("credit_ledger").select("id, delta, reason, effective_date, created_at").eq("buyer_id", won.buyer_id),
    ]);
    const balance = walletBalance(
      (grantRows ?? []).map((g) => ({
        id: g.id, total: Number(g.total) || 0, status: g.status, effective_date: g.note_date, created_at: g.created_at,
      })),
      (entryRows ?? []).map((e) => ({
        id: e.id, delta: Number(e.delta) || 0, reason: e.reason, effective_date: e.effective_date, created_at: e.created_at,
      })),
    );
    if (balance < 0) {
      const { data: back } = await admin
        .from("credit_notes")
        .update({ status: "issued", voided_at: null, voided_by: null, void_reason: null })
        .eq("id", noteId)
        .eq("status", "void")
        .select("id")
        .maybeSingle();
      const spent = `${formatINR(r2(-balance))} of this credit is already applied to orders — unapply it there first`;
      // If the note could not be put back, the wallet is overdrawn RIGHT NOW.
      // Say so: a silent failure here is money nobody can see.
      return {
        ok: false,
        error: back
          ? `${spent}, then void this note.`
          : `${spent}. The void could NOT be undone — this party's wallet is overdrawn, fix it now.`,
      };
    }
  }

  const blocked: string[] = [];

  // Free the reservation so those pieces can be returned again.
  // NOT gated on order_bill_id (21 Sep): an order-anchored note has none, and
  // the old gate left its returned_qty reserved forever — the line could never
  // be returned again, and the edit policy would keep refusing to resize it.
  if (won.order_id) {
    const [{ data: order }, { data: bill }] = await Promise.all([
      admin.from("orders").select("items").eq("id", won.order_id).maybeSingle(),
      won.order_bill_id
        ? admin.from("order_bills").select("items").eq("id", won.order_bill_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const orderItems = (order?.items ?? []) as FreshLine[];
    const billItems = (bill?.items ?? []) as OrderItem[];
    const orderLineFor = won.order_bill_id
      ? resolveOrderLines(orderItems, won.order_bill_id, billItems)
      : null;
    for (const it of (won.items ?? []) as { sku: string; qty: number; bill_line_index: number; order_line_index: number | null }[]) {
      // Order-anchored notes snapshot bill_line_index === order_line_index, so
      // either key finds the line; order_line_index is the honest one to read.
      const index = orderLineFor ? orderLineFor[it.bill_line_index] : it.order_line_index;
      const qty = Math.trunc(Number(it.qty) || 0);
      if (index == null || qty <= 0) { blocked.push(it.sku); continue; }
      const w = await patchOrderLine(
        won.order_id,
        index,
        (fresh) => ({ returned_qty: Math.max(0, r2(returnedQty(fresh) - qty)) }),
        (fresh) => (fresh.sku !== it.sku ? "line moved" : null),
      );
      if (!w.ok) blocked.push(it.sku);
    }
  }

  // Compensate stock from what ACTUALLY posted, never from the restock intent
  // on the snapshot — a movement that failed at issue must not be removed now.
  const { data: moves } = await admin
    .from("stock_movements").select("sku, delta").eq("ref_type", "credit_note").eq("ref_id", noteId);
  const netBySku = new Map<string, number>();
  for (const m of moves ?? []) {
    const sku = String(m.sku ?? "").toUpperCase();
    if (!sku) continue;
    netBySku.set(sku, (netBySku.get(sku) ?? 0) + (Number(m.delta) || 0));
  }
  const moveFailed: string[] = [];
  for (const [sku, net] of netBySku) {
    if (net === 0) continue;
    const res = await applyMovement({
      sku,
      delta: -Math.trunc(net),
      reason: "correction",
      refType: "credit_note",
      refId: noteId,
      note: `${won.note_number} voided — restock reversed`,
      createdBy: staff.email,
    });
    if (!res.ok) moveFailed.push(sku);
  }

  if (won.order_id) revalidatePath(`/admin/orders/${won.order_id}`);
  revalidatePath("/admin/orders");
  revalidatePath("/admin/credit-notes");
  if (won.buyer_id) revalidatePath(`/admin/buyers/${won.buyer_id}`);
  revalidatePath("/admin/dashboard");

  const warnings = [
    ...(moveFailed.length ? [`stock was NOT reversed for ${moveFailed.join(", ")} — adjust in Stock take`] : []),
    ...(blocked.length ? [`the returned quantity could not be cleared on ${blocked.join(", ")} — check the order lines`] : []),
  ];
  return { ok: true, ...(warnings.length ? { warning: `Credit note voided, but ${warnings.join("; ")}.` } : {}) };
}

/**
 * Spend wallet credit against an order. The overdraft check lives inside the
 * apply_credit RPC, which locks the buyer row and recomputes the balance in
 * the same transaction as the insert — a JS re-check here would be a race, not
 * a guard, so it is deliberately not repeated.
 */
export async function applyCreditToOrder(input: {
  orderId: string;
  amount: number;
  clientRef: string;
}): Promise<{ ok: boolean; error?: string; balance?: number }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();

  if (!CLIENT_REF.test(input.clientRef ?? "")) return { ok: false, error: "Missing a request id — reload and retry." };

  const { data: order } = await admin
    .from("orders")
    .select("id, order_number, buyer_id, status, total_amount, advance_amount, credit_applied")
    .eq("id", input.orderId)
    .maybeSingle();
  if (!order) return { ok: false, error: "Order not found." };
  if (order.status === "cancelled") return { ok: false, error: "This order is cancelled — credit can't be applied to it." };
  if (!order.buyer_id) return { ok: false, error: "This order has no party to draw credit from." };

  const due = r2(
    Math.max(0, (Number(order.total_amount) || 0) - (Number(order.advance_amount) || 0) - (Number(order.credit_applied) || 0)),
  );
  if (due <= 0) return { ok: false, error: `${order.order_number} has nothing left to settle.` };

  const amount = validateCreditAmount(input.amount);
  if (!amount.ok) return { ok: false, error: amount.error };
  if (amount.value > due) return { ok: false, error: `${order.order_number} only has ${formatINR(due)} left to settle.` };

  const { data, error } = await admin.rpc("apply_credit", {
    p_buyer: order.buyer_id,
    p_order: order.id,
    p_amount: amount.value,
    p_client_ref: input.clientRef,
    p_note: `Applied to ${order.order_number}`,
    p_created_by: staff.email,
  });
  if (error) return { ok: false, error: rpcError(error.message, "Could not apply the credit — retry.") };

  revalidatePath(`/admin/orders/${order.id}`);
  revalidatePath("/admin/orders");
  revalidatePath(`/admin/buyers/${order.buyer_id}`);
  revalidatePath("/admin/credit-notes");
  revalidatePath("/admin/dashboard");
  return { ok: true, balance: Number(data) || 0 };
}

/** Undo one application. cl_unapply_once_idx makes a double tap a no-op. */
export async function unapplyCredit(entryId: string): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();

  const { data: entry } = await admin
    .from("credit_ledger").select("id, buyer_id, ref_type, ref_id, reason").eq("id", entryId).maybeSingle();
  if (!entry) return { ok: false, error: "That credit application no longer exists." };

  const { error } = await admin.rpc("unapply_credit", { p_entry: entryId, p_created_by: staff.email });
  if (error) {
    if (error.code === "23505") return { ok: false, error: "This application has already been reversed." };
    return { ok: false, error: rpcError(error.message, "Could not reverse the credit — retry.") };
  }

  if (entry.ref_type === "order" && entry.ref_id) revalidatePath(`/admin/orders/${entry.ref_id}`);
  revalidatePath("/admin/orders");
  revalidatePath(`/admin/buyers/${entry.buyer_id}`);
  revalidatePath("/admin/credit-notes");
  revalidatePath("/admin/dashboard");
  return { ok: true };
}

/**
 * Settle a return across the owner's three routes, splittably (Ansh, 21 Sep):
 *   1) credit note — kept on account   2) refunded   3) adjusted against a balance
 *
 * Leg 1 writes NOTHING: it is whatever the other two did not consume, which is
 * also exactly what the wallet already reports as that note's remaining. Both
 * consumption rows land in ONE transaction inside settle_return — a refund that
 * succeeds while the adjustment fails is a half-settled return no surface can
 * explain.
 *
 * The adjusted order may be ANY open order of the same buyer, not only the one
 * returned (owner's call, 21 Sep) — a buyer who returns against one order and
 * owes on another is the normal case in wholesale.
 */
export async function settleReturn(input: {
  noteId: string;
  refund: number;
  adjust: number;
  orderId?: string | null;
  method?: string | null;
  reference?: string | null;
  clientRef: string;
}): Promise<{ ok: boolean; error?: string; balance?: number }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  if (!CLIENT_REF.test(input.clientRef ?? "")) return { ok: false, error: "Missing a request id — reload and retry." };

  const refund = r2(Number(input.refund) || 0);
  const adjust = r2(Number(input.adjust) || 0);
  if (refund < 0 || adjust < 0) return { ok: false, error: "A settlement amount cannot be negative." };
  if (refund === 0 && adjust === 0) {
    // "Leave it all as credit" is a real answer and writes nothing.
    return { ok: true };
  }
  if (refund > 0 && !(input.method ?? "").trim()) {
    return { ok: false, error: "Say how the money went out — cash, bank transfer, UPI or cheque." };
  }
  if (adjust > 0 && !input.orderId) {
    return { ok: false, error: "Pick the order the credit is being set against." };
  }

  const admin = createAdminClient();
  const { data: note } = await admin
    .from("credit_notes").select("id, note_number, buyer_id, total, status").eq("id", input.noteId).maybeSingle();
  if (!note) return { ok: false, error: "That credit note no longer exists." };
  if (note.status !== "issued") return { ok: false, error: "A void credit note cannot be settled." };

  // The per-note cap, the per-order due cap and the wallet cap all live in the
  // RPC, under a lock — these are the friendly versions, not the guards.
  const { data: balance, error } = await admin.rpc("settle_return", {
    p_note: input.noteId,
    p_refund: refund,
    p_adjust: adjust,
    p_order: input.orderId ?? null,
    p_method: (input.method ?? "").trim() || null,
    p_reference: (input.reference ?? "").trim() || null,
    p_client_ref: input.clientRef,
    p_created_by: staff.email,
  });
  if (error) return { ok: false, error: error.message };

  const legs = [
    refund > 0 ? `${formatINR(refund)} refunded by ${(input.method ?? "").trim()}` : null,
    adjust > 0 ? `${formatINR(adjust)} set against an order` : null,
  ].filter(Boolean).join(", ");
  await writeAuditEvent({
    eventType: "credit_settled",
    buyerId: note.buyer_id,
    staffUserId: staff.id,
    notes: `${note.note_number} (${formatINR(Number(note.total) || 0)}): ${legs}${input.reference ? ` — ${input.reference}` : ""}`,
  });

  revalidatePath("/admin/credit-notes");
  revalidatePath("/admin/orders");
  if (input.orderId) revalidatePath(`/admin/orders/${input.orderId}`);
  if (note.buyer_id) revalidatePath(`/admin/buyers/${note.buyer_id}`);
  revalidatePath("/admin/dashboard");
  return { ok: true, balance: balance == null ? undefined : Number(balance) };
}
