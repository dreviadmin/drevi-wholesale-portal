import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// src/lib/backup.ts is `server-only`, so the list is read from the source text
// rather than imported (importing it throws inside vitest).

// 12 Sep: the backup list had drifted from the schema for weeks — designs,
// design_angles, design_images, design_copy, publish_targets, stock_movements,
// order_bills, retail_bills, lovs, entity_notes, pipeline_jobs and
// shopify_tokens were created by later migrations and never added, so every
// backup taken since was missing the Studio, the stock ledger and both billing
// tables. These tests make that drift impossible to repeat: adding a migration
// that creates a table now fails the suite until the table is backed up too.

const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");
const SCRIPT_PATH = join(__dirname, "..", "..", "scripts", "backup.mjs");
const LIB_PATH = join(__dirname, "backup.ts");

/** The BACKUP_TABLES array literal in src/lib/backup.ts. */
function namedArray(path: string, decl: RegExp): string[] {
  const src = readFileSync(path, "utf8");
  const block = src.match(decl);
  if (!block) throw new Error(`${path}: table array not found`);
  return [...block[1].matchAll(/"([a-z_][a-z0-9_]*)"/g)].map((m) => m[1]);
}

const BACKUP_TABLES = namedArray(LIB_PATH, /export const BACKUP_TABLES = \[([\s\S]*?)\] as const;/);

/** Tables a migration creates, minus any it later drops or renames away. */
function tablesInMigrations(): Set<string> {
  const created = new Set<string>();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    // Ignore commented-out lines: the migrations document their own reversal
    // steps in comments (e.g. 0022's "-- REVERSAL: alter table ... rename").
    const live = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const m of live.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi)) {
      created.add(m[1].toLowerCase());
    }
    for (const m of live.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi)) {
      created.delete(m[1].toLowerCase());
    }
    for (const m of live.matchAll(/alter\s+table\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+rename\s+to\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi)) {
      created.add(m[2].toLowerCase()); // the new name must be backed up
    }
  }
  return created;
}

/** The TABLES array literal in scripts/backup.mjs. */
function tablesInScript(): string[] {
  return namedArray(SCRIPT_PATH, /const TABLES = \[([\s\S]*?)\];/);
}

describe("backup table coverage", () => {
  it("backs up every table the migrations create", () => {
    const missing = [...tablesInMigrations()].filter((t) => !BACKUP_TABLES.includes(t)).sort();
    expect(missing, `Tables created by a migration but absent from BACKUP_TABLES: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not list tables no migration creates", () => {
    const known = tablesInMigrations();
    const unknown = BACKUP_TABLES.filter((t) => !known.has(t)).sort();
    expect(unknown, `BACKUP_TABLES names tables no migration creates: ${unknown.join(", ")}`).toEqual([]);
  });

  it("keeps scripts/backup.mjs in step with src/lib/backup.ts", () => {
    expect([...tablesInScript()].sort()).toEqual([...BACKUP_TABLES].sort());
  });

  it("never backs up the same table twice", () => {
    expect(new Set(BACKUP_TABLES).size).toBe(BACKUP_TABLES.length);
  });
});
