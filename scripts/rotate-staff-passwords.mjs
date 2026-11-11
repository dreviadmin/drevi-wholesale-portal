/**
 * Rotate staff passwords. Run by hand only; nothing calls this.
 *
 * Gives every active staff member (or the --only / --except subset) a new
 * Word-Word-NNNN password, the same generator /admin/staff uses. With
 * --kill-sessions it also ends every session they have open, so everyone
 * signs in again with the new password.
 *
 *   node scripts/rotate-staff-passwords.mjs                 # DEV, dry run
 *   node scripts/rotate-staff-passwords.mjs --prod          # PROD, dry run
 *   node scripts/rotate-staff-passwords.mjs --prod --write --kill-sessions
 *   ... --only rakesh@drevifashion.com,jyoti@drevifashion.com
 *   ... --except ansh@drevifashion.com
 *
 * New passwords are NEVER printed. They go to .local/staff-passwords-<target>-
 * <timestamp>.txt (gitignored, mode 600) for the owner to hand out in person
 * or on WhatsApp, then delete. Each rotation writes credential_changed to
 * auth_audit_log. --kill-sessions deletes the user's rows in auth.sessions and
 * auth.refresh_tokens through the Supabase Management API (needs
 * SUPABASE_ACCESS_TOKEN, as scripts/apply-migration.mjs does).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { generateMemorablePassword } from "./lib/password.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const flag = (f) => { const i = argv.indexOf(`--${f}`); return i >= 0 ? argv[i + 1] : null; };
const list = (v) => (v ? v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : null);

const target = has("prod") ? "prod" : "dev";
const envFile = target === "prod" ? ".env.local" : ".env.development.local";
// Refuse rather than fall back: a missing dev file must never mean "use prod".
if (!existsSync(envFile)) {
  console.error(`${envFile} not found — refusing to guess which project to touch.`);
  process.exit(1);
}
// The access token is account-level and lives in .env.local; the target file wins on the project.
if (existsSync(".env.local")) dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ path: envFile, override: true, quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !service) { console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }
const ref = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
const write = has("write");
const kill = has("kill-sessions");
const only = list(flag("only"));
const except = list(flag("except")) ?? [];

console.log(`Target: ${target.toUpperCase()} (${ref}) · ${write ? "WRITING" : "dry run"}${kill ? " · ending sessions" : ""}`);
if (kill && !process.env.SUPABASE_ACCESS_TOKEN) {
  console.error("--kill-sessions needs SUPABASE_ACCESS_TOKEN (Management API)."); process.exit(1);
}

const admin = createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } });
const { data: staff, error } = await admin.from("staff_users").select("id, email, name, role, active").eq("active", true).order("email");
if (error) throw error;
const chosen = staff.filter((s) => (!only || only.includes(s.email.toLowerCase())) && !except.includes(s.email.toLowerCase()));
if (only) for (const e of only) if (!staff.some((s) => s.email.toLowerCase() === e)) console.warn(`  ! ${e} is not an active staff member — skipped`);
for (const s of chosen) console.log(`  ${s.email} (${s.role})`);
if (!write) { console.log(`\nDry run — ${chosen.length} staff would get a new password. Add --write to rotate.`); process.exit(0); }

async function authUserId(email) {
  for (let page = 1; page <= 20; page++) {
    const { data, error: e } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (e) throw e;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function endSessions(userId) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `delete from auth.refresh_tokens where user_id::text = '${userId}'; delete from auth.sessions where user_id = '${userId}';`,
    }),
  });
  if (!res.ok) throw new Error(`end sessions: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

const lines = [`Staff passwords (${target}, ${new Date().toISOString()}) — hand out, then delete this file.`, ""];
let done = 0, failed = 0, stillSignedIn = 0;
for (const s of chosen) {
  try {
    const id = await authUserId(s.email);
    if (!id) throw new Error("no auth user");
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("unexpected auth id shape");
    const password = generateMemorablePassword();
    const { error: upErr } = await admin.auth.admin.updateUserById(id, { password });
    if (upErr) throw upErr;
    // The login password has changed from here on, so it goes in the file
    // before anything else can fail. Otherwise a failed session end would
    // leave this person with a password nobody knows.
    lines.push(`${s.name ?? s.email}  ${s.email}  ${password}`);
    done++;
    let endErr = null;
    if (kill) {
      try { await endSessions(id); } catch (e) { endErr = e; }
    }
    const { error: logErr } = await admin.from("auth_audit_log").insert({
      event_type: "credential_changed",
      staff_user_id: s.id,
      notes: `staff password rotated by script${kill ? (endErr ? "; ending sessions failed" : "; sessions ended") : ""}`,
    });
    if (logErr) console.warn(`  ! ${s.email}: audit log entry not written (${logErr.message})`);
    if (endErr) {
      stillSignedIn++;
      console.error(`  rotated ${s.email}, but ending sessions FAILED: ${endErr.message}`);
    } else {
      console.log(`  rotated ${s.email}${kill ? " · sessions ended" : ""}`);
    }
  } catch (e) {
    console.error(`  FAILED ${s.email}: ${e.message}`);
    failed++;
  }
}
if (!existsSync(".local")) mkdirSync(".local");
const out = `.local/staff-passwords-${target}-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
writeFileSync(out, lines.join("\n") + "\n", { mode: 0o600 });
const openNote = stillSignedIn ? `, ${stillSignedIn} still signed in (sessions not ended)` : "";
console.log(`\n${done} rotated, ${failed} failed${openNote}. New passwords: ${out} (not printed).`);
