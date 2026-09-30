/**
 * The wholesale launch send over AiSensy: Rakesh's greeting, then the
 * walkthrough, each with the buyer's one-tap login button (0073). No password
 * travels — Meta will not approve a template carrying one.
 *
 *   node --experimental-strip-types --import ./scripts/lib/app-loader.mjs \
 *        scripts/send-launch.mjs --message greeting|login --prod [flags]
 *
 * DRY RUN by default: prints who would get it, who is held and why, and one
 * request body. Nothing is minted, sent or logged.
 *
 *   --send               actually send (needs --limit N, --all or --only)
 *   --limit N            send to the next N not yet sent (waves: 1, 5, rest)
 *   --all                no cap (Meta's new-number tier is 250 people a day)
 *   --only <buyerId>     just this buyer
 *   --to <phone>         deliver --only's message to this phone instead (a
 *                        test to yourself); never recorded as the buyer's send
 *   --include-shared     also send to buyers who got a login another way
 *                        before the launch (credential_shared, not a launch note)
 *   --retry-unknown      re-send where an earlier send timed out — only after
 *                        checking WhatsApp that the buyer did NOT get it
 *
 * Sends go from PROD only. The dev database holds copies of real buyers with
 * real phones, and the approved buttons open one fixed site
 * (AISENSY_LINK_ORIGIN), so without --prod the only send allowed is an
 * --only/--to test to your own phone.
 *
 * Run the greeting first and the login message about 15 minutes later: the
 * login message is the Utility copy Meta always delivers, the greeting is
 * Marketing and may be dropped for someone at their marketing cap.
 *
 * Needs, in the target env file: AISENSY_API_KEY, AISENSY_LINK_ORIGIN,
 * AISENSY_CAMPAIGN_GREETING / AISENSY_CAMPAIGN_LOGIN (Live API campaign names,
 * exact spelling), AISENSY_GREETING_VIDEO_URL / AISENSY_LOGIN_VIDEO_URL
 * (public URLs), optionally AISENSY_URL_BUTTON_INDEX (default 0).
 *
 * Never twice: a send is marked pending in backups/launch-send-<target>.json
 * BEFORE the request, and every outcome is written to the audit log in the
 * format src/lib/launch-note.ts parses back — so a lost or partial state file
 * still cannot cause a second send.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import dotenv from "dotenv";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const has = (n) => argv.includes(`--${n}`);

const prod = has("prod");
const envFile = prod ? ".env.local" : ".env.development.local";
dotenv.config({ path: envFile, override: true, quiet: true });

const kind = flag("message");
if (kind !== "greeting" && kind !== "login") {
  console.error("--message greeting|login is required");
  process.exit(1);
}
const send = has("send");
const only = flag("only");
const to = flag("to");
const retryUnknown = has("retry-unknown");
const limitFlag = flag("limit");
const limit = has("all") ? Infinity : limitFlag ? Number.parseInt(limitFlag, 10) : null;
if (send && !only && !(limit > 0)) {
  console.error("--send needs --limit N, --all or --only <buyerId> — no accidental full blast.");
  process.exit(1);
}
if (to && !only) {
  console.error("--to only works with --only (it redirects one buyer's message to a test phone).");
  process.exit(1);
}
if (send && !prod && !(only && to)) {
  console.error("Dev holds copies of real buyers' phones: without --prod the only send allowed is --only <id> --to <your phone>.");
  process.exit(1);
}

const { createAdminClient } = await import("@/lib/supabase/admin");
const { getOrCreateLoginToken } = await import("@/lib/login-link");
const { linkRefusal } = await import("@/lib/login-link-core");
const { launchMissing, launchPayload, sendLaunchMessage, preflightLoginLink, linkOrigin, e164 } = await import("@/lib/aisensy");
const { launchNote, parseLaunchNote } = await import("@/lib/launch-note");
const { writeAuditEvent } = await import("@/lib/audit");

const target = prod ? "prod" : "dev";
console.log(`Target: ${target.toUpperCase()} · message: ${kind} · ${send ? "SENDING" : "dry run"}`);
console.log(`Buttons open: ${linkOrigin() ?? "(AISENSY_LINK_ORIGIN not set)"}`);

const statePath = `backups/launch-send-${target}.json`;
if (!existsSync("backups")) mkdirSync("backups");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { buyers: {}, tests: [] };
state.buyers ??= {};
state.tests ??= [];
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

const admin = createAdminClient();

// PostgREST returns at most 1000 rows per request whatever .range asks for.
async function all(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

const everyBuyer = await all(() =>
  admin.from("buyers").select("id, business_name, phone, status, email, encrypted_password, created_at").order("created_at", { ascending: true }).order("id"),
);
const staffEmails = new Set((await all(() => admin.from("staff_users").select("email").order("email"))).map((r) => (r.email ?? "").toLowerCase()));
const shares = await all(() =>
  admin.from("auth_audit_log").select("id, buyer_id, notes, event_at").eq("event_type", "credential_shared").order("event_at").order("id"),
);

const sharedBefore = new Map(); // buyer → first share that was not a launch send
const launchSent = new Set(); // `${buyer}:${kind}` confirmed
const launchUnknown = new Set(); // `${buyer}:${kind}` timed out, may have gone
for (const s of shares) {
  if (!s.buyer_id) continue;
  const parsed = parseLaunchNote(s.notes);
  if (parsed) (parsed.unconfirmed ? launchUnknown : launchSent).add(`${s.buyer_id}:${parsed.kind}`);
  else if (!sharedBefore.has(s.buyer_id)) sharedBefore.set(s.buyer_id, s.event_at);
}

const statusesByEmail = new Map();
for (const b of everyBuyer) {
  if (!b.email) continue;
  const k = b.email.toLowerCase();
  statusesByEmail.set(k, [...(statusesByEmail.get(k) ?? []), b.status]);
}

const mask = (p) => (p ? `…${String(p).replace(/\D/g, "").slice(-4)}` : "—");
const candidates = everyBuyer.filter((b) => b.status === "active" && b.encrypted_password);
const byPhone = new Map();
for (const b of candidates) {
  const d = e164(b.phone);
  if (d) byPhone.set(d, [...(byPhone.get(d) ?? []), b.id]);
}

const ready = [];
const held = [];
for (const b of candidates) {
  if (only && b.id !== only) continue;
  const name = b.business_name ?? "(no name)";
  const key = `${b.id}:${kind}`;
  const mine = state.buyers[b.id]?.[kind];
  // The link /go would refuse (suspended duplicate, staff email, …) is not worth sending.
  const refusal = linkRefusal({
    link: { revoked_at: null },
    buyer: b,
    sameEmailStatuses: statusesByEmail.get((b.email ?? "").toLowerCase()) ?? [],
    emailIsStaff: staffEmails.has((b.email ?? "").toLowerCase()),
  });
  if (refusal) { held.push([name, `its link would be refused (${refusal})`]); continue; }
  if (!to) {
    if (mine?.sentAt || launchSent.has(key)) { held.push([name, `already sent the ${kind} message`]); continue; }
    if ((mine?.pendingAt || mine?.unknownAt || launchUnknown.has(key)) && !retryUnknown) {
      held.push([name, `an earlier ${kind} send may have gone (timed out) — check WhatsApp, then --retry-unknown`]);
      continue;
    }
    const dest = e164(b.phone);
    if (!dest) { held.push([name, b.phone ? `not a WhatsApp mobile (${mask(b.phone)})` : "no phone"]); continue; }
    const sharing = (byPhone.get(dest) ?? []).length;
    if (sharing > 1) { held.push([name, `number ${mask(dest)} is shared by ${sharing} buyers`]); continue; }
    if (sharedBefore.has(b.id) && !has("include-shared")) {
      held.push([name, `already has a login (shared ${String(sharedBefore.get(b.id)).slice(0, 10)})`]);
      continue;
    }
    ready.push({ ...b, dest });
  } else {
    if (!e164(to)) { console.error(`--to ${to} is not a WhatsApp mobile number (write foreign numbers with +).`); process.exit(1); }
    ready.push({ ...b, dest: e164(to) });
  }
}
if (only && ready.length === 0 && held.length === 0) {
  console.error(`--only ${only}: no active, credentialed buyer with that id.`);
  process.exit(1);
}

const batch = ready.slice(0, limit ?? ready.length);
console.log(`\nWould send: ${ready.length} · this run: ${batch.length} · held: ${held.length}`);
for (const [name, why] of held) console.log(`  held  ${name} — ${why}`);
const foreign = batch.filter((b) => !b.dest.startsWith("+91"));
for (const b of foreign) console.log(`  note  ${b.business_name} goes abroad: ${b.dest.slice(0, 4)}${mask(b.dest)}`);
if (batch.length > 240) console.log("\n⚠  Over 240 people: Meta's starting tier is 250 unique people per 24h, all messages included.");

const missing = launchMissing(kind);
if (missing.length) {
  console.log(`\nNot configured: set ${missing.join(", ")} in ${envFile}.`);
  if (send) process.exit(1);
} else if (batch[0]) {
  const p = launchPayload(kind, batch[0].dest, batch[0].business_name ?? "there", "<login-token>");
  console.log(`\nRequest body for ${batch[0].business_name}:`);
  console.log(JSON.stringify({ ...p, apiKey: `${p.apiKey.slice(0, 8)}…`, destination: mask(p.destination) }, null, 2));
}

if (!send) {
  console.log("\nDry run — nothing minted, sent or logged. Add --send to send.");
  process.exit(0);
}

let sent = 0, failed = 0, unknown = 0, preflighted = false;
for (const b of batch) {
  const name = b.business_name ?? "there";
  const link = await getOrCreateLoginToken(b.id, null);
  if (!link.ok) { failed++; console.log(`  FAIL  ${name}: ${link.error}`); continue; }

  // Before the first message: does the site the buttons open know this token?
  if (!preflighted) {
    const pre = await preflightLoginLink(kind, link.token);
    if (!pre.ok) { console.error(`\nStopped before sending anything: ${pre.error}`); process.exit(1); }
    preflighted = true;
  }

  const at = () => new Date().toISOString();
  if (!to) {
    state.buyers[b.id] = { ...(state.buyers[b.id] ?? {}), business: name, [kind]: { pendingAt: at(), to: mask(b.dest) } };
    save();
  }
  const res = await sendLaunchMessage(kind, b.dest, name, link.token, { timeoutMs: 20000 });

  if (to) {
    state.tests.push({ buyerId: b.id, kind, to: mask(b.dest), at: at(), ...(res.sent ? { sent: true } : { error: res.error }) });
    save();
    if (res.sent) sent++; else failed++;
    console.log(`  ${res.sent ? "sent" : "FAIL"}  ${name} → ${mask(b.dest)} (test)${res.sent ? "" : `: ${res.error}`}`);
  } else if (res.sent || res.uncertain) {
    state.buyers[b.id][kind] = res.sent ? { sentAt: at(), to: mask(b.dest) } : { unknownAt: at(), to: mask(b.dest), error: res.error };
    save();
    await writeAuditEvent({
      eventType: "credential_shared",
      buyerId: b.id,
      notes: launchNote(kind, `one-tap login sent over WhatsApp (AiSensy) to ${b.dest}`, { unconfirmed: !res.sent }),
    });
    if (res.sent) sent++; else unknown++;
    console.log(res.sent ? `  sent  ${name} → ${mask(b.dest)}` : `  ????  ${name}: ${res.error} — may have gone; held until --retry-unknown`);
  } else {
    failed++;
    const { [kind]: _pending, ...rest } = state.buyers[b.id];
    state.buyers[b.id] = { ...rest, [`${kind}Error`]: { at: at(), error: res.error } };
    save();
    console.log(`  FAIL  ${name}: ${res.error ?? "not sent"}`);
  }
  await new Promise((r) => setTimeout(r, 400));
}
console.log(`\nDone: ${sent} sent, ${failed} failed, ${unknown} unknown. State: ${statePath}`);
