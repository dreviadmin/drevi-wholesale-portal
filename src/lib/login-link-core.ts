import crypto from "node:crypto";

// Pure rules for one-tap login links (/go/<token>). The database and auth
// calls live in login-link.ts; everything decidable without them is here so it
// can be tested.

/** 16 random bytes, base64url: 22 characters, 128 bits. */
export const TOKEN_BYTES = 16;
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

export function newToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Cheap shape check before any database read — junk paths never query. */
export function isTokenShaped(token: string | null | undefined): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * "https://host" from whatever the caller has: a bare host, a full URL, with or
 * without a trailing slash. PORTAL_URL's in-code fallback is a bare host.
 */
export function portalOrigin(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(withScheme).origin;
}

export function loginLinkUrl(base: string, token: string): string {
  return `${portalOrigin(base)}/go/${token}`;
}

export type LinkRefusal = "unknown" | "revoked" | "no_login" | "inactive" | "staff";

export interface LinkFacts {
  link: { revoked_at: string | null } | null;
  /** The buyer the link was minted for. */
  buyer: { status: string; email: string | null; encrypted_password: string | null } | null;
  /** Every buyer row sharing that email (emails are not unique since 0007). */
  sameEmailStatuses: string[];
  /** True when staff_users has the email — a buyer link must never open a staff session. */
  emailIsStaff: boolean;
}

/**
 * Whether a tap may sign in. Mirrors the gate the session then has to pass:
 * middleware lets a buyer through only when EVERY row with their email is
 * active, so a link that "worked" for a half-suspended duplicate would just
 * bounce to /login — refuse it here with an honest message instead.
 */
export function linkRefusal(f: LinkFacts): LinkRefusal | null {
  if (!f.link || !f.buyer) return "unknown";
  if (f.link.revoked_at) return "revoked";
  if (!f.buyer.email || !f.buyer.encrypted_password) return "no_login";
  if (f.emailIsStaff) return "staff";
  if (f.buyer.status !== "active") return "inactive";
  if (f.sameEmailStatuses.length === 0 || f.sameEmailStatuses.some((s) => s !== "active")) return "inactive";
  return null;
}
