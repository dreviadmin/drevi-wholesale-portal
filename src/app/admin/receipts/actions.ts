"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import { uploadReceiptPhoto } from "@/lib/storage";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { applyMovement, type Movement } from "@/lib/stock-ledger";
import { planReceiptReversal, sameLines, nextFirstReceipt, skuInDesign, RECEIPT_LINE_REF, type CatalogRow, type ReversalPlan } from "@/lib/receipt-reversal";
import type { AuditEventType } from "@/lib/types";

// Goods Receipts (Phase 1 — record-keeping ONLY). Deliberately writes nothing
// to wholesale_products or product_vendor_info: cost/stock authority moves
// here at the Phase 3 cutover, not before (spec §8.6).
//
// Since Log delivery (R3) a receipt CAN carry stock: saveDelivery posts one
// movement per line. So delete and edit undo what a receipt posted, through
// the ledger (30 Sep) — see lib/receipt-reversal.ts for the rules. A receipt
// that never posted anything stays exactly as record-only as it always was.

type Admin = ReturnType<typeof createAdminClient>;

// Carried from an old line to its replacement with the same SKU, so an edit
// in the plain editor does not strip what Log delivery recorded on the line.
const CARRIED = ["design_id", "vendor_sku", "created_design", "supply_mode", "vendor_stock_qty", "making_days", "making_moq", "delivery_days", "supply_note"] as const;

/**
 * Everything the reversal planner reads, FAIL-CLOSED: an unreadable ledger or
 * order table is a refusal, never "nothing to undo" — that is how phantom
 * stock was left behind in the first place.
 */
async function loadReversalContext(admin: Admin, receiptId: string, skus: string[]): Promise<
  { ok: true; movements: Movement[]; otherReceiptSkus: string[]; documents: Map<string, string[]>; catalog: CatalogRow[] } | { ok: false; error: string }
