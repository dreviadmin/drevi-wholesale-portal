"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { isTokenShaped } from "@/lib/login-link-core";
import { signInWithLoginToken } from "@/lib/login-link";
import { writeAuditEvent } from "@/lib/audit";

/**
 * The button on /go/<token>. Re-checks the link from scratch (the page may
 * have sat open while staff reset it or suspended the buyer), signs in, logs
 * it like a password login, and lands on the buyer home.
 */
export async function continueWithLink(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!isTokenShaped(token)) redirect("/login");

  const res = await signInWithLoginToken(token);
  if (!res.ok) {
    if (res.reason === "auth_failed") console.error("[go] sign-in failed:", res.detail);
    // The page explains every refusal; ?e=1 is the "try again" case.
    redirect(res.reason === "auth_failed" || res.reason === "error" ? `/go/${token}?e=1` : `/go/${token}`);
  }

  const h = headers();
  await writeAuditEvent({
    eventType: "login_success",
    buyerId: res.buyerId,
    ipAddress: (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "").trim() || null,
    userAgent: h.get("user-agent"),
    notes: "one-tap link",
  });
  redirect("/home");
}
