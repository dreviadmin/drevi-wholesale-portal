"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";

export interface LoginState {
  error?: string;
}

const RAKESH_PHONE = "+91 88280 43555";

function requestMeta() {
  const h = headers();
  const ip = (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "").trim() || null;
  const userAgent = h.get("user-agent");
  return { ip, userAgent };
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const rawId = (formData.get("email")?.toString() ?? "").trim().toLowerCase();
  // Staff shorthand: a bare username ("ansh") is their @drevifashion.com login.
  // Buyers always type full emails, so anything with an @ passes through as-is.
  const email = rawId && !rawId.includes("@") ? `${rawId}@drevifashion.com` : rawId;
  const password = formData.get("password")?.toString() ?? "";
  if (!email || !password) return { error: "Enter your email and password." };

  const { ip, userAgent } = requestMeta();
  const admin = createAdminClient();
  const supabase = createServerSupabase();

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const { data: buyerRows } = await admin.from("buyers").select("id").eq("email", email).limit(1);
    await writeAuditEvent({
      eventType: "login_failed",
      buyerId: buyerRows?.[0]?.id ?? null,
      ipAddress: ip,
      userAgent,
      notes: `email=${email}`,
    });
    return { error: "Invalid email or password." };
  }

  // Auth succeeded. Decide destination by which table the email belongs to.
  const { data: staff } = await admin
    .from("staff_users")
    .select("id, active")
    .eq("email", email)
    .maybeSingle();

  if (staff?.active) {
    await writeAuditEvent({ eventType: "login_success", staffUserId: staff.id, ipAddress: ip, userAgent });
    redirect("/admin");
  }

  // Resolve to the credentialed row (emails aren't unique since 0007); this is
  // the row whose password just authenticated.
  const { data: buyerRows } = await admin
    .from("buyers")
    .select("id, status")
    .eq("email", email)
    .not("encrypted_password", "is", null)
    .limit(1);
  const buyer = buyerRows?.[0];

  if (buyer?.status === "active") {
    await writeAuditEvent({ eventType: "login_success", buyerId: buyer.id, ipAddress: ip, userAgent });
    redirect("/catalog");
  }

  // Valid credentials but no active access — sign back out and explain.
  await writeAuditEvent({
    eventType: buyer ? "login_success" : "login_failed",
    buyerId: buyer?.id ?? null,
    ipAddress: ip,
    userAgent,
    notes: buyer ? `blocked: status=${buyer.status}` : "no app row for authenticated user",
  });
  await supabase.auth.signOut();

  if (buyer?.status === "pending") {
    return { error: "Your account is awaiting approval. Rakesh will be in touch shortly." };
  }
  if (buyer?.status === "suspended") {
    return { error: `Your account is inactive. Please contact Rakesh: ${RAKESH_PHONE}.` };
  }
  return { error: "Invalid email or password." };
}