> {
  const wanted = [...new Set(skus.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (wanted.length === 0) return { ok: true, movements: [], otherReceiptSkus: [], documents: new Map(), catalog: [] };
  try {
    const [movements, others, catalog] = await Promise.all([
      fetchAll<Movement>(admin, "stock_movements", "*", (q) => q.in("sku", wanted).order("created_at", { ascending: true })),
      fetchAll<{ sku: string }>(admin, "goods_receipt_lines", "sku", (q) => q.in("sku", wanted).neq("receipt_id", receiptId)),
      fetchAll<CatalogRow>(admin, "wholesale_products", "sku, wholesale_visible, buyer_visible, shopify_live_url, shopify_product_id", (q) => q.in("sku", wanted)),
    ]);
    // Orders and retail bills that name the SKU. items is jsonb, so the
    // containment value must be a JSON STRING — a JS array is serialised as a
    // Postgres array literal and matches nothing.
    const documents = new Map<string, string[]>();
    await Promise.all(wanted.map(async (sku) => {
      const probe = JSON.stringify([{ sku }]);
      const [o, r] = await Promise.all([
        admin.from("orders").select("order_number").contains("items", probe).limit(5),
        admin.from("retail_bills").select("bill_number").contains("items", probe).limit(5),
      ]);
      if (o.error) throw new Error(`orders: ${o.error.message}`);
      if (r.error) throw new Error(`retail bills: ${r.error.message}`);
      const nums = [...(o.data ?? []).map((x) => x.order_number as string), ...(r.data ?? []).map((x) => x.bill_number as string)];
      if (nums.length) documents.set(sku, nums);
    }));
    return { ok: true, movements, otherReceiptSkus: others.map((o) => o.sku), documents, catalog };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Post the plan's negative movements, one per line, against the line they undo. */
async function postReversals(plan: ReversalPlan, why: string, actor: string): Promise<{ ok: boolean; error?: string }> {
  for (const r of plan.reversals) {
    const res = await applyMovement({
      sku: r.sku,
      delta: -r.qty,
      reason: "receipt_reversed",
      refType: RECEIPT_LINE_REF,
      refId: r.lineId,
      note: `${why} · −${r.qty} pc`,
      createdBy: actor,
    });
    // Stop at the first failure: the next attempt re-reads the ledger, and a
    // line already reversed nets to zero there, so nothing is taken twice.
    if (!res.ok) return { ok: false, error: `${r.sku}: ${res.error ?? "stock movement failed"}` };
  }
  return { ok: true };
}

/**
 * Take a SKU the receipt alone brought into being out of billing. The
 * wholesale_visible lock stays (added if missing) so the sheet sync cannot put
 * it back; the row itself stays, as the ledger and registry still name it.
 */
async function withdrawFromBilling(admin: Admin, skus: string[]): Promise<{ ok: boolean; error?: string }> {
  for (const sku of skus) {
    const { data: row, error: readErr } = await admin.from("wholesale_products").select("locked_fields").eq("sku", sku).maybeSingle();
    if (readErr) return { ok: false, error: `${sku}: ${readErr.message}` };
    const locks = new Set<string>(Array.isArray(row?.locked_fields) ? row.locked_fields : []);
    locks.add("wholesale_visible");
    const { error } = await admin.from("wholesale_products").update({ wholesale_visible: false, locked_fields: [...locks] }).eq("sku", sku);
    if (error) return { ok: false, error: `${sku}: ${error.message}` };
  }
  return { ok: true };
}

/**
 * Designs whose first receipt is this one and which no longer have a line on
 * it. Matched by SKU group as well as design_id: edits made before 30 Sep
 * dropped design_id from the lines they rewrote.
 */
async function repointFirstReceipt(admin: Admin, receiptId: string, staying: { sku: string; design_id?: unknown }[]): Promise<{ ok: boolean; error?: string }> {
  const { data: pointing, error } = await admin.from("designs").select("id, base_sku, color").eq("first_receipt_id", receiptId);
  if (error) return { ok: false, error: error.message };
  const ids = (pointing ?? [])
    .filter((d) => !staying.some((l) => l.design_id === d.id || skuInDesign(l.sku, d.base_sku, d.color)))
    .map((d) => d.id as string);
  if (ids.length === 0) return { ok: true };
  const { data: rest, error: restErr } = await admin
    .from("goods_receipt_lines")
    .select("design_id, receipt_id, goods_receipts!inner(receipt_date, created_at)")
    .in("design_id", ids)
    .neq("receipt_id", receiptId);
  if (restErr) return { ok: false, error: restErr.message };
  const remaining = (rest ?? []).map((r) => {
    const g = (Array.isArray(r.goods_receipts) ? r.goods_receipts[0] : r.goods_receipts) as { receipt_date: string; created_at: string };
    return { design_id: r.design_id as string | null, receipt_id: r.receipt_id as string, receipt_date: String(g.receipt_date), created_at: String(g.created_at) };
  });
  for (const [id, next] of nextFirstReceipt(ids, remaining)) {
    const { error: upErr } = await admin.from("designs").update({ first_receipt_id: next }).eq("id", id);
    if (upErr) return { ok: false, error: upErr.message };
  }
  return { ok: true };
}

/** Net stock change per SKU (reversals minus re-posts), withdrawals, then the planner's notes. */
function summarise(plan: ReversalPlan, posted: { sku: string; qty: number }[]): string[] {
  const net = new Map<string, number>();
  for (const r of plan.reversals) net.set(r.sku, (net.get(r.sku) ?? 0) - r.qty);
  for (const p of posted) net.set(p.sku, (net.get(p.sku) ?? 0) + p.qty);
  const moved = [...net].filter(([, d]) => d !== 0).map(([sku, d]) => `${sku} ${d > 0 ? "+" : "−"}${Math.abs(d)}`);
  const out: string[] = [];
  if (moved.length) out.push(`Stock: ${moved.join(", ")}.`);
  if (plan.withdraw.length) out.push(`Withdrawn from billing: ${plan.withdraw.join(", ")}.`);
  return [...out, ...plan.notes];
}

export interface ReceiptLineInput {
  sku: string;
  description?: string;
  qty: number;
  unitCost: number;
}
export interface ReceiptInput {
  vendorId: string;
  receiptDate?: string; // yyyy-mm-dd; default today IST
  billAmount?: number | null;
  notes?: string;
  clientRef?: string;
  gst?: { mode: "kaccha" | "pakka" | null; rate?: number | null; inclusive?: boolean | null };
  lines: ReceiptLineInput[];
}

function cleanLines(lines: ReceiptLineInput[]): { ok: true; lines: { sku: string; description: string; qty: number; unit_cost: number; position: number }[] } | { ok: false; error: string } {
  if (!lines || lines.length === 0) return { ok: false, error: "A receipt needs at least one line." };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const sku = (l.sku ?? "").trim().toUpperCase();
    if (!sku) return { ok: false, error: `Line ${i + 1} has no SKU.` };
    const qty = Math.floor(Number(l.qty));
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: `${sku}: quantity must be at least 1.` };
    const unitCost = Math.round((Number(l.unitCost) || 0) * 100) / 100;
    if (unitCost < 0) return { ok: false, error: `${sku}: cost cannot be negative.` };
    out.push({ sku, description: (l.description ?? "").trim(), qty, unit_cost: unitCost, position: i });
  }
  return { ok: true, lines: out };
}

function istToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export async function createReceipt(input: ReceiptInput): Promise<{ ok: boolean; id?: string; receiptNumber?: string; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();

  if (!input.vendorId) return { ok: false, error: "Pick a vendor." };
  const parsed = cleanLines(input.lines);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  // Idempotency — a double-tap or retry resolves to the existing receipt.
  const clientRef = input.clientRef?.trim() || null;
  if (clientRef) {
    const { data: existing } = await admin.from("goods_receipts").select("id, receipt_number").eq("client_ref", clientRef).maybeSingle();
    if (existing) {
      // Only honour the replay if the first attempt actually landed its lines —
      // a crash between header and lines must not surface as a success.
      const { count } = await admin.from("goods_receipt_lines").select("*", { count: "exact", head: true }).eq("receipt_id", existing.id);
      if ((count ?? 0) > 0) return { ok: true, id: existing.id, receiptNumber: existing.receipt_number };
      await admin.from("goods_receipts").delete().eq("id", existing.id); // orphan header — recreate cleanly
    }
  }

  const receiptDate = /^\d{4}-\d{2}-\d{2}$/.test(input.receiptDate ?? "") ? input.receiptDate! : istToday();
  const ymd = receiptDate.replace(/-/g, "");

  // GR numbering rides the existing atomic order-counter machinery (§8.2).
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data: numData, error: numErr } = await admin.rpc("next_order_number", { p_prefix: "GR", p_day: ymd });
    if (numErr || !numData) return { ok: false, error: numErr?.message ?? "Could not generate a receipt number." };
    const { data: rec, error } = await admin
      .from("goods_receipts")
      .insert({
        receipt_number: numData as string,
        vendor_id: input.vendorId,
        receipt_date: receiptDate,
        bill_amount: input.billAmount != null && Number.isFinite(Number(input.billAmount)) ? Number(input.billAmount) : null,
        gst_mode: input.gst?.mode ?? null,
        gst_rate: input.gst?.mode === "pakka" ? input.gst?.rate ?? null : null,
        gst_inclusive: input.gst?.mode === "pakka" ? input.gst?.inclusive ?? null : null,
        notes: (input.notes ?? "").trim(),
        client_ref: clientRef,
        created_by: staff.email,
      })
      .select("id, receipt_number")
      .single();
    if (error) {
      if (error.code === "23505" && clientRef) {
        const { data: won } = await admin.from("goods_receipts").select("id, receipt_number").eq("client_ref", clientRef).maybeSingle();
        if (won) return { ok: true, id: won.id, receiptNumber: won.receipt_number };
        continue; // receipt_number collision from a retry — re-reserve
      }
      if (error.code === "23505") continue;
      return { ok: false, error: error.message };
    }
    const { error: lineErr } = await admin.from("goods_receipt_lines").insert(parsed.lines.map((l) => ({ ...l, receipt_id: rec.id })));
    if (lineErr) {
      await admin.from("goods_receipts").delete().eq("id", rec.id);
      return { ok: false, error: `Lines failed: ${lineErr.message}` };
    }
    await writeAuditEvent({ eventType: "receipt_created" as AuditEventType, staffUserId: staff.id, notes: `${rec.receipt_number} · ${parsed.lines.length} lines` });
    revalidatePath("/admin/receipts");
    revalidatePath("/admin/vendors");
    return { ok: true, id: rec.id, receiptNumber: rec.receipt_number };
  }
  return { ok: false, error: "Could not reserve a receipt number — try again." };
}

