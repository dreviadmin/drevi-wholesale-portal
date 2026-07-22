/**
 * Centralized environment-variable access with startup validation.
 *
 * `requireEnv()` throws a descriptive error naming every missing var the first
 * time a server module touches config, rather than failing deep inside a
 * request with an opaque `undefined`. Client-safe vars (NEXT_PUBLIC_*) are read
 * directly where needed; everything else is server-only.
 */

type EnvKey =
  | "NEXT_PUBLIC_SUPABASE_URL"
  | "NEXT_PUBLIC_SUPABASE_ANON_KEY"
  | "SUPABASE_SERVICE_ROLE_KEY"
  | "PORTAL_PASSWORD_MASTER_KEY"
  | "CRON_SECRET"
  | "GOOGLE_SERVICE_ACCOUNT_JSON"
  | "GOOGLE_SHEET_ID"
  | "SHOPIFY_STORE_DOMAIN"
  | "SHOPIFY_CLIENT_ID"
  | "SHOPIFY_CLIENT_SECRET"
  // Phase 1 (SKU Generator) — all optional with in-code defaults:
  // SKU_REGISTRY_SHEET_ID (legacy registry workbook), SKU_REGISTRY_TAB
  // ('SKUs'), SKU_DUAL_MODE ('true' during the transition).
  | "DRIVE_TRYON_FOLDER_ID"
  | "DRIVE_INPUT_FOLDER_ID"
  | "SKU_REGISTRY_SHEET_ID"
  | "SKU_REGISTRY_TAB"
  | "SKU_DUAL_MODE";

// Vars Phase 1 needs to run. Interakt (Phase 4) is intentionally excluded.
const REQUIRED_PHASE_1: EnvKey[] = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PORTAL_PASSWORD_MASTER_KEY",
  "CRON_SECRET",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_SHEET_ID",
  "SHOPIFY_STORE_DOMAIN",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
];

export function getEnv(key: EnvKey): string {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
        `Set it in .env.local (local) or the Vercel project settings (deploy).`,
    );
  }
  return value;
}

/**
 * Validate that all Phase-1-required env vars are present. Call from server
 * entry points (route handlers, server actions). Returns the list of missing
 * vars; throws if any are absent so the failure is loud and named.
 */
export function assertRequiredEnv(keys: EnvKey[] = REQUIRED_PHASE_1): void {
  const missing = keys.filter((k) => !process.env[k] || process.env[k]!.trim() === "");
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable${missing.length > 1 ? "s" : ""}: ` +
        `${missing.join(", ")}. Set ${missing.length > 1 ? "them" : "it"} in .env.local ` +
        `(local) or the Vercel project settings (deploy).`,
    );
  }
}

// Client-safe values — these are inlined into the browser bundle by Next.
export const PUBLIC_ENV = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
};
