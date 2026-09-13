import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

// The buyer identity frozen onto a document at the moment it is issued
// (migration 0047). Read the migration header for why this exists; the short
// version is that every invoice, bill and credit note used to look the party
// up LIVE at render time, so one edit to a buyers row rewrote every document
// that party had ever been issued.
//
// THE RULE: the recipient identity on a tax document is the identity at THAT
// DOCUMENT's own issue date. A second bill on the same order legitimately
// differs from the first if the party changed in between. Each document is a
// statement about a moment, not about the order.

export interface BuyerParty {
  business_name: string | null;
  owner_name: string | null;
  phone: string | null;
  city: string | null;
  gstin: string | null;
  address: string | null;
}

/** Provenance — see the 0047 header. */
export type SnapshotSource = "issue" | "issue_backdated" | "queued" | "backfill" | "recapture";

/** The columns to spread into a document INSERT. */
export interface BuyerSnapshotColumns {
  buyer_business_name: string | null;
  buyer_owner_name: string | null;
  buyer_phone: string | null;
  buyer_city: string | null;
  buyer_gstin: string | null;
  buyer_address: string | null;
  buyer_snapshot_at: string;
  buyer_snapshot_source: SnapshotSource;
}

const PARTY_COLUMNS = "business_name, owner_name, phone, city, gstin, address";

/**
 * Capture the party as it stands right now, for a document being issued.
 *
 * `source` must be honest about WHEN this was captured relative to the date the
 * document carries:
 *   "issue"           — issued today, captured today. The normal path.
 *   "issue_backdated" — the document is dated earlier than today (a back-dated
 *                       bill). Today's identity is being stamped on a document
 *                       dated to the past, which is flagged rather than hidden.
 *   "queued"          — arrived through the offline exhibition drainer, so this
 *                       is queue-drain time, not sale time.
 */
export async function captureBuyerSnapshot(
  admin: SupabaseClient,
  buyerId: string,
  source: Exclude<SnapshotSource, "backfill"> = "issue",
): Promise<BuyerSnapshotColumns> {
  const { data } = await admin.from("buyers").select(PARTY_COLUMNS).eq("id", buyerId).maybeSingle();
  const b = (data ?? {}) as Partial<BuyerParty>;
  return {
    buyer_business_name: b.business_name ?? null,
    buyer_owner_name: b.owner_name ?? null,
    buyer_phone: b.phone ?? null,
    buyer_city: b.city ?? null,
    buyer_gstin: b.gstin ?? null,
    buyer_address: b.address ?? null,
    buyer_snapshot_at: new Date().toISOString(),
    buyer_snapshot_source: source,
  };
}

/** True when the document carries a date earlier than today (IST). */
export function snapshotSourceForDate(
  documentDate: string | null | undefined,
  todayIst: string,
): "issue" | "issue_backdated" {
  if (!documentDate) return "issue";
  return documentDate < todayIst ? "issue_backdated" : "issue";
}

/** A row that may or may not carry a snapshot. */
export interface SnapshottedRow {
  buyer_business_name?: string | null;
  buyer_owner_name?: string | null;
  buyer_phone?: string | null;
  buyer_city?: string | null;
  buyer_gstin?: string | null;
  buyer_address?: string | null;
  buyer_snapshot_at?: string | null;
}

export const EMPTY_PARTY: BuyerParty = {
  business_name: null,
  owner_name: null,
  phone: null,
  city: null,
  gstin: null,
  address: null,
};

/**
 * The party to PRINT on a document.
 *
 * buyer_snapshot_at is the only flag this branches on. Null means the row
 * predates its snapshot — which after 0047's backfill can only happen for a row
 * inserted by a pre-0047 instance during the deploy window — so fall back to
 * the live buyers read that used to be the only behaviour. Every other row
 * prints what was frozen at issue, and no later edit can move it.
 */
export async function resolveDocumentParty(
  admin: SupabaseClient,
  row: SnapshottedRow,
  buyerId: string | null | undefined,
): Promise<BuyerParty> {
  if (row.buyer_snapshot_at) {
    return {
      business_name: row.buyer_business_name ?? null,
      owner_name: row.buyer_owner_name ?? null,
      phone: row.buyer_phone ?? null,
      city: row.buyer_city ?? null,
      gstin: row.buyer_gstin ?? null,
      address: row.buyer_address ?? null,
    };
  }
  if (!buyerId) return EMPTY_PARTY;
  const { data } = await admin.from("buyers").select(PARTY_COLUMNS).eq("id", buyerId).maybeSingle();
  return data ? ({ ...EMPTY_PARTY, ...(data as Partial<BuyerParty>) } as BuyerParty) : EMPTY_PARTY;
}
