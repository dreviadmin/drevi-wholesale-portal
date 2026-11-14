"use server";

// New appointment: "have they booked before?" for the WhatsApp number being
// typed. Read-only and staff-gated; it answers with just enough to fill the
// name and email and to link the earlier bookings.

import { requireStaff } from "@/lib/staff";
import { searchAppointments } from "@/lib/appointments/server";
import { parsePhone, type ApptStatus } from "@/lib/appointments/core";

export interface EarlierCustomer {
  name: string;
  email: string | null;
  count: number;
  bookings: Array<{ number: string; starts_at: string; status: ApptStatus; type_id: string }>;
}

export async function findCustomer(phone: string): Promise<{ ok: true; found: EarlierCustomer | null } | { ok: false; error: string }> {
  try { await requireStaff(); } catch { return { ok: false, error: "Not authorized" }; }
  const e164 = parsePhone(String(phone ?? ""), "+91");
  if (!e164) return { ok: true, found: null };
  const r = await searchAppointments(e164);
  if (!r.ok) return r.missing ? { ok: true, found: null } : { ok: false, error: r.error };
  // The search matches the last 10 digits; keep only this exact number.
  const rows = r.data.filter((a) => a.phone_e164 === e164);
  if (!rows.length) return { ok: true, found: null };
  const latest = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return {
    ok: true,
    found: {
      name: latest.customer_name,
      email: latest.email ?? rows.find((a) => a.email)?.email ?? null,
      count: rows.length,
      bookings: rows.slice(0, 3).map((a) => ({ number: a.number, starts_at: a.starts_at, status: a.status, type_id: a.type_id })),
    },
  };
}
