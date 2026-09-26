/**
 * Import the CMAI enquirer register into buyers (Ansh, 23 Sep).
 *
 *   node scripts/import-cmai-enquirers.mjs --dry-run           # dev plan
 *   node scripts/import-cmai-enquirers.mjs                     # dev apply
 *   node scripts/import-cmai-enquirers.mjs --prod --dry-run    # prod plan
 *   node scripts/import-cmai-enquirers.mjs --prod              # prod apply (typed confirmation)
 *
 * Same shape as import-visiting-cards.mjs — dev by default, prod needs the flag
 * AND a typed confirmation — but a much thinner source: the CMAI tab is a
 * transcription of a paper register, one line per enquirer.
 *
 * ONLY Category = "Wholesale" is imported. The tab also carries "Agent" (13)
 * and "Other" (70); those are listed in the plan and left alone, because the
 * owner asked for wholesale customers only and an agent is a different entity
 * in this portal now.
 *
 * Two things the register cannot give us are treated as disqualifying rather
 * than guessed at:
 *   - no business/person name  -> skipped entirely. The login scheme derives
 *     the username from the name, and a nameless buyer cannot be addressed in
 *     a WhatsApp template either.
 *   - a phone that is not a complete, sendable number -> the row is still
 *     imported (it is a real lead) but phone stays null and the raw digits go
 *     into notes. A 9-digit fragment stored as a phone looks reachable in the
 *     buyers list and silently fails the credential send.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline/promises";
import { createClient } from "@supabase/supabase-js";
import { generateBuyerPassword } from "./lib/password.mjs";
import dotenv from "dotenv";

const PROD = process.argv.includes("--prod");
const DRY = process.argv.includes("--dry-run");
const XLSX = "/Users/anshsarawagi/Downloads/Enquirers/Drevi_Enquirers.xlsx";
const TAB = "CMAI";
const BUYER_LOGIN_DOMAIN = "buyers.drevifashion.com";
const BATCH = "cmai_2026_09";
const MAX_USERNAME = 20;

dotenv.config({ path: PROD ? ".env.local" : ".env.development.local", override: true });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const masterKeyB64 = process.env.PORTAL_PASSWORD_MASTER_KEY;
if (!url || !key) { console.error("Missing Supabase env"); process.exit(1); }
if (!masterKeyB64) { console.error("Missing PORTAL_PASSWORD_MASTER_KEY"); process.exit(1); }
const masterKey = Buffer.from(masterKeyB64, "base64");
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// ── xlsx, the hard way ──────────────────────────────────────────────────────
// A .xlsx is a zip of XML; openpyxl is not installed on this machine and this
// is a one-off. Unlike the visiting-card reader this one resolves a sheet by
// NAME: workbook order is not worksheet-file order, and CMAI is the third tab
// but xl/worksheets/sheet3.xml is a different sheet.
function unzip(file) {
  const buf = fs.readFileSync(file);
  const entries = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const method = buf.readUInt16LE(p + 10), compSize = buf.readUInt32LE(p + 20);
    const lnLen = buf.readUInt16LE(localOff + 26), leLen = buf.readUInt16LE(localOff + 28);
    const s = localOff + 30 + lnLen + leLen;
    entries[name] = method === 0 ? buf.subarray(s, s + compSize) : zlib.inflateRawSync(buf.subarray(s, s + compSize));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const xmlUnescape = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&amp;/g, "&"); // last, or "&amp;lt;" decodes twice
const colNum = (c) => [...c].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);

function readSheet(file, wanted) {
  const e = unzip(file);
  const shared = e["xl/sharedStrings.xml"]
    ? [...e["xl/sharedStrings.xml"].toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)]
        .map((m) => xmlUnescape([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")))
    : [];
  const rels = {};
  for (const m of (e["xl/_rels/workbook.xml.rels"]?.toString("utf8") ?? "").matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) rels[m[1]] = m[2];
  let target = null;
  for (const m of e["xl/workbook.xml"].toString("utf8").matchAll(/<sheet([^>]*?)\/?>/g)) {
    const nm = /name="([^"]*)"/.exec(m[1])?.[1];
    const rid = /r:id="([^"]*)"/.exec(m[1])?.[1];
    if (nm != null && xmlUnescape(nm) === wanted) target = rels[rid];
  }
  if (!target) throw new Error(`sheet "${wanted}" not found in ${file}`);
  const xml = e["xl/" + target.replace(/^\//, "").replace(/^xl\//, "")].toString("utf8");
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    // Empty cells are SELF-CLOSING (<c r="H2" s="3"/>); a regex that demands
    // </c> runs straight past them and swallows the next populated cell,
    // shifting every later column. Hence the alternation.
    for (const cm of rm[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = cm[1], attrs = cm[2], body = cm[3] ?? "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(body);
      const is = /<is>([\s\S]*?)<\/is>/.exec(body);
      let val = "";
      if (/t="s"/.test(attrs) && v) val = shared[Number(v[1])] ?? "";
      else if (is) val = xmlUnescape([...is[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""));
      else if (v) val = xmlUnescape(v[1]);
      cells[col] = String(val).trim();
    }
    rows.push(cells);
  }
  const hdr = rows[0] ?? {};
  const cols = Object.keys(hdr).sort((a, b) => colNum(a) - colNum(b));
  const names = cols.map((c) => hdr[c]);
  return rows.slice(1).filter((r) => cols.some((c) => r[c]))
    .map((r) => Object.fromEntries(names.map((n, i) => [n, r[cols[i]] ?? ""])));
}

// ── phones ──────────────────────────────────────────────────────────────────
// The portal stores E.164. A register entry is only accepted when it yields a
// number Interakt can actually address:
//   - 10 digits starting 6-9, optionally prefixed 0 / 91 / +91  -> +91XXXXXXXXXX
//   - an explicit +<cc> that is NOT 91 -> only +1 (NANP), because
//     lib/interakt.ts's splitPhone hard-assumes a TEN-digit national number:
//     it sends digits.slice(0, len-10) as the country code. India and NANP
//     are 10; a +971 mobile is 9, so "+971 54406740" would go out as country
//     code "+9", number "7154406740" — a mangled address that reports as
//     sent. Refused here instead, with the raw digits kept in notes.
// Everything else is a fragment off a paper register — returned as a reason,
// not a number.
function parsePhone(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { phone: null, reason: "blank" };
  const intl = /^\+(\d{6,15})$/.exec(s.replace(/[\s-]/g, ""));
  if (intl && !intl[1].startsWith("91")) {
    const d = intl[1];
    if (/^1[2-9]\d{9}$/.test(d)) return { phone: "+" + d, reason: null };
    return { phone: null, reason: `+${d} — non-Indian number the WhatsApp sender cannot address (only +91 and +1 have 10-digit national numbers)` };
  }
  let d = s.replace(/\D/g, "");
  if (d.length > 10 && d.startsWith("91")) d = d.slice(-10);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10 && /^[6-9]/.test(d)) return { phone: "+91" + d, reason: null };
  if (d.length === 10) return { phone: null, reason: `10 digits but starts ${d[0]} — not a mobile` };
  return { phone: null, reason: `${d.length} digits — incomplete` };
}

/**
 * Register lines the OWNER has confirmed are an existing buyer under another
 * spelling. S.No -> that buyer's login (the local part of its email).
 *
 * #103 "Vaparimal Savaldas" +919888206700 against the visiting-card buyer
 * "Vaparimal Savaldas Wholesale Studio (Naren Pearl)" +918888206700 — one
 * leading digit apart. The card buyer's own notes say "Phone numbers confirmed
 * complete from re-captured card in Slot2", so the 8- number is the verified
 * one and the register's 9- is a misread of the same shop. Merged on Ansh's
 * call, 25 Sep: no second buyer row and no second login.
 *
 * The register's number is still written as a CONTACT. It is never a send
 * target — every WhatsApp path reads buyers.phone and nothing reads
 * buyer_contacts — but it is what the dedup keys on, so recording it stops the
 * next import from recreating exactly this duplicate.
 */
