import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import {
  allocateConsumption,
  returnedByBillLine,
  walletBalance,
  type CreditLineSnapshot,
  type CreditNoteLike,
  type NoteAllocation,
  type WalletEntry,
  type WalletGrant,
} from "@/lib/credit-core";
import type { TaxMode } from "@/lib/types";

// Server reads for every credit surface (11 Sep). One module so the register,
// the order page, the buyer wallet and the dashboard all read the same shapes.
//
// Two rules hold everywhere in here:
//  * PostgREST hands numerics back as strings — coerce with Number() at the
//    boundary or Σ over strings concatenates.
//  * A credit note IS the grant (migration 0046), so a wallet balance is
//    Σ(issued notes) − Σ(consumption); there is no "+" ledger row to read.

const r2 = (n: number) => Math.round(n * 100) / 100;

const NOTE_COLUMNS =
  "id, note_number, kind, buyer_id, order_id, order_bill_id, source_bill_number, source_bill_date, items, " +
  "source_subtotal, discount_share, subtotal, tax_mode, tax_rate, tax_amount, total, reason, note_date, " +
  "status, voided_at, void_reason, pdf_url, created_by, created_at";

export interface CreditNoteRow {
  id: string;
  note_number: string;
  kind: "return" | "manual";
  buyer_id: string | null;
  order_id: string | null;
  order_bill_id: string | null;
  source_bill_number: string | null;
  source_bill_date: string | null;
  items: CreditLineSnapshot[];
  source_subtotal: number;
  discount_share: number;
  subtotal: number;
  tax_mode: TaxMode | null;
  tax_rate: number | null;
  tax_amount: number;
  total: number;
  reason: string;
  note_date: string;
  status: "issued" | "void";
  voided_at: string | null;
  void_reason: string | null;
  pdf_url: string | null;
  created_by: string;
  created_at: string;
}

