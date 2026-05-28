"use server";

import { createAdminClient } from "@/lib/supabase/admin";

export interface InquiryState {
  ok?: boolean;
  error?: string;
}

// Case A — public wholesale inquiry. Creates a pending/inquiry_form buyer.
// (Rakesh's Interakt alert is wired in Phase 4.)
export async function createInquiry(_prev: InquiryState, formData: FormData): Promise<InquiryState> {
  const get = (k: string) => (formData.get(k)?.toString() ?? "").trim();
  const email = get("email").toLowerCase();
  const business_name = get("business_name");
  const owner_name = get("owner_name");
  const phone = get("phone");
  const city = get("city");

  if (!email || !business_name || !owner_name || !phone || !city) {
    return { error: "Please fill in business, owner, email, phone, and city." };
  }

  const admin = createAdminClient();
  const { error } = await admin.from("buyers").insert({
    email,
    business_name,
    owner_name,
    phone,
    city,
    gstin: get("gstin") || null,
    notes: get("message") || null,
    status: "pending",
    source: "inquiry_form",
  });

  if (error) {
    if (error.code === "23505") {
      // Don't reveal account existence — treat as received.
      return { ok: true };
    }
    return { error: "Something went wrong. Please try again." };
  }
  return { ok: true };
}
