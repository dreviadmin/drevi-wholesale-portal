// The buyer gate's rule for an email that several buyer rows share (emails are
// not unique since 0007). One place, so middleware, resolveActiveRole, the
// login action and one-tap links (linkRefusal) cannot disagree about who gets
// in — a buyer the login action sends to /home but middleware bounces just sees
// the login form again with no message.
//
// Pure and import-free: middleware runs it on the edge, and vitest has no "@/"
// alias.

export interface SameEmailRow {
  status: string;
  /** buyers.encrypted_password is set — someone can sign in as this row. */
  hasLogin: boolean;
}

/**
 * Whether a row has a say in the gate.
 *
 * Duplicates resolve to the MOST restrictive answer: a suspended or rejected
 * row on the email blocks the buyer even when their own row is active. That is
 * deliberate — it closed a fail-open where a suspended buyer with a duplicate
 * row kept full access — and it stays.
 *
 * The one exception is a PENDING row with no login: a public /wholesale
 * inquiry, or a capture nobody has reviewed yet. Nobody can sign in as it and
 * nobody has decided anything about it, so it has no say: an inquiry sent on
 * an active buyer's email must not keep that buyer out of the portal.
 */
export function rowGatesBuyer(r: SameEmailRow): boolean {
  return !(r.status === "pending" && !r.hasLogin);
}

/** The statuses of the rows that gate: every one active, and at least one. */
export function gatingStatusesAllow(statuses: string[]): boolean {
  return statuses.length > 0 && statuses.every((s) => s === "active");
}

/** The whole rule over every row with the email. */
export function sameEmailAllowsBuyer(rows: SameEmailRow[]): boolean {
  return gatingStatusesAllow(rows.filter(rowGatesBuyer).map((r) => r.status));
}

/**
 * rowGatesBuyer as a PostgREST .or() filter, for the reads that only need the
 * statuses (middleware, resolveActiveRole, the login action): the database
 * returns just the rows that gate, so the password ciphertext never has to
 * leave it to learn whether it is set. Pass the result to gatingStatusesAllow.
 * buyer-access.test.ts checks this agrees with rowGatesBuyer — keep the two in
 * step.
 */
export const GATING_ROWS_FILTER = "status.neq.pending,encrypted_password.not.is.null";
