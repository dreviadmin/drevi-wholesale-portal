import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { AuditEventType } from "@/lib/types";

// Writes one row to auth_audit_log. NEVER pass the password value — only the
// event. Uses the service role (no client write policy exists on the table).
export async function writeAuditEvent(params: {
  eventType: AuditEventType;
  buyerId?: string | null;
  staffUserId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  notes?: string | null;
}): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("auth_audit_log").insert({
    event_type: params.eventType,
    buyer_id: params.buyerId ?? null,
    staff_user_id: params.staffUserId ?? null,
    ip_address: params.ipAddress ?? null,
    user_agent: params.userAgent ?? null,
    notes: params.notes ?? null,
  });
  // Audit failures must never break the primary flow — log and move on.
  if (error) console.error("auth_audit_log insert failed:", error.message);
}
