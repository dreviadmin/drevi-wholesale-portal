import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

const BUCKET = "order-pdfs";

async function ensureBucket(): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.storage.getBucket(BUCKET);
  if (!data) {
    await admin.storage.createBucket(BUCKET, { public: false, fileSizeLimit: "5MB" });
  }
}

// Upload the order PDF and return a long-lived signed URL (stored in orders.pdf_url).
export async function uploadOrderPdf(orderId: string, orderNumber: string, pdf: Buffer): Promise<string> {
  await ensureBucket();
  const admin = createAdminClient();
  const path = `${orderId}/${orderNumber}.pdf`;
  const { error } = await admin.storage.from(BUCKET).upload(path, pdf, { contentType: "application/pdf", upsert: true });
  if (error) throw new Error(`PDF upload failed: ${error.message}`);
  const { data, error: urlErr } = await admin.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24 * 30);
  if (urlErr || !data) throw new Error(`Signed URL failed: ${urlErr?.message}`);
  return data.signedUrl;
}
