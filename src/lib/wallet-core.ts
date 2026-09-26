// Pure rules for the Drevi Wallet (26 Sep). No server-only imports, no
// supabase, no fetch — everything here is unit-tested, the same way
// credit-core.ts carries the credit-note rules. The server module
// (wallet.ts) applies these to rows; the routes never do arithmetic.
//
// Money is integer paise everywhere. Shopify gives decimal strings; toPaise()
// is the only place a decimal is ever parsed.

export const WALLET_DEFAULTS = {
  welcomePaise: 100_000,        // ₹1,000
  earnPercent: 10,              // of the amount actually paid
  minOrderPaise: 500_000,       // ₹5,000 subtotal to redeem
  expiryMonths: 12,             // rolling, from the latest credit
  otpTtlSeconds: 10 * 60,
  otpMaxAttempts: 5,
  otpPerPhonePer10Min: 3,
  otpPerIpPer10Min: 12,
  sessionDays: 30,
  redemptionTtlSeconds: 30 * 60,
} as const;

/**
 * Normalise a phone to E.164 digits without the plus, Indian numbers assumed
 * when no country code is given. Returns null for anything that isn't a
 * plausible mobile number, so a typo never becomes a wallet.
 *
 *   "98765 43210"     -> "919876543210"
 *   "+91 98765-43210" -> "919876543210"
 *   "09876543210"     -> "919876543210"
 *   "1234"            -> null
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = "91" + d;
  if (d.length === 12 && d.startsWith("91")) {
    // Indian mobiles start 6–9. Anything else is a landline or a typo.
    if (!/^91[6-9]\d{9}$/.test(d)) return null;
    return d;
  }
  // Other countries: 11–15 digits, no leading zero. Kept permissive; the
  // WhatsApp send is the real verification.
  if (d.length >= 11 && d.length <= 15 && !d.startsWith("0")) return d;
  return null;
}

/** "919876543210" -> "+91 98765 43210" for display. */
export function formatPhone(e164: string): string {
  if (/^91\d{10}$/.test(e164)) return `+91 ${e164.slice(2, 7)} ${e164.slice(7)}`;
  return "+" + e164;
}

