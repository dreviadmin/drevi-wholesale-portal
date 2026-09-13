"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";

// The buyer's own account writes (13 Sep). Three rules hold in every action
// here:
//  * the buyer id is NEVER taken from the client. It is resolved from the
//    session's email against the one CREDENTIALED row for that email — the
//    filter, not the email alone, is what makes it deterministic, because
//    buyers.email is unique only among credentialed rows (0007, 0048);
//  * buyers is read column by column. select("*") would carry
//    encrypted_password, staff notes and approval provenance into a payload
//    the buyer receives;
//  * status is re-checked on every write. A suspended account keeps a valid
//    cookie until it expires, and middleware failing open is deliberate.

/** Fields a buyer may set on themselves. Everything else is dropped, silently. */
const EDITABLE = ["phone", "address", "city", "transport_details", "broker_details"] as const;
export type EditableField = (typeof EDITABLE)[number];
export type DetailsPatch = Partial<Record<EditableField, string | null>>;

/**
 * Fields a buyer may only ASK about: these two print on every GST tax invoice,
 * so a person approves them (migration 0048).
 */
const IDENTITY = ["business_name", "gstin"] as const;
export type IdentityField = (typeof IDENTITY)[number];

export interface AccountResult {
  ok: boolean;
  error?: string;
}

const NOT_ACTIVE = "Your account is not active right now. Please contact Drevi.";

function reqMeta() {
  const h = headers();
  const ip = (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "").trim() || null;
  return { ip, userAgent: h.get("user-agent") };
}

/** The signed-in buyer's own row, or null when there is no active one. */
async function loadMe(columns: readonly string[]): Promise<{ id: string; row: Record<string, string | null> } | null> {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return null;

  const { data: rows } = await createAdminClient()
    .from("buyers")
    .select(["id", "status", ...columns].join(", "))
    .eq("email", user.email)
    .not("encrypted_password", "is", null)
    .limit(1);

  const row = rows?.[0] as unknown as (Record<string, string | null> & { id: string; status: string }) | undefined;
  if (!row || row.status !== "active") return null;
  return { id: row.id, row };
}

/**
 * Save the details a buyer owns outright — how we reach them and where we send
 * the goods. The patch is filtered against EDITABLE rather than validated
 * against it: an extra key is ignored, not refused, so a stale client can never
 * be told which fields it is not allowed to touch.
 */
export async function updateMyDetails(patch: DetailsPatch): Promise<AccountResult> {
  const me = await loadMe(EDITABLE);
  if (!me) return { ok: false, error: NOT_ACTIVE };

  const next: Record<string, string | null> = {};
  const changed: EditableField[] = [];
  for (const field of EDITABLE) {
    if (!(field in patch)) continue;
    const value = (patch[field] ?? "").trim() || null;
    if (value === (me.row[field] ?? null)) continue;
    next[field] = value;
    changed.push(field);
  }

  // Order updates go out on WhatsApp, so a half-typed number stored as fact is
  // worse than a refusal, and so is dropping the only number we have.
  if (changed.includes("phone")) {
    if (next.phone == null) return { ok: false, error: "We need a phone number to send you order updates." };
    if (!/^\+?\d{10,13}$/.test(next.phone.replace(/[\s-]/g, ""))) {
      return { ok: false, error: "Enter a 10-digit mobile number we can reach you on." };
    }
  }

  // Nothing actually moved. Writing anyway puts a row in auth_audit_log for
  // every autosave and every re-save of an untouched form, and that log is read
  // through a 300-row window — a flood there buries the logins it exists to show.
  if (changed.length === 0) return { ok: true };

  const { error } = await createAdminClient().from("buyers").update(next).eq("id", me.id);
  if (error) return { ok: false, error: error.message };

  const { ip, userAgent } = reqMeta();
  await writeAuditEvent({
    eventType: "buyer_profile_updated",
    buyerId: me.id,
    ipAddress: ip,
    userAgent,
    // Field NAMES only. An address or a phone number copied into the audit log
    // is a second store of personal data nobody asked us to keep.
    notes: `Buyer updated: ${changed.join(", ")}`,
  });

  revalidatePath("/account");
  revalidatePath("/account/details");
  revalidatePath("/home"); // the storefront header carries the city
  return { ok: true };
}

/**
 * Ask staff to change an identity field. Nothing is written to buyers here —
 * the request carries before_value so the approval can refuse to land on a row
 * someone has edited since (decide_buyer_change, 0048).
 */
export async function requestIdentityChange(
  field: IdentityField,
  requestedValue: string,
  note?: string,
): Promise<AccountResult> {
  if (!IDENTITY.includes(field)) return { ok: false, error: "That is not a detail you can request a change to." };

  const me = await loadMe(IDENTITY);
  if (!me) return { ok: false, error: NOT_ACTIVE };

  // A GSTIN is printed as one token, so spaces go and case is fixed; a business
  // name keeps its shape apart from runs of whitespace.
  const value =
    field === "gstin"
      ? requestedValue.replace(/\s+/g, "").toUpperCase()
      : requestedValue.trim().replace(/\s+/g, " ");

  if (!value) {
    return { ok: false, error: field === "gstin" ? "Enter the GSTIN you want us to use." : "Enter the business name you want us to use." };
  }
  if (value.length > 160) return { ok: false, error: "That is longer than we can store — keep it under 160 characters." };
  // Caught here rather than after a person has approved it and it has printed.
  if (field === "gstin" && !/^[0-9A-Z]{15}$/.test(value)) {
    return { ok: false, error: "A GSTIN is 15 letters and numbers. Please check it and try again." };
  }

  const before = me.row[field] ?? null;
  if (value === before) return { ok: false, error: "That is already what we have on file." };

  const { error } = await createAdminClient().from("buyer_change_requests").insert({
    buyer_id: me.id,
    field,
    before_value: before,
    requested_value: value,
    buyer_note: (note ?? "").trim().slice(0, 300) || null,
  });
  // bcr_one_open_idx — one pending request per field per buyer.
  if (error?.code === "23505") {
    return { ok: false, error: "You already have a change pending for this. We will come back to you on it." };
  }
  if (error) return { ok: false, error: error.message };

  const { ip, userAgent } = reqMeta();
  await writeAuditEvent({
    eventType: "buyer_change_requested",
    buyerId: me.id,
    ipAddress: ip,
    userAgent,
    notes: `${field}: ${before ?? "(empty)"} -> ${value}`,
  });

  revalidatePath("/account/details");
  return { ok: true };
}
