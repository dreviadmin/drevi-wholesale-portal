/**
 * Put a local file into a PUBLIC Supabase bucket and print its public URL.
 *
 *   node scripts/host-media.mjs <file> [--prod] [--name <stored-name>]
 *
 * AiSensy will not accept media it cannot fetch anonymously — "The medial URL
 * provided in the media object should be publically accessible, otherwise, the
 * request will be rejected" — so a signed URL is no good here. This bucket is
 * deliberately separate from the buyer-facing ones and holds only things meant
 * to be world-readable: the launch video, and whatever else rides in a WhatsApp
 * template header.
 *
 * src/lib/storage.ts's ensureBucket pins fileSizeLimit to 5MB, which a 12MB
 * video fails, hence the local bucket creation rather than reusing it.
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

const args = process.argv.slice(2);
const PROD = args.includes("--prod");
const file = args.find((a) => !a.startsWith("--") && a !== args[args.indexOf("--name") + 1]);
const nameFlag = args.indexOf("--name");
if (!file) { console.error("usage: node scripts/host-media.mjs <file> [--prod] [--name <stored-name>]"); process.exit(1); }
if (!fs.existsSync(file)) { console.error(`no such file: ${file}`); process.exit(1); }

dotenv.config({ path: PROD ? ".env.local" : ".env.development.local", override: true });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing Supabase env"); process.exit(1); }
const admin = createClient(url, key, { auth: { persistSession: false } });

const BUCKET = "public-media";
const TYPES = { ".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".pdf": "application/pdf" };

const stored = nameFlag >= 0 ? args[nameFlag + 1] : path.basename(file);
const ext = path.extname(stored).toLowerCase();
const contentType = TYPES[ext] ?? "application/octet-stream";
const bytes = fs.readFileSync(file);

const { data: existing } = await admin.storage.getBucket(BUCKET);
if (!existing) {
  const { error } = await admin.storage.createBucket(BUCKET, { public: true, fileSizeLimit: "25MB" });
  if (error) { console.error(`createBucket: ${error.message}`); process.exit(1); }
  console.log(`created public bucket "${BUCKET}" (25MB limit)`);
} else if (!existing.public) {
  console.error(`bucket "${BUCKET}" exists but is NOT public — refusing to upload media AiSensy could not fetch`);
  process.exit(1);
}

const { error } = await admin.storage.from(BUCKET).upload(stored, bytes, { contentType, upsert: true });
if (error) { console.error(`upload: ${error.message}`); process.exit(1); }

const { data } = admin.storage.from(BUCKET).getPublicUrl(stored);
console.log(`\nTARGET:   ${PROD ? "PRODUCTION" : "dev"}`);
console.log(`uploaded: ${stored}  (${(bytes.length / 1048576).toFixed(1)} MB, ${contentType})`);
console.log(`PUBLIC URL:\n${data.publicUrl}`);