/** Decimal string or number of rupees -> integer paise. "1299.5" -> 129950. */
export function toPaise(amount: string | number | null | undefined): number {
  if (amount === null || amount === undefined || amount === "") return 0;
  const n = typeof amount === "number" ? amount : Number(String(amount).replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Integer paise -> "1,299.50" style rupee string (no symbol) for Shopify inputs. */
export function paiseToDecimal(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Integer paise -> "₹1,299" with Indian grouping, whole rupees. */
export function formatPaise(paise: number): string {
  const rupees = Math.floor(Math.abs(paise) / 100);
  const s = rupees.toString();
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3 : last3;
  return (paise < 0 ? "-₹" : "₹") + grouped;
}

/**
 * The amount an order earns on. "Actually paid" means: every merchandise line
 * at its discounted total — which already nets out the wallet code and any
 * other discount — and nothing for the fee helpers (COD fee, alteration),
 * which are charges, not purchases. Shipping and tax are outside it.
 */
export interface EarnLine {
  productType: string | null | undefined;
  discountedTotalPaise: number;
  /** Quantity refunded so far, if any; scales the line down. */
  quantity: number;
  refundedQuantity?: number;
}

export function isFeeHelper(productType: string | null | undefined): boolean {
  return (productType ?? "").trim().toLowerCase() === "service";
}

export function earnBasePaise(lines: EarnLine[]): number {
  let base = 0;
  for (const l of lines) {
    if (isFeeHelper(l.productType)) continue;
    const q = Math.max(0, l.quantity);
    const rq = Math.min(q, Math.max(0, l.refundedQuantity ?? 0));
    if (q === 0) continue;
    // Refunds come back per unit; scale the line's discounted total by what
    // remains, rounding down so a refund never leaves the customer over-earned.
    base += Math.floor((l.discountedTotalPaise * (q - rq)) / q);
  }
  return base;
}

/** 10% of the base, whole rupees, rounded down. Never negative. */
export function earnAmountPaise(basePaise: number, percent: number = WALLET_DEFAULTS.earnPercent): number {
  if (basePaise <= 0) return 0;
  const raw = Math.floor((basePaise * percent) / 100);
  return raw - (raw % 100); // whole rupees
}

/**
 * How much a cart can take from the wallet. The minimum is on the subtotal
 * BEFORE the wallet — the rule is "orders of ₹5,000", not "pay ₹5,000 after
 * credit". Reserved is the sum of open redemptions, so a second tab can't
 * mint against the same rupees.
 */
export function redeemablePaise(input: {
  balancePaise: number;
  reservedPaise: number;
  subtotalPaise: number;
  requestedPaise?: number | null;
  minOrderPaise?: number;
}): { amount: number; reason: "ok" | "below_minimum" | "no_balance" | "invalid" } {
  const min = input.minOrderPaise ?? WALLET_DEFAULTS.minOrderPaise;
  if (!Number.isFinite(input.subtotalPaise) || input.subtotalPaise <= 0) return { amount: 0, reason: "invalid" };
  if (input.subtotalPaise < min) return { amount: 0, reason: "below_minimum" };
  const available = Math.max(0, input.balancePaise - Math.max(0, input.reservedPaise));
  if (available <= 0) return { amount: 0, reason: "no_balance" };
  let amount = Math.min(available, input.subtotalPaise);
  if (input.requestedPaise !== undefined && input.requestedPaise !== null) {
    if (!Number.isFinite(input.requestedPaise) || input.requestedPaise <= 0) return { amount: 0, reason: "invalid" };
    amount = Math.min(amount, Math.floor(input.requestedPaise));
  }
  amount = amount - (amount % 100); // whole rupees only; Shopify rounds oddly on paise
  if (amount <= 0) return { amount: 0, reason: "invalid" };
  return { amount, reason: "ok" };
}

/** Rolling expiry: every credit restarts the clock. */
export function nextExpiry(from: Date, months: number = WALLET_DEFAULTS.expiryMonths): Date {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

export function isExpired(expiresAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return false;
  const t = typeof expiresAt === "string" ? new Date(expiresAt).getTime() : expiresAt.getTime();
  return Number.isFinite(t) && t <= now.getTime();
}

/**
 * Apply a signed movement to a balance. Throws rather than letting a debit
 * take the balance below zero — the caller decides whether to clamp (an
 * expiry, a reversal that outruns the balance) by passing `clamp`.
 */
export function applyMovement(balancePaise: number, amountPaise: number, clamp = false): { balanceAfter: number; applied: number } {
  const target = balancePaise + amountPaise;
  if (target >= 0) return { balanceAfter: target, applied: amountPaise };
  if (!clamp) throw new Error(`Movement of ${amountPaise} would take balance ${balancePaise} below zero`);
  return { balanceAfter: 0, applied: -balancePaise };
}

/**
 * The reversal owed after a refund: what the order SHOULD have earned on
 * what remains, against what it has earned net so far. Negative means claw
 * back that much; zero or positive means nothing to do (we never top up on a
 * refund, because Shopify's own line data is the source of truth).
 */
export function earnReversalPaise(input: { earnedNetPaise: number; baseAfterRefundPaise: number; percent?: number }): number {
  const target = earnAmountPaise(input.baseAfterRefundPaise, input.percent);
  const delta = target - input.earnedNetPaise;
  return delta < 0 ? delta : 0;
}

/** The discount code format. 8 upper-case alphanumerics, no ambiguous glyphs. */
export const REDEMPTION_CODE_PREFIX = "WLT-";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function redemptionCodeFrom(randomBytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < 8 && i < randomBytes.length; i++) s += CODE_ALPHABET[randomBytes[i] % CODE_ALPHABET.length];
  return REDEMPTION_CODE_PREFIX + s;
}
export function isRedemptionCode(code: string | null | undefined): boolean {
  return typeof code === "string" && /^WLT-[A-Z2-9]{8}$/.test(code.trim().toUpperCase());
}

/** A plain-words line for the statement. */
export function describeLedgerKind(kind: string, refType: string | null, refId: string | null, note: string | null): string {
  const order = refType === "shopify_order" && refId ? ` on order ${orderLabel(refId)}` : "";
  switch (kind) {
    case "welcome": return "Welcome credit";
    case "earn": return `10% back${order}`;
    case "redeem": return `Used${order}`;
    case "reverse_redeem": return `Returned to wallet${order ? " — order" + order.slice(9) + " cancelled" : ""}`;
    case "reverse_earn": return `10% back reversed${order}`;
    case "expire": return "Expired after 12 months without use";
    case "adjust": return note ?? "Adjustment";
    default: return kind;
  }
}
function orderLabel(gidOrName: string): string {
  const m = gidOrName.match(/(\d+)$/);
  return gidOrName.startsWith("#") ? gidOrName : m ? `#${m[1].slice(-4)}` : gidOrName;
}
