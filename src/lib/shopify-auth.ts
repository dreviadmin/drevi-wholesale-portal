import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getEnv } from "@/lib/env";

// Shopify deprecated static admin tokens on Jan 1 2026. This app authenticates
// via OAuth Client Credentials Grant and caches the short-lived token in
// shopify_tokens. See CLAUDE.md → "Shopify authentication".

export const SHOPIFY_API_VERSION = "2026-01";

const TOKEN_ROW_ID = "default";
const REFRESH_MARGIN_MS = 60 * 60 * 1000; // refresh when <1h of life remains

interface CachedToken {
  access_token: string;
  expires_at: string;
}

async function fetchFreshToken(): Promise<{ access_token: string; expires_in: number }> {
  const domain = getEnv("SHOPIFY_STORE_DOMAIN");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: getEnv("SHOPIFY_CLIENT_ID"),
    client_secret: getEnv("SHOPIFY_CLIENT_SECRET"),
  });

  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Shopify token request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error("Shopify token response missing access_token");
  }
  return { access_token: json.access_token, expires_in: json.expires_in ?? 86399 };
}

/**
 * Return a valid Shopify Admin API access token, refreshing and caching as
 * needed. Pass forceRefresh to bypass the cache (used by the 401 retry path).
 */
export async function getShopifyAccessToken(forceRefresh = false): Promise<string> {
  const supabase = createAdminClient();

  if (!forceRefresh) {
    const { data } = await supabase
      .from("shopify_tokens")
      .select("access_token, expires_at")
      .eq("id", TOKEN_ROW_ID)
      .maybeSingle<CachedToken>();

    if (data?.access_token && data.expires_at) {
      const expiresAt = new Date(data.expires_at).getTime();
      if (expiresAt - Date.now() > REFRESH_MARGIN_MS) {
        return data.access_token;
      }
    }
  }

  const { access_token, expires_in } = await fetchFreshToken();
  const expires_at = new Date(Date.now() + expires_in * 1000).toISOString();

  const { error } = await supabase
    .from("shopify_tokens")
    .upsert({ id: TOKEN_ROW_ID, access_token, expires_at, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Failed to cache Shopify token: ${error.message}`);

  return access_token;
}

/**
 * Call the Shopify Admin REST API with the cached token. Retries once with a
 * force-refreshed token on a 401 before failing.
 */
export async function shopifyAdminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const domain = getEnv("SHOPIFY_STORE_DOMAIN");
  const url = `https://${domain}/admin/api/${SHOPIFY_API_VERSION}${path}`;

  const call = async (token: string) =>
    fetch(url, {
      ...init,
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      cache: "no-store",
    });

  let token = await getShopifyAccessToken();
  let res = await call(token);

  // Retry once on 401 (force-refresh) and up to 3x on 429 (rate limit),
  // honoring Retry-After. Shopify REST allows ~2 calls/sec on standard plans.
  let refreshed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      token = await getShopifyAccessToken(true);
    } else if (res.status === 429) {
      const retryAfter = parseFloat(res.headers.get("retry-after") ?? "1");
      await new Promise((r) => setTimeout(r, (Number.isFinite(retryAfter) ? retryAfter : 1) * 1000));
    } else {
      break;
    }
    res = await call(token);
  }
  return res;
}

/** Fetch image src URLs (in order) for a Shopify product by numeric/GID product id. */
export async function fetchProductImageUrls(shopifyProductId: string): Promise<string[]> {
  const numericId = shopifyProductId.replace(/^gid:\/\/shopify\/Product\//, "");
  const res = await shopifyAdminFetch(`/products/${numericId}/images.json`);
  if (!res.ok) {
    if (res.status === 404) return [];
    const text = await res.text().catch(() => "");
    throw new Error(`Shopify images fetch failed for ${shopifyProductId} (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { images?: Array<{ src: string; position?: number }> };
  const images = json.images ?? [];
  images.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return images.map((i) => i.src).filter(Boolean);
}
