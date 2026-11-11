// What a failed password sign-in tells the person at the form.
//
// Supabase Auth answers 429 when its sign-in rate limit trips. Password
// sign-in runs from our server, so that limit counts everyone signing in at
// once, not one buyer's attempts. A buyer turned away by it used to read
// "Invalid username or password." and went off to reset a password that was
// fine. Every other failure keeps the one generic message, so the form never
// says whether a username exists.

export interface AuthErrorLike {
  status?: number | null;
  code?: string | null;
}

export const INVALID_LOGIN_MESSAGE = "Invalid username or password.";
export const RATE_LIMITED_MESSAGE = "A lot of people are signing in right now. Please wait a minute and try again.";

const RATE_LIMIT_CODES = new Set(["over_request_rate_limit", "over_email_send_rate_limit"]);

export function isRateLimited(err: AuthErrorLike | null | undefined): boolean {
  if (!err) return false;
  return err.status === 429 || (!!err.code && RATE_LIMIT_CODES.has(err.code));
}

export function loginErrorMessage(err: AuthErrorLike | null | undefined): string {
  return isRateLimited(err) ? RATE_LIMITED_MESSAGE : INVALID_LOGIN_MESSAGE;
}
