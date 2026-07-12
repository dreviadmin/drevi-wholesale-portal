import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

const PDF_BUCKET = "order-pdfs";
const CARD_BUCKET = "buyer-cards";
const CUSTOM_BUCKET = "custom-items";

async function ensureBucket(name: string, opts: { public: boolean } = { public: false }): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.storage.getBucket(name);
  if (!data) {
    await admin.storage.createBucket(name, { public: opts.public, fileSizeLimit: "5MB" });
  }
}

// Photo of a custom (off-portal) item, snapped at the booth. PUBLIC bucket so
// the URL baked into order items never expires (the invoice PDF fetches it).
export async function uploadCustomItemImage(file: File): Promise<string> {
  await ensureBucket(CUSTOM_BUCKET, { public: true });
  const admin = createAdminClient();
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  const { error } = await admin.storage.from(CUSTOM_BUCKET).upload(path, bytes, {
    contentType: file.type || "image/jpeg",
    upsert: false,
  });
  if (error) throw new Error(`Photo upload failed: ${error.message}`);
  const { data } = admin.storage.from(CUSTOM_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// Upload the order PDF and return a long-lived signed URL (stored in orders.pdf_url).
export async function uploadOrderPdf(orderId: string, orderNumber: string, pdf: Buffer): Promise<string> {
  await ensureBucket(PDF_BUCKET);
  const admin = createAdminClient();
  const path = `${orderId}/${orderNumber}.pdf`;
  const { error } = await admin.storage.from(PDF_BUCKET).upload(path, pdf, { contentType: "application/pdf", upsert: true });
  if (error) throw new Error(`PDF upload failed: ${error.message}`);
  const { data, error: urlErr } = await admin.storage.from(PDF_BUCKET).createSignedUrl(path, 60 * 60 * 24 * 30);
  if (urlErr || !data) throw new Error(`Signed URL failed: ${urlErr?.message}`);
  return data.signedUrl;
}

// Upload a buyer's visiting card / photo; returns the storage path (stored in
// buyers.card_image_path — signed URLs are generated on read).
export async function uploadBuyerCardImage(buyerId: string, file: File): Promise<string> {
  await ensureBucket(CARD_BUCKET);
  const admin = createAdminClient();
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `${buyerId}/card.${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  const { error } = await admin.storage.from(CARD_BUCKET).upload(path, bytes, {
    contentType: file.type || "image/jpeg",
    upsert: true,
  });
  if (error) throw new Error(`Card upload failed: ${error.message}`);
  return path;
}

export async function signedCardUrl(path: string, expiresSec = 60 * 60): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin.storage.from(CARD_BUCKET).createSignedUrl(path, expiresSec);
  return data?.signedUrl ?? null;
}