const MANUAL_MERGES = {
  "103": "vaparimalsavaldas",
};

const clean = (s) => String(s ?? "").trim().replace(/\s+/g, " ") || null;
const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const nameKey = (s) => slug(s);

function usernameFor(businessName) {
  let words = String(businessName ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 1 && /^(the|a|an)$/i.test(words[0])) words = words.slice(1);
  let out = "";
  for (const w of words) {
    const s = slug(w);
    if (!s) continue;
    if (out && out.length + s.length > MAX_USERNAME) break;
    out += s;
    if (out.length >= MAX_USERNAME) break;
  }
  if (!out) out = slug(businessName).slice(0, MAX_USERNAME);
  return out.slice(0, MAX_USERNAME);
}

function encryptPassword(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

// ── read + filter ───────────────────────────────────────────────────────────
const all = readSheet(XLSX, TAB);
const catOf = (r) => clean(r["Category"])?.toLowerCase() ?? "";
const wholesale = all.filter((r) => catOf(r) === "wholesale");
const otherCats = {};
for (const r of all) if (catOf(r) !== "wholesale") otherCats[clean(r["Category"]) ?? "(blank)"] = (otherCats[clean(r["Category"]) ?? "(blank)"] ?? 0) + 1;

const skipped = [];
const candidates = [];
for (const r of wholesale) {
  const sn = clean(r["S.No"]) ?? "?";
  const name = clean(r["Name / Business"]);
  const { phone, reason } = parsePhone(r["Phone Number"]);
  if (!name) { skipped.push({ sn, why: "no name in the register", raw: clean(r["Phone Number"]) ?? "" }); continue; }
  const notes = [
    clean(r["Notes"]),
    clean(r["Why classified"]) ? `classified wholesale: ${clean(r["Why classified"])}` : null,
    clean(r["Needs Check"]) ? `NEEDS CHECK: ${clean(r["Needs Check"])}` : null,
    phone ? null : `phone in register "${clean(r["Phone Number"]) ?? ""}" not usable (${reason}) — not stored`,
    clean(r["Source Photo"]) ? `register photo ${clean(r["Source Photo"])}` : null,
  ].filter(Boolean);
  candidates.push({
    sn, business_name: name, phone, phoneReason: reason,
    notes: `[${BATCH}] ${notes.join("; ")}`,
  });
}

// Fold duplicates inside the tab. BY PHONE **AND BY NAME**.
//
// The phone fold is inherited from import-visiting-cards.mjs, where it worked:
// a card row carried every number for that brand, so a second-number row
// shared a phone with the first. This register is the opposite shape — one
// number per LINE — so the phone fold can never fire on it, and it does not:
// no two wholesale rows share a phone. What the register does instead is
// repeat the business name on the next line and write "Second number" in the
// notes. Folding on phone alone therefore let a shop through twice, with two
// buyer rows, two logins and two WhatsApp messages carrying different
// credentials, and the buyer's cart and orders split across the two.
//
// There are exactly two such pairs in this tab (#85/#86 Arvind - Viva and
// #98/#99 Ankit Kumar Gupta - Anshu Shree Enterprises), they are the ONLY
// repeated names among the 122 wholesale rows, and both are corroborated by
// the register itself: same Source Photo, and Notes saying "Second number".
// Every fold is printed in the plan so it stays a human-checkable claim.
//
// The survivor is the earliest S.No; it takes the first USABLE phone in the
// group, so a pair whose first line holds the unusable fragment still ends up
// reachable. The other numbers are kept as buyer_contacts rows rather than
// dropped — that is also what makes the NEXT import dedupe correctly, which is
// exactly how the seven visiting-card businesses were caught above.
const byPhone = new Map();
const byName = new Map();
const rowsIn = [];
for (const c of candidates) {
  const hit = (c.phone ? byPhone.get(c.phone) : null) ?? byName.get(nameKey(c.business_name));
  if (hit) {
    (hit.mergedFrom ??= []).push(`#${c.sn}${c.phone ? ` ${c.phone}` : " (no usable phone)"}`);
    if (c.phone && c.phone !== hit.phone) (hit.extraPhones ??= []).push(c.phone);
    if (!hit.phone && c.phone) { hit.phone = c.phone; hit.phoneReason = null; }
    if (c.phone) byPhone.set(c.phone, hit);
    continue;
  }
  rowsIn.push(c);
  if (c.phone) byPhone.set(c.phone, c);
  byName.set(nameKey(c.business_name), c);
}
for (const c of rowsIn) {
  if (!c.mergedFrom) continue;
  c.notes += `; folded in register line(s) ${c.mergedFrom.join(", ")} — same business name`;
  if (c.extraPhones?.length) c.notes += `; additional number(s) ${c.extraPhones.join(", ")} kept as contacts`;
}

// ── match against the portal ────────────────────────────────────────────────
const { data: existing, error: exErr } = await admin
  .from("buyers").select("id, business_name, phone, email, notes, created_at").range(0, 9999);
if (exErr) { console.error(`buyers read: ${exErr.message}`); process.exit(1); }
const { data: existingContacts } = await admin.from("buyer_contacts").select("buyer_id, phone").range(0, 9999);

const phoneToBuyer = new Map();
for (const b of [...(existing ?? [])].sort((a, b2) => String(a.created_at).localeCompare(String(b2.created_at)))) {
  const { phone } = parsePhone(b.phone);
  // Oldest wins, deterministically: the portal carries a few duplicate pairs
  // and whichever the map kept last would otherwise decide the match.
  if (phone && !phoneToBuyer.has(phone)) phoneToBuyer.set(phone, b);
}
for (const c of existingContacts ?? []) {
  const { phone } = parsePhone(c.phone);
  const b = (existing ?? []).find((x) => x.id === c.buyer_id);
  if (phone && b && !phoneToBuyer.has(phone)) phoneToBuyer.set(phone, b);
}
const nameToBuyer = new Map();
for (const b of [...(existing ?? [])].sort((a, b2) => String(a.created_at).localeCompare(String(b2.created_at)))) {
  const k = nameKey(b.business_name);
  if (k && !nameToBuyer.has(k)) nameToBuyer.set(k, b);
}

const byLogin = new Map((existing ?? []).map((b) => [(b.email || "").split("@")[0].toLowerCase(), b]));
const matched = [], fresh = [], merges = [];
for (const c of rowsIn) {
  const wantLogin = MANUAL_MERGES[String(c.sn)];
  if (wantLogin) {
    const target = byLogin.get(wantLogin);
    // A merge target that does not exist is a typo in the table above, not a
    // reason to quietly insert the duplicate the merge was meant to prevent.
    if (!target) { console.error(`  ! MANUAL_MERGES #${c.sn} -> "${wantLogin}" matches no buyer — aborting`); process.exit(1); }
    matched.push({ ...c, buyer: target, how: "merged" });
    merges.push({ ...c, buyer: target });
    continue;
  }
  const byP = c.phone ? phoneToBuyer.get(c.phone) : null;
  const byN = byP ? null : nameToBuyer.get(nameKey(c.business_name));
  if (byP || byN) matched.push({ ...c, buyer: byP ?? byN, how: byP ? "phone" : "name" });
  else fresh.push(c);
}

// ── usernames: claimed against EVERY login already issued ───────────────────
const taken = new Set();
for (const b of existing ?? []) { const u = (b.email || "").split("@")[0].toLowerCase(); if (u) taken.add(u); }
const { data: staff } = await admin.from("staff_users").select("email").range(0, 999);
for (const s of staff ?? []) { const u = (s.email || "").split("@")[0].toLowerCase(); if (u) taken.add(u); }
for (const f of fresh) {
  const base = usernameFor(f.business_name);
  let u = base, n = 2;
  while (!u || taken.has(u)) { u = base.slice(0, MAX_USERNAME - String(n).length) + n; n++; }
  taken.add(u);
  // A suffixed username means some existing buyer ALREADY claimed this exact
  // name. That is the one duplicate signal this script computes and would
  // otherwise throw away — and it is a real one: "Vaparimal Savaldas" collided
  // with "Vaparimal Savaldas Wholesale Studio (Naren Pearl)" from the visiting
  // cards, whose phone differs from the register's by a single leading digit
  // (8888206700 vs 9888206700). Too weak to merge on automatically, far too
  // strong to swallow — so it is surfaced for a human instead.
  if (u !== base) f.usernameClash = base;
  f.username = u;
  // Not derived from the username (Ansh, 25 Sep). A <username>+suffix scheme
  // is computable by anyone who knows the shop name, and a trailing "123"
  // trips the breach warnings in phone keyboards and password managers.
  // Same generator the admin's own credential button uses.
  f.password = generateBuyerPassword(null, f.business_name);
}
const clashes = fresh.filter((f) => f.usernameClash);

// ── plan ────────────────────────────────────────────────────────────────────
console.log(`TARGET: ${PROD ? "PRODUCTION" : "dev"} (${url})`);
console.log(`${TAB} tab: ${all.length} rows · Category=Wholesale: ${wholesale.length}`);
console.log(`not imported by category: ${Object.entries(otherCats).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`after folding in-tab duplicates: ${rowsIn.length}`);
console.log(`existing buyers in portal: ${(existing ?? []).length}`);
console.log(`  -> already a buyer (skipped): ${matched.length}   [${matched.filter((m) => m.how === "phone").length} by phone, ${matched.filter((m) => m.how === "name").length} by name]`);
console.log(`  -> to insert:                 ${fresh.length}   (${fresh.filter((f) => f.phone).length} with a usable phone, ${fresh.filter((f) => !f.phone).length} without)`);
console.log(`  -> skipped, unusable row:     ${skipped.length}`);

if (merges.length) {
  console.log("\nMERGED INTO AN EXISTING BUYER (your call — no new row, no new login):");
  for (const m of merges) {
    console.log(`  #${String(m.sn).padStart(3)} "${m.business_name}" ${m.phone ?? "(no phone)"}`);
    console.log(`        -> ${m.buyer.business_name} (${m.buyer.phone ?? "no phone"})`);
    console.log(`        register number kept as a contact; it is never a send target`);
  }
}
if (matched.length) {
  console.log("\nALREADY IN THE PORTAL (left untouched):");
  for (const m of matched) console.log(`  ${m.how.padEnd(5)} #${String(m.sn).padStart(3)} ${m.business_name}  ->  ${m.buyer.business_name}`);
}
const folded = rowsIn.filter((c) => c.mergedFrom);
if (folded.length) {
  console.log("\nIN-TAB DUPLICATES FOLDED (same business repeated in the register):");
  for (const f of folded) console.log(`  #${String(f.sn).padStart(3)} ${f.business_name}  keeps ${f.phone ?? "(no phone)"}  <- folded ${f.mergedFrom.join(", ")}`);
}
if (skipped.length) {
  console.log("\nSKIPPED (yours to fix in the register):");
  for (const s of skipped) console.log(`  #${String(s.sn).padStart(3)}  ${s.why}${s.raw ? `  (phone "${s.raw}")` : ""}`);
}
const noPhone = fresh.filter((f) => !f.phone);
if (noPhone.length) {
  console.log("\nIMPORTED WITHOUT A PHONE (login issued, but unmessageable until fixed):");
  for (const f of noPhone) console.log(`  #${String(f.sn).padStart(3)}  ${f.business_name.padEnd(38)} ${f.phoneReason}`);
}
if (clashes.length) {
  console.log("\nPOSSIBLE DUPLICATES — imported separately, YOURS TO CHECK:");
  for (const f of clashes) {
    const twin = (existing ?? []).find((b) => (b.email || "").split("@")[0].toLowerCase() === f.usernameClash);
    console.log(`  #${String(f.sn).padStart(3)} "${f.business_name}" ${f.phone ?? "(no phone)"}`);
    console.log(`        wanted the login "${f.usernameClash}", already held by "${twin?.business_name ?? "?"}" ${twin?.phone ?? ""}`);
    console.log(`        -> imported as "${f.username}". Merge them by hand if they are the same shop.`);
  }
}

