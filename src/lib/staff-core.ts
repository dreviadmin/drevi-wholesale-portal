// Pure half of the staff lookup (src/lib/staff.ts), so the decision can be
// unit-tested without Supabase.
//
// "error" means we could not find out, not that the answer is no: a
// staff_users read that failed, or a sign-in check that never reached the
// auth server. The admin layout shows a retry screen for it instead of
// sending a signed-in person to /login. An invalid or expired session is a
// real answer and stays "none".

export type StaffLookupKind = "staff" | "none" | "error";

export interface StaffLookupInput {
  hasUser: boolean;
  authError: { name?: string; status?: number } | null | undefined;
  rowError: unknown;
  row: { active: boolean | null } | null | undefined;
}

// auth-js names network failures and gateway errors (502/503/504 and the
// Cloudflare 52x codes) AuthRetryableFetchError, with status 0 for "no
// response". Any other 5xx with a JSON body comes back as an AuthApiError with
// that status. A reply that is not JSON at all (a proxy's HTML error page)
// comes back as AuthUnknownError with no status: the auth server did not
// answer, so that is not a "signed out" answer either.
export function isRetryableAuthError(err: { name?: string; status?: number } | null | undefined): boolean {
  if (!err) return false;
  if (err.name === "AuthRetryableFetchError" || err.name === "AuthUnknownError") return true;
  return typeof err.status === "number" && err.status >= 500;
}

export function classifyStaffLookup({ hasUser, authError, rowError, row }: StaffLookupInput): StaffLookupKind {
  if (isRetryableAuthError(authError)) return "error";
  if (!hasUser) return "none";
  if (rowError) return "error";
  if (!row || !row.active) return "none";
  return "staff";
}