export async function updateReceipt(
  id: string,
  input: Omit<ReceiptInput, "clientRef">,
): Promise<{ ok: boolean; error?: string; notes?: string[] }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();
  const { data: rec } = await admin.from("goods_receipts").select("id, receipt_number, created_at").eq("id", id).maybeSingle();
  if (!rec) return { ok: false, error: "Receipt not found." };
  const parsed = cleanLines(input.lines);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  // Decide the stock side BEFORE writing anything, so a refusal leaves the
  // receipt exactly as it was.
  const { data: oldLines, error: oldErr } = await admin
    .from("goods_receipt_lines")
    .select(`id, sku, qty, unit_cost, description, position, ${CARRIED.join(", ")}`)
    .eq("receipt_id", id);
  if (oldErr) return { ok: false, error: oldErr.message };
  const old = (oldLines ?? []) as unknown as ({ id: string; sku: string; qty: number; unit_cost: number; description: string | null; position: number | null } & Record<(typeof CARRIED)[number], unknown>)[];
  const replaceLines = !sameLines(old, parsed.lines);
  let plan: ReversalPlan | null = null;
  if (replaceLines) {
    const ctx = await loadReversalContext(admin, id, [...old.map((l) => l.sku), ...parsed.lines.map((l) => l.sku)]);
    if (!ctx.ok) return { ok: false, error: `Could not check stock before saving — nothing was changed. (${ctx.error})` };
    const decision = planReceiptReversal({
      mode: "replace",
      receiptNumber: rec.receipt_number,
      receivedAt: rec.created_at,
      oldLines: old.map((l) => ({ id: l.id, sku: l.sku, qty: l.qty })),
      newLines: parsed.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
      ...ctx,
    });
    if (!decision.ok) return { ok: false, error: decision.error };
    plan = decision.plan;
  }

  const receiptDate = /^\d{4}-\d{2}-\d{2}$/.test(input.receiptDate ?? "") ? input.receiptDate! : undefined;
  const { error } = await admin
    .from("goods_receipts")
    .update({
      vendor_id: input.vendorId,
      ...(receiptDate ? { receipt_date: receiptDate } : {}),
      bill_amount: input.billAmount != null && Number.isFinite(Number(input.billAmount)) ? Number(input.billAmount) : null,
      gst_mode: input.gst?.mode ?? null,
      gst_rate: input.gst?.mode === "pakka" ? input.gst?.rate ?? null : null,
      gst_inclusive: input.gst?.mode === "pakka" ? input.gst?.inclusive ?? null : null,
      notes: (input.notes ?? "").trim(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  if (!plan) {
    await writeAuditEvent({ eventType: "receipt_updated" as AuditEventType, staffUserId: staff.id, notes: rec.receipt_number });
    revalidatePath("/admin/receipts");
    revalidatePath(`/admin/receipts/${id}`);
    return { ok: true };
  }

  // Full line replacement, insert-first: if the insert fails the old lines
  // survive untouched; if the delete of old ids fails we briefly show
  // duplicates (visible + recoverable) instead of losing data.
  const carried = new Map<string, Record<string, unknown>>();
  for (const l of [...old].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    const sku = l.sku.toUpperCase();
    if (!carried.has(sku)) carried.set(sku, Object.fromEntries(CARRIED.map((c) => [c, l[c]])));
  }
  const { data: inserted, error: insErr } = await admin
    .from("goods_receipt_lines")
    .insert(parsed.lines.map((l) => ({ ...(carried.get(l.sku) ?? {}), ...l, receipt_id: id })))
    .select("id, position");
  if (insErr) return { ok: false, error: `Lines failed: ${insErr.message}` };

  // Stock follows the lines: the old ones give back what is still live, the
  // new ones post their own quantity — each against its own line, so a later
  // delete or edit knows exactly what every line holds.
  const why = `${rec.receipt_number} edited`;
  const back = await postReversals(plan, `${why} — line replaced`, staff.email);
  if (!back.ok) return { ok: false, error: `Stock could not be adjusted (${back.error}) — edit again to finish; nothing is taken back twice.` };
  const newIds = new Map((inserted ?? []).map((r) => [r.position as number, r.id as string]));
  const posted: { sku: string; qty: number }[] = [];
  for (let i = 0; i < parsed.lines.length; i++) {
    if (!plan.post[i]) continue;
    const l = parsed.lines[i];
    const lineId = newIds.get(l.position);
    if (!lineId) continue;
    const res = await applyMovement({ sku: l.sku, delta: l.qty, reason: "receipt", refType: RECEIPT_LINE_REF, refId: lineId, note: `${why} · ${l.qty} pc`, createdBy: staff.email });
    if (!res.ok) return { ok: false, error: `${l.sku}: stock could not be posted (${res.error}) — edit again to finish.` };
    posted.push({ sku: l.sku, qty: l.qty });
  }

  if (old.length > 0) {
    const { error: delErr } = await admin.from("goods_receipt_lines").delete().in("id", old.map((l) => l.id));
    if (delErr) return { ok: false, error: `Old lines could not be removed (${delErr.message}) — the receipt shows duplicates; edit again to fix.` };
  }
  const wd = await withdrawFromBilling(admin, plan.withdraw);
  const fr = await repointFirstReceipt(admin, id, parsed.lines.map((l) => ({ sku: l.sku, design_id: carried.get(l.sku)?.design_id })));
  const notes = summarise(plan, posted);
  if (!wd.ok) notes.push(`Could not withdraw from billing (${wd.error}) — hide it in Manage Catalog.`);
  if (!fr.ok) notes.push(`Could not update the design's first receipt (${fr.error}).`);

  await writeAuditEvent({ eventType: "receipt_updated" as AuditEventType, staffUserId: staff.id, notes: [rec.receipt_number, ...notes].join(" · ") });
  revalidatePath("/admin/receipts");
  revalidatePath(`/admin/receipts/${id}`);
  return { ok: true, notes };
}

export async function deleteReceipt(id: string): Promise<{ ok: boolean; error?: string; notes?: string[] }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();
  const { data: rec } = await admin.from("goods_receipts").select("receipt_number, bill_photo_path, created_at").eq("id", id).maybeSingle();
  if (!rec) return { ok: false, error: "Receipt not found." };

  const { data: lines, error: linesErr } = await admin.from("goods_receipt_lines").select("id, sku, qty").eq("receipt_id", id);
  if (linesErr) return { ok: false, error: linesErr.message };
  const ctx = await loadReversalContext(admin, id, (lines ?? []).map((l) => l.sku));
  if (!ctx.ok) return { ok: false, error: `Could not check stock before deleting — nothing was changed. (${ctx.error})` };
  const decision = planReceiptReversal({ mode: "delete", receiptNumber: rec.receipt_number, receivedAt: rec.created_at, oldLines: lines ?? [], ...ctx });
  if (!decision.ok) return { ok: false, error: decision.error };
  const plan = decision.plan;

  // Everything the receipt left behind goes BEFORE the row: a failure part-way
  // leaves the receipt visible, and deleting again finishes the job (the
  // ledger already shows which lines were reversed).
  const back = await postReversals(plan, `${rec.receipt_number} deleted`, staff.email);
  if (!back.ok) return { ok: false, error: `Stock could not be taken back (${back.error}) — the receipt is still here; delete again to finish.` };
  const wd = await withdrawFromBilling(admin, plan.withdraw);
  if (!wd.ok) return { ok: false, error: `Could not withdraw from billing (${wd.error}) — the receipt is still here; delete again to finish.` };
  // designs.first_receipt_id has no ON DELETE, so a design born on this
  // receipt blocks the delete until it points elsewhere.
  const fr = await repointFirstReceipt(admin, id, []);
  if (!fr.ok) return { ok: false, error: `Could not release the design linked to this receipt (${fr.error}) — delete again to finish.` };

  const { error } = await admin.from("goods_receipts").delete().eq("id", id); // lines cascade
  if (error) return { ok: false, error: `${error.message}${plan.reversals.length ? " — stock was already taken back; delete again to finish" : ""}` };
  if (rec.bill_photo_path) {
    // Best-effort AFTER the row is gone — a failed row-delete must never
    // orphan the bill evidence.
    await admin.storage.from("receipt-photos").remove([rec.bill_photo_path]);
  }
  const notes = summarise(plan, []);
  await writeAuditEvent({ eventType: "receipt_deleted" as AuditEventType, staffUserId: staff.id, notes: [rec.receipt_number, ...notes].join(" · ") });
  revalidatePath("/admin/receipts");
  revalidatePath("/admin/studio");
  return { ok: true, notes };
}

// Bill photo — camera or gallery; private bucket, signed URLs on read.
export async function uploadReceiptBill(receiptId: string, formData: FormData): Promise<{ ok: boolean; error?: string }> {
  try { await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const file = formData.get("bill");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "No image supplied." };
  if (file.size > 5 * 1024 * 1024) return { ok: false, error: "Image must be under 5 MB." };
  try {
    const path = await uploadReceiptPhoto(receiptId, file);
    const admin = createAdminClient();
    await admin.from("goods_receipts").update({ bill_photo_path: path, updated_at: new Date().toISOString() }).eq("id", receiptId);
    revalidatePath(`/admin/receipts/${receiptId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