export interface WalletEntryRow {
  id: string;
  buyer_id: string;
  delta: number;
  reason: string;
  ref_type: string | null;
  ref_id: string | null;
  note: string | null;
  effective_date: string;
  created_at: string;
  created_by: string;
  orderNumber?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST row payload
function toNote(row: any): CreditNoteRow {
  return {
    id: row.id,
    note_number: row.note_number,
    kind: row.kind,
    buyer_id: row.buyer_id ?? null,
    order_id: row.order_id ?? null,
    order_bill_id: row.order_bill_id ?? null,
    source_bill_number: row.source_bill_number ?? null,
    source_bill_date: row.source_bill_date ?? null,
    items: (row.items ?? []) as CreditLineSnapshot[],
    source_subtotal: Number(row.source_subtotal) || 0,
    discount_share: Number(row.discount_share) || 0,
    subtotal: Number(row.subtotal) || 0,
    tax_mode: (row.tax_mode ?? null) as TaxMode | null,
    tax_rate: row.tax_rate == null ? null : Number(row.tax_rate),
    tax_amount: Number(row.tax_amount) || 0,
    total: Number(row.total) || 0,
    reason: row.reason ?? "",
    note_date: row.note_date,
    status: row.status,
    voided_at: row.voided_at ?? null,
    void_reason: row.void_reason ?? null,
    pdf_url: row.pdf_url ?? null,
    created_by: row.created_by ?? "",
    created_at: row.created_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST row payload
function toEntry(row: any): WalletEntryRow {
  return {
    id: row.id,
    buyer_id: row.buyer_id,
    delta: Number(row.delta) || 0,
    reason: row.reason,
    ref_type: row.ref_type ?? null,
    ref_id: row.ref_id ?? null,
    note: row.note ?? null,
    effective_date: row.effective_date,
    created_at: row.created_at,
    created_by: row.created_by ?? "",
  };
}

const asGrant = (n: CreditNoteRow): WalletGrant => ({
  id: n.id,
  total: n.total,
  status: n.status,
  effective_date: n.note_date,
  created_at: n.created_at,
});

const asEntry = (e: WalletEntryRow): WalletEntry => ({
  id: e.id,
  delta: e.delta,
  reason: e.reason,
  effective_date: e.effective_date,
  created_at: e.created_at,
});

/**
 * Everything the order page needs about credit raised against one order: the
 * notes themselves, how much of each BILL line has already come back (the cap
 * the Return picker enforces), and the credit issued from this order.
 */
export async function loadOrderCredit(orderId: string): Promise<{
  notes: CreditNoteRow[];
  returnedByBillLine: Map<string, number>;
  creditTotal: number;
}> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("credit_notes")
    .select(NOTE_COLUMNS)
    .eq("order_id", orderId)
    .order("created_at", { ascending: false });

  const notes = (data ?? []).map(toNote);
  const creditTotal = r2(notes.reduce((s, n) => (n.status === "issued" ? s + n.total : s), 0));
  return {
    notes,
    returnedByBillLine: returnedByBillLine(notes as CreditNoteLike[]),
    creditTotal,
  };
}

/**
 * One party's wallet: the balance, the notes behind it, the consumption rows,
 * and how much of EACH note is left (FIFO, oldest note drained first — the
 * order a person reading the ledger would assume).
 */
export async function loadBuyerWallet(buyerId: string): Promise<{
  balance: number;
  notes: CreditNoteRow[];
  entries: WalletEntryRow[];
  allocation: Map<string, NoteAllocation>;
}> {
  const admin = createAdminClient();
  const [noteRows, entryRows] = await Promise.all([
    fetchAll(admin, "credit_notes", NOTE_COLUMNS, (q) =>
      q.eq("buyer_id", buyerId).order("created_at", { ascending: false }),
    ),
    fetchAll(admin, "credit_ledger", "id, buyer_id, delta, reason, ref_type, ref_id, note, effective_date, created_at, created_by", (q) =>
      q.eq("buyer_id", buyerId).order("effective_date", { ascending: false }).order("created_at", { ascending: false }),
    ),
  ]);

  const notes = noteRows.map(toNote);
  const entries = entryRows.map(toEntry);

  // Order numbers for the history rows. An 'unapplied' row points at the
  // application it reversed, so it inherits that row's order.
  const byId = new Map(entries.map((e) => [e.id, e]));
  const orderIds = new Set<string>();
  for (const e of entries) {
    if (e.ref_type === "order" && e.ref_id) orderIds.add(e.ref_id);
    else if (e.ref_type === "credit_ledger" && e.ref_id) {
      const src = byId.get(e.ref_id);
      if (src?.ref_type === "order" && src.ref_id) orderIds.add(src.ref_id);
    }
  }
  if (orderIds.size > 0) {
    const { data: orders } = await admin.from("orders").select("id, order_number").in("id", [...orderIds]);
    const numberById = new Map((orders ?? []).map((o) => [o.id as string, o.order_number as string]));
    for (const e of entries) {
      const target =
        e.ref_type === "order" ? e.ref_id : e.ref_type === "credit_ledger" && e.ref_id ? byId.get(e.ref_id)?.ref_id ?? null : null;
      e.orderNumber = target ? numberById.get(target) ?? null : null;
    }
  }

  const grants = notes.map(asGrant);
  const ledger = entries.map(asEntry);
  return {
    balance: walletBalance(grants, ledger),
    notes,
    entries,
    allocation: allocateConsumption(grants, ledger),
  };
}

/**
 * What a logged-in BUYER may see of their own wallet.
 *
 * Deliberately narrow: a balance, what each note granted and what is left of
 * it, and where credit went. No staff notes, no cost, no other party's data —
 * the buyer app's pricing firewall (BuyerHome §13) applies here too. Read with
 * the admin client because credit_notes/credit_ledger are RLS-on with no
 * policies, so the caller MUST pass a buyer id it has already authenticated.
 */
export async function loadBuyerWalletPublic(buyerId: string): Promise<{
  balance: number;
  notes: { id: string; number: string; date: string; total: number; remaining: number; reason: string; voided: boolean }[];
  history: { id: string; date: string; amount: number; orderNumber: string | null; kind: "credited" | "used" | "returned" }[];
}> {
  const { balance, notes, entries, allocation } = await loadBuyerWallet(buyerId);
  return {
    balance,
    notes: notes.map((n) => ({
      id: n.id,
      number: n.note_number,
      date: n.note_date,
      total: Number(n.total) || 0,
      remaining: allocation.get(n.id)?.remaining ?? 0,
      reason: n.reason,
      voided: n.status !== "issued",
    })),
    history: [
      ...notes
        .filter((n) => n.status === "issued")
        .map((n) => ({ id: n.id, date: n.note_date, amount: Number(n.total) || 0, orderNumber: null, kind: "credited" as const })),
      ...entries.map((e) => ({
        id: e.id,
        date: e.effective_date,
        amount: Number(e.delta) || 0,
        orderNumber: e.orderNumber ?? null,
        kind: (Number(e.delta) < 0 ? "used" : "returned") as "used" | "returned",
      })),
    ].sort((a, b) => b.date.localeCompare(a.date)),
  };
}

/**
 * The register. Paged with .range() — an un-ranged select would silently stop
 * at PostgREST's 1000-row cap once the series grows.
 */
export async function loadCreditRegister(opts?: { q?: string; limit?: number; offset?: number }): Promise<{
  rows: (CreditNoteRow & { buyerName: string | null; orderNumber: string | null; consumed: number; remaining: number })[];
  total: number;
}> {
  const admin = createAdminClient();
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(opts?.limit)) || 50));
  const offset = Math.max(0, Math.trunc(Number(opts?.offset)) || 0);

  // The search term travels inside a PostgREST filter string, so the
  // characters that structure that string are stripped rather than escaped.
  const term = (opts?.q ?? "").replace(/[%,()*.]/g, " ").trim().slice(0, 60);

  let query = admin.from("credit_notes").select(NOTE_COLUMNS, { count: "exact" });
  if (term) {
    const [{ data: buyers }, { data: orders }] = await Promise.all([
      admin
        .from("buyers")
        .select("id")
        .or(`business_name.ilike.%${term}%,owner_name.ilike.%${term}%`)
        .limit(50),
      admin.from("orders").select("id").ilike("order_number", `%${term}%`).limit(50),
    ]);
    const clauses = [`note_number.ilike.%${term}%`, `source_bill_number.ilike.%${term}%`, `reason.ilike.%${term}%`];
    if (buyers?.length) clauses.push(`buyer_id.in.(${buyers.map((b) => b.id).join(",")})`);
    if (orders?.length) clauses.push(`order_id.in.(${orders.map((o) => o.id).join(",")})`);
    query = query.or(clauses.join(","));
  }

  const { data, count } = await query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);
  const notes = (data ?? []).map(toNote);

  const buyerIds = [...new Set(notes.map((n) => n.buyer_id).filter((v): v is string => !!v))];
  const orderIds = [...new Set(notes.map((n) => n.order_id).filter((v): v is string => !!v))];

  // "How much of THIS note is left" is a per-party FIFO walk, so every note
  // and every consumption row of the parties on this page is needed — not just
  // the page itself.
  const allocation = new Map<string, NoteAllocation>();
  let buyerName = new Map<string, string | null>();
  let orderNumber = new Map<string, string>();

  if (buyerIds.length > 0) {
    const [grantRows, entryRows, buyerRows] = await Promise.all([
      fetchAll(admin, "credit_notes", "id, buyer_id, total, status, note_date, created_at", (q) =>
        q.in("buyer_id", buyerIds).order("id"),
      ),
      fetchAll(admin, "credit_ledger", "id, buyer_id, delta, reason, effective_date, created_at", (q) =>
        q.in("buyer_id", buyerIds).order("id"),
      ),
      admin.from("buyers").select("id, business_name, owner_name").in("id", buyerIds).then((r) => r.data ?? []),
    ]);
    buyerName = new Map(buyerRows.map((b) => [b.id as string, (b.business_name as string | null) ?? (b.owner_name as string | null)]));

    const grantsBy = new Map<string, WalletGrant[]>();
    for (const g of grantRows as { id: string; buyer_id: string; total: number; status: string; note_date: string; created_at: string }[]) {
      const list = grantsBy.get(g.buyer_id) ?? [];
      list.push({ id: g.id, total: Number(g.total) || 0, status: g.status, effective_date: g.note_date, created_at: g.created_at });
      grantsBy.set(g.buyer_id, list);
    }
    const entriesBy = new Map<string, WalletEntry[]>();
    for (const e of entryRows as { id: string; buyer_id: string; delta: number; reason: string; effective_date: string; created_at: string }[]) {
      const list = entriesBy.get(e.buyer_id) ?? [];
      list.push({ id: e.id, delta: Number(e.delta) || 0, reason: e.reason, effective_date: e.effective_date, created_at: e.created_at });
      entriesBy.set(e.buyer_id, list);
    }
    for (const id of buyerIds) {
      for (const [noteId, a] of allocateConsumption(grantsBy.get(id) ?? [], entriesBy.get(id) ?? [])) allocation.set(noteId, a);
    }
  }

  if (orderIds.length > 0) {
    const { data: orders } = await admin.from("orders").select("id, order_number").in("id", orderIds);
    orderNumber = new Map((orders ?? []).map((o) => [o.id as string, o.order_number as string]));
  }

  return {
    rows: notes.map((n) => {
      const a = allocation.get(n.id);
      return {
        ...n,
        buyerName: n.buyer_id ? buyerName.get(n.buyer_id) ?? null : null,
        orderNumber: n.order_id ? orderNumber.get(n.order_id) ?? null : null,
        consumed: a?.consumed ?? 0,
        remaining: a?.remaining ?? (n.status === "issued" ? n.total : 0),
      };
    }),
    total: count ?? notes.length,
  };
}

