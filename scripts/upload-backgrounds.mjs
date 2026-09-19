/**
 * Publish the five coloured-background PLATES to Supabase storage (Ansh, 19 Sep).
 *
 *   node scripts/upload-backgrounds.mjs [--prod]
 *
 * WHY A SCRIPT AND NOT A RUNTIME READ
 * The plates are committed at assets/backgrounds/<key>.jpg — 1128x2000 empty
 * wall-and-floor backdrops derived from Kalki catalogue shots. assets/ is a
 * BUILD-TIME source, exactly like assets/brand/drevi-lockup.png behind
 * generate-pwa-icons.mjs: it is outside public/ on purpose (nothing there
 * should be served or swept into the service-worker precache) and Vercel does
 * not trace it into the function bundle, so server code cannot read it at
 * runtime. The engines need a URL a provider can fetch, so the plates are
 * uploaded ONCE into the existing public `product-images` bucket and the
 * server resolves them with storage.getPublicUrl.
 *
 * Paths are fixed: _backgrounds/<key>.jpg, matching platePathFor() in
 * src/lib/studio/backgrounds.ts. The leading underscore keeps them out of the
 * way of the SKU-shaped objects that share the bucket.
 *
 * Idempotent: upsert, same path every time. Re-run it after re-cutting a
 * plate; every future generation picks the new pixels up on its next render
 * (images already produced are untouched, which is the intended behaviour).
 */
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

// Must match src/lib/studio/backgrounds.ts — BG_COLOURS and platePathFor.
const BUCKET = "product-images";
const PREFIX = "_backgrounds";
const KEYS = ["ivory", "sand", "stone", "blush", "midnight"];

// TARGET SELECTION — dev is the default, prod needs an explicit flag.
const target = process.argv.includes("--prod") || process.env.DB_TARGET === "prod" ? "prod" : "dev";
const envFile = target === "prod" ? ".env.local" : ".env.development.local";
dotenv.config({ path: envFile, override: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error(`Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in ${envFile}`);
  process.exit(1);
}
const ref = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? "unknown";
console.log(`Target: ${target.toUpperCase()} (${envFile}, project ${ref}) · bucket ${BUCKET}`);

const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

// The bucket already exists on both projects and is PUBLIC — the plate URL has
// to be fetchable by fal.ai and OpenAI, not just by us. Fail loudly rather
// than creating it, so a typo in the name cannot quietly mint a second bucket.
const { data: bucket, error: bucketErr } = await db.storage.getBucket(BUCKET);
if (bucketErr || !bucket) {
  console.error(`Bucket "${BUCKET}" not found on ${target}: ${bucketErr?.message ?? "missing"}`);
  process.exit(1);
}
if (!bucket.public) {
  console.error(`Bucket "${BUCKET}" is private — the image providers could not fetch the plates.`);
  process.exit(1);
}

let failed = 0;
for (const key of KEYS) {
  const src = `assets/backgrounds/${key}.jpg`;
  const path = `${PREFIX}/${key}.jpg`;
  let bytes;
  try {
    bytes = await readFile(src);
  } catch (e) {
    console.error(`  ${key.padEnd(9)} MISSING ${src} — ${e.message}`);
    failed++;
    continue;
  }
  const { error } = await db.storage.from(BUCKET).upload(path, bytes, {
    contentType: "image/jpeg",
    upsert: true,
  });
  if (error) {
    console.error(`  ${key.padEnd(9)} FAILED  ${path} — ${error.message}`);
    failed++;
    continue;
  }
  const { data } = db.storage.from(BUCKET).getPublicUrl(path);
  console.log(`  ${key.padEnd(9)} ok      ${path}  ${(bytes.length / 1024).toFixed(0)}KB  ${data.publicUrl}`);
}

if (failed) {
  console.error(`\n${failed} plate(s) did not upload — coloured backgrounds will fail for those keys.`);
  process.exit(1);
}
console.log(`\nAll ${KEYS.length} plates are live on ${target}.`);