console.log("\nSAMPLE OF NEW LOGINS:");
for (const f of fresh.slice(0, 6)) console.log(`  ${f.business_name.padEnd(38)} ${String(f.username).padEnd(22)} ${f.password}`);

fs.mkdirSync("backups", { recursive: true });
const planFile = `backups/cmai-plan-${PROD ? "prod" : "dev"}.json`;
fs.writeFileSync(planFile, JSON.stringify({
  matched: matched.map((m) => ({ sn: m.sn, sheet: m.business_name, buyer: m.buyer.business_name, how: m.how })),
  insert: fresh.map((f) => ({ sn: f.sn, name: f.business_name, phone: f.phone, username: f.username, password: f.password })),
  merges: merges.map((m) => ({ sn: m.sn, sheet: m.business_name, into: m.buyer.business_name, phone: m.phone })),
  skipped,
}, null, 1));
console.log(`\nplan written: ${planFile}`);

if (DRY) { console.log("\n--dry-run — nothing written."); process.exit(0); }
if (!fresh.length) { console.log("\nNothing new to insert."); process.exit(0); }

if (PROD) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`\nType IMPORT-CMAI to write ${fresh.length} new buyers and ${fresh.length} logins on PRODUCTION: `);
  rl.close();
  if (a.trim() !== "IMPORT-CMAI") { console.error("Confirmation did not match — aborting."); process.exit(1); }
}

