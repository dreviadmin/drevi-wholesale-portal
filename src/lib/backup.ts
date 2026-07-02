import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

// Full-table export used by the backup endpoint (and mirrored by
// scripts/backup.mjs for local runs). Keep the table list in sync with the
// schema when new tables are added.
export const BACKUP_TABLES = [
  "buyers",
  "orders",
  "carts",
  "staff_users",
  "exhibition_sessions",
  "auth_audit_log",
  "wholesale_products",
] as const;

const PAGE = 1000;

export interface BackupPayload {
  exported_at: string;
  row_count: number;
  tables: Record<string, unknown[]>;
}

export async function exportAllTables(): Promise<BackupPayload> {
  const admin = createAdminClient();
  const tables: Record<string, unknown[]> = {};
  let row_count = 0;
  for (const t of BACKUP_TABLES) {
    const rows: unknown[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin.from(t).select("*").range(from, from + PAGE - 1);
      if (error) throw new Error(`${t}: ${error.message}`);
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
    tables[t] = rows;
    row_count += rows.length;
  }
  return { exported_at: new Date().toISOString(), row_count, tables };
}
