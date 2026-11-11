// Arguments and the password file for scripts/rotate-staff-passwords.mjs, kept
// apart so they can be tested without touching a database.
import { appendFileSync, writeFileSync } from "node:fs";

const SWITCHES = ["prod", "write", "kill-sessions"];
const LISTS = ["only", "except"];

/**
 * Parse the script's flags. Both `--only a@x,b@y` and `--only=a@x,b@y` work
 * (the migration runner teaches the `=` form). Anything the script would not
 * act on is an error rather than ignored: an unread `--only=…` used to rotate
 * every active staff member instead of the one named.
 *
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {{ ok: true, prod: boolean, write: boolean, kill: boolean, only: string[] | null, except: string[] } | { ok: false, error: string }}
 */
export function parseRotateArgs(argv) {
  const seen = { prod: false, write: false, "kill-sessions": false };
  const lists = { only: null, except: null };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    const name = m?.[1];
    if (name && SWITCHES.includes(name) && m[2] === undefined) {
      seen[name] = true;
      continue;
    }
    if (name && LISTS.includes(name)) {
      const raw = m[2] ?? argv[++i];
      const emails = raw != null && !raw.startsWith("--")
        ? raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
        : [];
      if (emails.length === 0) return { ok: false, error: `--${name} needs a comma-separated list of emails, e.g. --${name}=a@drevifashion.com,b@drevifashion.com` };
      lists[name] = [...(lists[name] ?? []), ...emails];
      continue;
    }
    return { ok: false, error: `Unknown argument: ${argv[i]}` };
  }
  return { ok: true, prod: seen.prod, write: seen.write, kill: seen["kill-sessions"], only: lists.only, except: lists.except ?? [] };
}

/**
 * Create the owner-only password file up front (so a folder or permission
 * problem stops the run before any password changes) and hand back a writer
 * that appends one person at a time, the moment their password is set.
 * `wx` refuses an existing file, so the 600 mode always applies.
 *
 * @param {string} path
 * @param {string} header
 */
export function openPasswordFile(path, header) {
  writeFileSync(path, `${header}\n\n`, { mode: 0o600, flag: "wx" });
  return {
    path,
    /** @param {string} line */
    add(line) {
      appendFileSync(path, `${line}\n`);
    },
  };
}