// ── apply ───────────────────────────────────────────────────────────────────
// RE-READ before writing. The plan above was built BEFORE the confirmation
// prompt, and that prompt can sit open for a long time — a second copy of this
// script, or a buyer added by hand in the meantime, would not be in it. An
// insert-only import with a stale plan does not fail loudly; it silently
// doubles every row. So the match is redone here against the database as it is
// at this instant, and anything that now exists is dropped from the batch.
{
  const { data: now, error } = await admin.from("buyers").select("id, business_name, phone, email").range(0, 9999);
  if (error) { console.error(`pre-write re-read failed: ${error.message} — refusing to write`); process.exit(1); }
  // buyer_contacts TOO, and for the same reason the planning stage reads it:
  // a business that came in off a visiting card often carries its number on a
  // CONTACT row while buyers.phone is null. A guard that reads only `buyers`
  // is narrower than the matcher it is supposed to back up — tested against
  // dev, exactly that gap let 7 of 119 rows through, each of which would have
  // been inserted a second time under the register's spelling of the name.
  const { data: nowContacts, error: cErr2 } = await admin.from("buyer_contacts").select("phone").range(0, 9999);
  if (cErr2) { console.error(`pre-write contacts re-read failed: ${cErr2.message} — refusing to write`); process.exit(1); }
  const nowPhones = new Set();
  const nowEmails = new Set();
  const nowNames = new Set();
  for (const b of now ?? []) {
    const { phone } = parsePhone(b.phone);
    if (phone) nowPhones.add(phone);
    if (b.email) nowEmails.add(String(b.email).toLowerCase());
    if (b.business_name) nowNames.add(nameKey(b.business_name));
  }
  for (const c of nowContacts ?? []) {
    const { phone } = parsePhone(c.phone);
    if (phone) nowPhones.add(phone);
  }
  const stale = [];
  for (let i = fresh.length - 1; i >= 0; i--) {
    const f = fresh[i];
    const why = (f.phone && nowPhones.has(f.phone)) ? "phone"
      : nowEmails.has(`${f.username}@${BUYER_LOGIN_DOMAIN}`) ? "login"
      : (!f.phone && nowNames.has(nameKey(f.business_name))) ? "name"
      : null;
    if (why) { stale.push({ ...f, why }); fresh.splice(i, 1); }
  }
  if (stale.length) {
    console.log(`\nDROPPED AT WRITE TIME — these arrived after the plan was built:`);
    for (const s2 of stale.reverse()) console.log(`  ${s2.why.padEnd(5)} #${String(s2.sn).padStart(3)} ${s2.business_name}`);
    console.log(`  (${stale.length} dropped, ${fresh.length} left to insert)`);
  }
  if (!fresh.length) { console.log("\nEverything in the plan already exists — nothing written."); process.exit(0); }
}

