"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { sendInquiryAlert } from "@/lib/interakt";
import { BUYER_LOGIN_DOMAIN } from "@/lib/share";

export interface InquiryState {
  ok?: boolean;
  error?: string;
}

// Case A — public wholesale inquiry. Creates a pending/inquiry_form buyer.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function createInquiry(_prev: InquiryState, formData: FormData): Promise<InquiryState> {
  const get = (k: string) => (formData.get(k)?.toString() ?? "").trim();

  // Honeypot: a hidden field real users never see. Bots fill every field, so a
  // non-empty value means a bot — silently accept and drop it.
  if (get("company_website")) return { ok: true };

  const email = get("email").toLowerCase();
  const business_name = get("business_name");
  const owner_name = get("owner_name");
  const phone = get("phone");
  const city = get("city");

  // Email is the one mandatory field on self-serve inquiry — Rakesh needs a way
  // to reply, and it later becomes the login username.
  if (!email) return { error: "Email is required so we can reply." };
  if (!EMAIL_RE.test(email)) return { error: "Please enter a valid email address." };
  // The buyer login domain is synthetic: nobody receives mail there, so Rakesh
  // could never reply, and the address is some buyer's username.
  if (email.endsWith(`@${BUYER_LOGIN_DOMAIN}`)) return { error: "Please enter your own email address so we can reply." };
  if (!owner_name && !business_name) {
    return { error: "Tell us either your name or your business name." };
  }

  const admin = createAdminClient();

  // An email that is already an active buyer's login gets no second row —
  // treated as received, like the dedupe below, without saying the account
  // exists. The gate ignores a pending row with no login, but a rejected or
  // suspended one on the same email still blocks the buyer, and rejecting an
  // unwanted inquiry is what staff would do with it (src/lib/buyer-access.ts),
  // so none is created. No WhatsApp alert either: with no row there is nothing
  // for the dedupe and burst cap below to count.
  const { data: activeLogin } = await admin
    .from("buyers").select("id")
    .eq("email", email).eq("status", "active").not("encrypted_password", "is", null).limit(1);
  if (activeLogin && activeLogin.length > 0) return { ok: true };

  // Cheap anti-flood without extra schema:
  // (a) dedupe — the same email inquiring twice within 10 min is treated as
  //     received (no second row, no second WhatsApp alert to Rakesh);
  // (b) global burst cap — if inquiries are arriving faster than any real
  //     signup rate, shed the excess.
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: recentSame } = await admin
    .from("buyers").select("id")
    .eq("source", "inquiry_form").eq("email", email).gte("created_at", tenMinAgo).limit(1);
  if (recentSame && recentSame.length > 0) return { ok: true };

  const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
  const { count: burst } = await admin
    .from("buyers").select("*", { count: "exact", head: true })
    .eq("source", "inquiry_form").gte("created_at", oneMinAgo);
  if ((burst ?? 0) >= 8) return { error: "We're receiving a lot of requests right now — please try again in a minute." };

  const { error } = await admin.from("buyers").insert({
    email,
    business_name: business_name || null,
    owner_name: owner_name || null,
    phone: phone || null,
    city: city || null,
    gstin: get("gstin") || null,
    address: get("address") || null,
    transport_details: get("transport_details") || null,
    broker_details: get("broker_details") || null,
    other_details: get("other_details") || null,
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
  await sendInquiryAlert(business_name, city); // best-effort (no-op without API key)
  return { ok: true };
}
