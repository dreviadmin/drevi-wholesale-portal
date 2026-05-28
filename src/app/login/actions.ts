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
  const email = (formData.get("email")?.toString() ?? "").trim().toLowerCase();
  const password = formData.get("password")?.toString() ?? "";
  if (!email || !password) return { error: "Enter your email and password." };

  const { ip, userAgent } = requestMeta();
  const admin = createAdminClient();
  const supabase = createServerSupabase();

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const { data: buyer } = await admin.from("buyers").select("id").eq("email", email).maybeSingle();
    await writeAuditEvent({
      eventType: "login_failed",
      buyerId: buyer?.id ?? null,
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

  const { data: buyer } = await admin
    .from("buyers")
    .select("id, status")
    .eq("email", email)
    .maybeSingle();

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