/**
 * Wallet balance for every party at once — the dashboard tile and the buyers
 * list. fetchAll, not a plain select: a global aggregate that truncates at
 * 1000 rows is wrong in a way nobody can see.
 */
export async function walletBalancesByBuyer(): Promise<Map<string, number>> {
  const admin = createAdminClient();
  const [grantRows, entryRows] = await Promise.all([
    // Ordered by the primary key so fetchAll's .range() pages cannot repeat or
    // skip a row — an aggregate that silently double-counts is worse than one
    // that is merely slow.
    fetchAll<{ buyer_id: string | null; total: number }>(admin, "credit_notes", "buyer_id, total", (q) =>
      q.eq("status", "issued").not("buyer_id", "is", null).order("id"),
    ),
    fetchAll<{ buyer_id: string; delta: number }>(admin, "credit_ledger", "buyer_id, delta", (q) => q.order("id")),
  ]);

  const out = new Map<string, number>();
  for (const g of grantRows) {
    if (!g.buyer_id) continue;
    out.set(g.buyer_id, (out.get(g.buyer_id) ?? 0) + (Number(g.total) || 0));
  }
  for (const e of entryRows) {
    if (!e.buyer_id) continue;
    out.set(e.buyer_id, (out.get(e.buyer_id) ?? 0) + (Number(e.delta) || 0));
  }
  for (const [id, v] of out) out.set(id, r2(v));
  return out;
}
