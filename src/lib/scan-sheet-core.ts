import { formatINR } from "./format";
import { t } from "./strings";

// What the global scan sheet shows for a resolved tag (ScanSheet.tsx), kept
// apart from the component so the rules are testable.

/** A staff answer from /api/scan/resolve — the fields the sheet reads. */
export interface ScanResolved {
  sku: string;
  known: boolean;
  title?: string | null;
  thumb?: string | null;
  retail_price_set?: boolean;
  /** Specs MRP, else the sheet's; null when neither has one. */
  retail_price?: number | null;
  /** Sent to admins only, and only for a SKU with a catalog row. */
  current_qty?: number | null;
  actions: { key: string; label: string; href?: string }[];
}

/**
 * The resolver's answer, or a throw when there is none: an error reply (a
 * signed-out session's 401, a server error) is a failed check, not proof the
 * tag is unknown, so the scanner says "could not check; retry" instead of
 * giving the unknown-tag tone.
 */
export function readResolved(ok: boolean, body: unknown): ScanResolved {
  const d = (body ?? {}) as Partial<ScanResolved> & { error?: unknown };
  if (!ok || d.error || typeof d.sku !== "string" || typeof d.known !== "boolean") {
    throw new Error(typeof d.error === "string" ? d.error : "scan lookup failed");
  }
  return { ...d, actions: Array.isArray(d.actions) ? d.actions : [] } as ScanResolved;
}

/** The MRP line under the title: the price Retail Price Check quotes. */
export function mrpLabel(r: Pick<ScanResolved, "retail_price">): string {
  return r.retail_price != null && r.retail_price > 0 ? `MRP ${formatINR(r.retail_price)}` : "MRP not set";
}

/** "N in stock" when the resolver sent a quantity (admins only); else null. */
export function stockLabel(r: Pick<ScanResolved, "current_qty">): string | null {
  return typeof r.current_qty === "number" && Number.isFinite(r.current_qty) ? `${r.current_qty} in stock` : null;
}

/**
 * The scanner's verdict, given once the resolver has answered: a success beep
 * only for a tag the system knows, the low tone for one it does not.
 */
export function scanVerdict(r: Pick<ScanResolved, "sku" | "known" | "retail_price">): { ok: boolean; message: string } {
  if (!r.known) return { ok: false, message: `${r.sku} — ${t("scan.unknown")}` };
  return { ok: true, message: `${r.sku} — ${mrpLabel(r)}` };
}
