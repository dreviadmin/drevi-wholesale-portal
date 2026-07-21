"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import { uploadReceiptPhoto } from "@/lib/storage";
import type { AuditEventType } from "@/lib/types";

// Goods Receipts (Phase 1 — record-keeping ONLY). Deliberately writes nothing
// to wholesale_products or product_vendor_info: cost/stock authority moves
// here at the Phase 3 cutover, not before (spec §8.6).

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
): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();
  const { data: rec } = await admin.from("goods_receipts").select("id, receipt_number").eq("id", id).maybeSingle();
  if (!rec) return { ok: false, error: "Receipt not found." };
  const parsed = cleanLines(input.lines);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const receiptDate = /^\d{4}-\d{2}-\d{2}$/.test(input.receiptDate ?? "") ? input.receiptDate! : undefined;
  const { error } = await admin
    .from("goods_receipts")
    .update({
      vendor_id: input.vendorId,
      ...(receiptDate ? { receipt_date: receiptDate } : {}),
      bill_amount: input.billAmount != null && Number.isFinite(Number(input.billAmount)) ? Number(input.billAmount) : null,
      notes: (input.notes ?? "").trim(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  // Full line replacement, insert-first: if the insert fails the old lines
  // survive untouched; if the delete of old ids fails we briefly show
  // duplicates (visible + recoverable) instead of losing data.
  const { data: oldLines, error: oldErr } = await admin.from("goods_receipt_lines").select("id").eq("receipt_id", id);
  if (oldErr) return { ok: false, error: oldErr.message };
  const { error: insErr } = await admin.from("goods_receipt_lines").insert(parsed.lines.map((l) => ({ ...l, receipt_id: id })));
  if (insErr) return { ok: false, error: `Lines failed: ${insErr.message}` };
  if (oldLines && oldLines.length > 0) {
    const { error: delErr } = await admin.from("goods_receipt_lines").delete().in("id", oldLines.map((l) => l.id));
    if (delErr) return { ok: false, error: `Old lines could not be removed (${delErr.message}) — the receipt shows duplicates; edit again to fix.` };
  }

  await writeAuditEvent({ eventType: "receipt_updated" as AuditEventType, staffUserId: staff.id, notes: rec.receipt_number });
  revalidatePath("/admin/receipts");
  revalidatePath(`/admin/receipts/${id}`);
  return { ok: true };
}

export async function deleteReceipt(id: string): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();
  const { data: rec } = await admin.from("goods_receipts").select("receipt_number, bill_photo_path").eq("id", id).maybeSingle();
  if (!rec) return { ok: false, error: "Receipt not found." };
  const { error } = await admin.from("goods_receipts").delete().eq("id", id); // lines cascade
  if (error) return { ok: false, error: error.message };
  if (rec.bill_photo_path) {
    // Best-effort AFTER the row is gone — a failed row-delete must never
    // orphan the bill evidence.
    await admin.storage.from("receipt-photos").remove([rec.bill_photo_path]);
  }
  await writeAuditEvent({ eventType: "receipt_deleted" as AuditEventType, staffUserId: staff.id, notes: rec.receipt_number });
  revalidatePath("/admin/receipts");
  return { ok: true };
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
