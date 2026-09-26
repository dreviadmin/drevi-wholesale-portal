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
  | "SKU_DUAL_MODE"
  // Retrofit v1.3 (§3.6) — all optional with in-code defaults:
  | "RECEIPT_INTAKE_V2"          // 'false' until R9 flips it
  | "DRIVE_DESIGN_FOLDER_ID"     // EMPTY until ANSH-19; uploads stay disabled
  | "HANDLING_DAYS"              // 2
  | "AVAILABILITY_BUFFER_DAYS"   // 3
  | "LIMITED_THRESHOLD"          // 5
  | "SUPPLY_STALE_DAYS"           // 60
  // Drevi Wallet (26 Sep) — see docs/wallet.md. All optional except the two
  // Shopify credentials, which must be the "Drevi Admin Automation" app: the
  // portal's own app ("Drevi Pipeline") has no customer/discount/order scopes.
  | "WALLET_SHOPIFY_CLIENT_ID"
  | "WALLET_SHOPIFY_CLIENT_SECRET"
  | "WALLET_SESSION_SECRET"       // >=32 chars; derived from the master key when absent
  | "WALLET_ALLOWED_ORIGINS"      // comma list; defaults to drevifashion.com + myshopify
  | "WALLET_WA_LIVE"              // 'true' to actually send WhatsApp; anything else is a dry run
  | "WALLET_DEV_RETURN_OTP"       // 'true' + non-production: OTP echoed in the send response
  | "AISENSY_API_KEY"
  | "AISENSY_CAMPAIGN_OTP"        // campaign names as created in AiSensy
  | "AISENSY_CAMPAIGN_WELCOME"
  | "AISENSY_CAMPAIGN_BALANCE"
  | "WALLET_WELCOME_PAISE"        // 100000
  | "WALLET_EARN_PERCENT"         // 10
  | "WALLET_MIN_ORDER_PAISE"      // 500000
  | "WALLET_EXPIRY_MONTHS";       // 12

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

// --- Retrofit v1.3 config (§3.6) -------------------------------------------
// Optional, with the spec's defaults baked in so nothing breaks unset.
export const receiptIntakeV2 = () => (process.env.RECEIPT_INTAKE_V2 ?? "false").toLowerCase() === "true";
export const driveDesignFolderId = () => (process.env.DRIVE_DESIGN_FOLDER_ID ?? "").trim();
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
export const handlingDays = () => num(process.env.HANDLING_DAYS, 2);
export const availabilityBufferDays = () => num(process.env.AVAILABILITY_BUFFER_DAYS, 3);
export const limitedThreshold = () => num(process.env.LIMITED_THRESHOLD, 5);
export const supplyStaleDays = () => num(process.env.SUPPLY_STALE_DAYS, 60);