let inserted = 0, credentialed = 0, contactRows = 0, mergedRows = 0;

// Merges first: they only ever ADD to a buyer that already exists, so doing
// them before any insert means a failure here cannot leave a half-written batch.
for (const m of merges) {
  if (m.phone) {
    const { data: already } = await admin.from("buyer_contacts").select("phone").eq("buyer_id", m.buyer.id);
    const have = new Set((already ?? []).map((r) => r.phone).filter(Boolean));
    if (!have.has(m.phone)) {
      const { error } = await admin.from("buyer_contacts").insert({
        buyer_id: m.buyer.id, phone: m.phone, is_primary: false,
        position: (already?.length ?? 0) + 1, source: "cmai_register", created_by: "import",
      });
      if (error) console.error(`  ! merge contact ${m.phone}: ${error.message}`);
      else contactRows++;
    }
  }
  const note = [m.buyer.notes, `[${BATCH}] register line #${m.sn} "${m.business_name}" merged here${m.phone ? ` — register number ${m.phone} (unverified, one digit off the confirmed card number)` : ""}`]
    .filter(Boolean).join("\n");
  const { error: nErr } = await admin.from("buyers").update({ notes: note }).eq("id", m.buyer.id);
  if (nErr) console.error(`  ! merge note for ${m.buyer.business_name}: ${nErr.message}`);
  else mergedRows++;
}
// Second layer, because the re-read above is a SNAPSHOT: it is taken before
// the first insert, so it can only catch rows that already existed when the
// loop started, never a duplicate created by the loop itself.
const writtenNames = new Set();
const writtenPhones = new Set();
for (const f of fresh) {
  const nk = nameKey(f.business_name);
  if (writtenNames.has(nk) || (f.phone && writtenPhones.has(f.phone))) {
    console.error(`  ! refusing to insert #${f.sn} ${f.business_name} — this run already wrote it`);
    continue;
  }
  const { data, error } = await admin.from("buyers").insert({
    business_name: f.business_name,
    phone: f.phone,
    email: `${f.username}@${BUYER_LOGIN_DOMAIN}`,
    notes: f.notes,
    status: "active",
    source: "exhibition",
    import_batch: BATCH,
    captured_at: new Date().toISOString(),
  }).select("id").single();
  if (error) { console.error(`  ! insert #${f.sn} ${f.business_name}: ${error.message}`); continue; }
  f.buyerId = data.id;
  writtenNames.add(nk);
  if (f.phone) writtenPhones.add(f.phone);
  inserted++;
  // The folded-in numbers, so this business is reachable on either line and so
  // the next import matches it by phone instead of inserting it again.
  for (const [i, extra] of (f.extraPhones ?? []).entries()) {
    const { error: ctErr } = await admin.from("buyer_contacts").insert({
      buyer_id: data.id, phone: extra, is_primary: false, position: i + 2,
      source: "cmai_register", created_by: "import",
    });
    if (ctErr) console.error(`  ! contact ${extra} for ${f.business_name}: ${ctErr.message}`);
    else contactRows++;
  }
}

// Credentials LAST: a buyer must exist before its login points at one.
for (const f of fresh) {
  if (!f.buyerId || !f.username) continue;
  const email = `${f.username}@${BUYER_LOGIN_DOMAIN}`;
  const { data: created, error: cErr } = await admin.auth.admin.createUser({ email, password: f.password, email_confirm: true });
  if (cErr && !/already/i.test(cErr.message)) { console.error(`  ! auth ${f.username}: ${cErr.message}`); continue; }
  if (!created?.user?.id) {
    const { data: page } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const hit = (page?.users ?? []).find((u) => (u.email || "").toLowerCase() === email);
    if (hit) await admin.auth.admin.updateUserById(hit.id, { password: f.password, email_confirm: true });
  }
  const { error: bErr } = await admin.from("buyers")
    .update({ email, encrypted_password: encryptPassword(f.password), status: "active" })
    .eq("id", f.buyerId);
  if (!bErr) credentialed++;
}

console.log(`\nDONE — inserted ${inserted}, merged ${mergedRows}, contacts ${contactRows}, logins ${credentialed}`);
