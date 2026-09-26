/**
 * Import the exhibition visiting-card directory into buyers (Ansh, 21 Sep).
 *
 *   node scripts/import-visiting-cards.mjs --dry-run           # dev plan
 *   node scripts/import-visiting-cards.mjs                     # dev apply
 *   node scripts/import-visiting-cards.mjs --prod --dry-run    # prod plan
 *   node scripts/import-visiting-cards.mjs --prod              # prod apply (typed confirmation)
 *
 * Target selection mirrors setup-buyer-logins.mjs: dev by default, prod needs
 * the flag AND a typed confirmation, because this writes buyer identities,
 * credentials and images to the live portal.
 *
 * WHAT IT DOES, in order:
 *  1. Reads Visiting_Cards_Directory.xlsx with no dependency — the file is a
 *     zip of XML and openpyxl is not installed on this machine.
 *  2. Normalises every phone to E.164 (+91XXXXXXXXXX), the shape buyers.phone
 *     already uses, so a cross-table match is plain equality.
 *  3. De-duplicates. PHONE FIRST, across all four phone columns and against
 *     every existing buyer AND buyer_contact. Name is only a fallback: six
 *     prod buyers matched by phone and ZERO by name, because the card and the
 *     portal spell the brand differently ("Riza Boutique" vs "Kiza boutique").
 *  4. Builds one golden record per brand. On a conflict the CARD wins — it is
 *     the brand's own spelling — and the previous portal value is appended to
 *     notes rather than discarded.
 *  5. Writes buyer_contacts, one row per named person.
 *  6. Uploads the cards, converting HEIC to JPEG: browsers do not render HEIC,
 *     and these are read through signed URLs in an <img>.
 *  7. Re-issues EVERY buyer's login on the owner's scheme:
 *        username = business name, lowercased, a-z0-9, capped at 20 chars on a
 *                   word boundary; collisions get the next word, then a digit
 *        password = generateBuyerPassword(owner, business), i.e. firstname+3digits — NOT
 *                   derived from the username (changed 25 Sep)
 *     Owner asked for the existing 49 to be moved onto it too, so their
 *     usernames and passwords BOTH change — they have to be told.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline/promises";
import { createClient } from "@supabase/supabase-js";
import { generateBuyerPassword } from "./lib/password.mjs";
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import dotenv from "dotenv";

const PROD = process.argv.includes("--prod");
const DRY = process.argv.includes("--dry-run");
const CARDS_DIR = "/Users/anshsarawagi/Downloads/Visiting_Cards";
const XLSX = path.join(CARDS_DIR, "Visiting_Cards_Directory.xlsx");
const SLOTS = ["Slot1", "Slot2", "slot3"];
const BUYER_LOGIN_DOMAIN = "buyers.drevifashion.com";
const BATCH = "visiting_cards_2026_09";
const MAX_USERNAME = 20;
let viaSips = 0;

dotenv.config({ path: PROD ? ".env.local" : ".env.development.local", override: true });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const masterKeyB64 = process.env.PORTAL_PASSWORD_MASTER_KEY;
if (!url || !key) { console.error("Missing Supabase env"); process.exit(1); }
if (!masterKeyB64) { console.error("Missing PORTAL_PASSWORD_MASTER_KEY"); process.exit(1); }
const masterKey = Buffer.from(masterKeyB64, "base64");
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// ── xlsx, the hard way ──────────────────────────────────────────────────────
// A .xlsx is a zip; the parts we need are two XML files. Written out rather
// than adding a dependency for a one-off import.
function readXlsx(file) {
  const buf = fs.readFileSync(file);
  const entries = {};
  // Walk the central directory backwards from the End Of Central Directory.
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const lnLen = buf.readUInt16LE(localOff + 26);
    const leLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lnLen + leLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    entries[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  const textOf = (xml) => {
    const out = [];
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      out.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""));
    }
    return out;
  };
  const unescape = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const shared = entries["xl/sharedStrings.xml"] ? textOf(entries["xl/sharedStrings.xml"].toString("utf8")).map(unescape) : [];
  const sheet = entries["xl/worksheets/sheet1.xml"].toString("utf8");
  const rows = [];
  for (const rm of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    // Empty cells are SELF-CLOSING (<c r="H2" s="3"/>). A regex that demands
    // </c> spans straight past them and swallows the next populated cell with
    // it, which silently shifted every later column — 91 of 124 rows lost
    // their image list that way before this alternation was added.
    for (const cm of rm[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = cm[1], attrs = cm[2], body = cm[3] ?? "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(body);
      const is = /<is>([\s\S]*?)<\/is>/.exec(body);
      let val = "";
      if (/t="s"/.test(attrs) && v) val = shared[Number(v[1])] ?? "";
      else if (is) val = unescape([...is[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""));
      else if (v) val = unescape(v[1]);
      cells[col] = String(val).trim();
    }
    rows.push(cells);
  }
  const hdr = rows[0];
  const cols = Object.keys(hdr).sort((a, b) => (a.length - b.length) || a.localeCompare(b));
  const names = cols.map((c) => hdr[c]);
  return rows.slice(1)
    .filter((r) => cols.some((c) => r[c]))
    .map((r) => Object.fromEntries(names.map((n, i) => [n, r[cols[i]] ?? ""])));
}

// ── normalisation ───────────────────────────────────────────────────────────
// The portal stores +91XXXXXXXXXX. Cards carry "+91 98765 43210", "09876543210",
// "98765 43210 / 98765 43211". Anything that is not a a 10-digit Indian mobile
// after cleaning is dropped rather than guessed at — a half-parsed phone is
// worse than none, because it is what de-duplication keys on.
function normPhone(raw) {
  const out = [];
  for (const part of String(raw ?? "").split(/[,/;|]| and /i)) {
    let d = part.replace(/\D/g, "");
    if (d.length > 10 && d.startsWith("91")) d = d.slice(-10);
    else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
    if (d.length === 10 && /^[6-9]/.test(d)) out.push("+91" + d);
  }
  return [...new Set(out)];
}
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

// ── images ──────────────────────────────────────────────────────────────────
function indexImages() {
  const have = new Map();
  for (const slot of SLOTS) {
    const dir = path.join(CARDS_DIR, slot);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (f.startsWith(".")) continue;
      const m = /IMG[_ ]?(\d+)/i.exec(f);
      if (!m) continue;
      const key = "IMG_" + m[1];
      // "IMG_2233 2.HEIC" is a Finder duplicate of "IMG_2233.HEIC"; prefer the
      // clean name when both exist, but take the duplicate when it is all there is.
      const isDupe = /\s\d+\./.test(f);
      const prev = have.get(key);
      if (!prev || (prev.isDupe && !isDupe)) have.set(key, { file: path.join(dir, f), isDupe });
    }
  }
  return have;
}

async function toJpeg(srcFile) {
  try {
    return await sharp(srcFile).rotate().resize({ width: 2000, withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer();
  } catch (e) {
    // libheif refuses an image whose iref box holds more than 16 references,
    // and a fair number of these cards have 48 — it is a security limit, not a
    // corrupt file. macOS decodes them fine, so hand those to sips and put the
    // result back through sharp for the resize.
    if (!/Security limit|corrupt header/i.test(String(e.message))) throw e;
    const tmp = path.join("/tmp", `vc-${crypto.randomBytes(6).toString("hex")}.jpg`);
    execFileSync("sips", ["-s", "format", "jpeg", srcFile, "--out", tmp], { stdio: "ignore" });
    const out = await sharp(tmp).rotate().resize({ width: 2000, withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer();
    fs.unlinkSync(tmp);
    viaSips++;
    return out;
  }
}

// The app's uploadBuyerCardImage calls ensureBucket first; a script that skips
// it fails with a bare "Bucket not found" on a fresh environment. Same private
// bucket, same 5MB limit as src/lib/storage.ts.
let bucketReady = false;
async function ensureCardBucket() {
  if (bucketReady) return;
  const { data } = await admin.storage.getBucket("buyer-cards");
  if (!data) await admin.storage.createBucket("buyer-cards", { public: false, fileSizeLimit: "5MB" });
  bucketReady = true;
}

async function uploadCard(buyerId, srcFile, index) {
  await ensureCardBucket();
  // HEIC straight from an iPhone does not render in any browser, and these are
  // shown through a signed URL in an <img>. Convert once, here.
  const jpeg = await toJpeg(srcFile);
  const p = index === 0 ? `${buyerId}/card.jpg` : `${buyerId}/card-${index + 1}.jpg`;
  const { error } = await admin.storage.from("buyer-cards").upload(p, jpeg, { contentType: "image/jpeg", upsert: true });
  if (error) throw new Error(`card upload ${p}: ${error.message}`);
  return p;
}

// ── main ────────────────────────────────────────────────────────────────────
const rows = readXlsx(XLSX);
const images = indexImages();

// Shape each card row into a candidate golden record.
const cards = rows.map((r, i) => {
  const contacts = [];
  for (const n of [1, 2, 3]) {
    const first = clean(r[`First Name ${n}`]);
    const last = clean(r[`Last Name ${n}`]);
    const desig = clean(r[`Designation ${n}`]);
    const phones = normPhone(r[`Phone ${n}`]);
    if (!first && !last && !desig && phones.length === 0) continue;
    contacts.push({ first_name: first, last_name: last, designation: desig, phone: phones[0] ?? null, extra: phones.slice(1), position: n });
  }
  const office = normPhone(r["Phone 4 (Other/Office)"]);
  if (office.length) contacts.push({ first_name: null, last_name: null, designation: "Office", phone: office[0], extra: office.slice(1), position: 4 });
  const allPhones = [...new Set(contacts.flatMap((c) => [c.phone, ...c.extra]).filter(Boolean))];
  const imgs = String(r["Source Image(s)"] ?? "").split(/[,;]/).map((t) => t.trim()).filter(Boolean)
    .map((t) => { const m = /IMG[_ ]?(\d+)/i.exec(t); return m ? images.get("IMG_" + m[1]) : null; })
    .filter(Boolean).map((x) => x.file);
  return {
    row: i + 2,
    business_name: clean(r["Brand / Business Name"]),
    category: clean(r["Products / Category"]),
    gstin: clean(r["GSTIN"]),
    email: clean(r["Email 1"])?.toLowerCase() ?? null,
    email_alt: clean(r["Email 2"])?.toLowerCase() ?? null,
    website: clean(r["Website"]),
    instagram: clean(r["Instagram"]),
    facebook: clean(r["Facebook"]),
    address: clean(r["Address"]),
    notes: clean(r["Notes"]),
    contacts, allPhones, images: imgs,
  };
}).filter((c) => c.business_name);

// Fold sheet-internal duplicates (same phone on two rows) into one record.
const byPhone = new Map();
const merged = [];
for (const c of cards) {
  const hit = c.allPhones.map((p) => byPhone.get(p)).find(Boolean);
  if (hit) {
    hit.mergedFrom = hit.mergedFrom || [];
    hit.mergedFrom.push(c.business_name);
    for (const k of ["category", "gstin", "email", "email_alt", "website", "instagram", "facebook", "address"]) if (!hit[k] && c[k]) hit[k] = c[k];
    for (const ct of c.contacts) if (!hit.contacts.some((x) => x.phone && x.phone === ct.phone)) hit.contacts.push({ ...ct, position: hit.contacts.length + 1 });
    hit.images = [...new Set([...hit.images, ...c.images])];
    hit.allPhones = [...new Set([...hit.allPhones, ...c.allPhones])];
    for (const p of c.allPhones) byPhone.set(p, hit);
    continue;
  }
  merged.push(c);
  for (const p of c.allPhones) byPhone.set(p, c);
}

const { data: existing } = await admin.from("buyers").select("id, business_name, owner_name, phone, email, city, gstin, address, notes, status, created_at, card_image_path");
const { data: existingContacts } = await admin.from("buyer_contacts").select("buyer_id, phone");
const phoneToBuyer = new Map();
// A phone can already point at TWO buyer rows — the portal carries duplicate
// pairs (THE ROYAL VIVA, RAJWADA, Radhkrishna NX). Whichever the map happened
// to keep last would get the card and the twin would silently diverge, so the
// OLDEST row wins deterministically and the clash is reported for a human to
// merge. This import does not merge buyers; that is a decision with orders and
// credentials hanging off it.
const portalDupes = [];
for (const b of existing ?? []) {
  for (const p of normPhone(b.phone)) {
    const prev = phoneToBuyer.get(p);
    if (prev && prev.id !== b.id) {
      // Decide FIRST, then report what was actually decided — reporting `prev`
      // as the keeper before the comparison printed the newer row as "older".
      const bIsOlder = String(b.created_at) < String(prev.created_at);
      const keep = bIsOlder ? b : prev;
      const other = bIsOlder ? prev : b;
      if (bIsOlder) phoneToBuyer.set(p, b);
      portalDupes.push({ phone: p, keep, other });
      continue;
    }
    phoneToBuyer.set(p, b);
  }
}
for (const c of existingContacts ?? []) if (c.phone) phoneToBuyer.set(c.phone, (existing ?? []).find((b) => b.id === c.buyer_id));
const nameToBuyer = new Map((existing ?? []).map((b) => [nameKey(b.business_name), b]));

const plan = { update: [], insert: [] };
for (const c of merged) {
  const hit = c.allPhones.map((p) => phoneToBuyer.get(p)).find(Boolean) ?? nameToBuyer.get(nameKey(c.business_name));
  if (hit) plan.update.push({ card: c, buyer: hit, how: c.allPhones.some((p) => phoneToBuyer.has(p)) ? "phone" : "name" });
  else plan.insert.push({ card: c });
}

// ── usernames across EVERY buyer, existing and new ──────────────────────────
const takenStaff = new Set();
const { data: staff } = await admin.from("staff_users").select("email");
for (const s of staff ?? []) takenStaff.add((s.email || "").split("@")[0].toLowerCase());

const identities = [];           // { buyerId|null, name, username, password }
const used = new Set();
function claim(businessName) {
  let base = usernameFor(businessName);
  let u = base, n = 2;
  while (used.has(u) || takenStaff.has(u)) { u = (base.slice(0, MAX_USERNAME - String(n).length) + n); n++; }
  used.add(u);
  return u;
}
// Existing buyers first, oldest first, so the shortest names keep their slot.
for (const b of [...(existing ?? [])].sort((a, b2) => String(a.created_at).localeCompare(String(b2.created_at)))) {
  const u = claim(b.business_name);
  identities.push({ buyerId: b.id, name: b.business_name, username: u, password: generateBuyerPassword(b.owner_name, b.business_name), existing: true });
}
for (const p of plan.insert) {
  const u = claim(p.card.business_name);
  const owner0 = p.card.contacts?.[0] ? [p.card.contacts[0].first_name, p.card.contacts[0].last_name].filter(Boolean).join(" ") : null;
  p.username = u; p.password = generateBuyerPassword(owner0, p.card.business_name);
  identities.push({ buyerId: null, name: p.card.business_name, username: u, password: p.password, existing: false });
}

console.log(`TARGET: ${PROD ? "PRODUCTION" : "dev"} (${url})`);
console.log(`cards read: ${rows.length} · brands after sheet-internal merge: ${merged.length}`);
console.log(`existing buyers: ${(existing ?? []).length}`);
console.log(`  -> update (matched): ${plan.update.length}   [${plan.update.filter((x) => x.how === "phone").length} by phone, ${plan.update.filter((x) => x.how === "name").length} by name]`);
console.log(`  -> insert (new):     ${plan.insert.length}`);
console.log(`images to upload:     ${merged.reduce((s, c) => s + c.images.length, 0)}`);
console.log(`contacts to write:    ${merged.reduce((s, c) => s + c.contacts.length, 0)}`);
console.log(`logins re-issued:     ${identities.length} (every buyer, existing included)`);
console.log("");
console.log("MATCHED (card wins; previous portal value kept in notes):");
for (const u of plan.update) {
  const diff = u.buyer.business_name !== u.card.business_name ? `  name: "${u.buyer.business_name}" -> "${u.card.business_name}"` : "  (name same)";
  console.log(`  ${u.how.padEnd(5)} ${u.card.business_name}${diff}`);
}
if (portalDupes.length) {
  console.log("");
  console.log("PRE-EXISTING DUPLICATE BUYERS (not merged — yours to decide):");
  for (const d of portalDupes) {
    const keep = `${d.keep.business_name} (${String(d.keep.created_at).slice(0, 10)})`;
    const other = `${d.other.business_name} (${String(d.other.created_at).slice(0, 10)})`;
    console.log(`  ${d.phone}  card goes to the older: ${keep}   twin left alone: ${other}`);
  }
}

const dupes = merged.filter((c) => c.mergedFrom);
if (dupes.length) {
  console.log("");
  console.log("SHEET-INTERNAL MERGES (same phone on two rows):");
  for (const d of dupes) console.log(`  ${d.business_name}  <- ${d.mergedFrom.join(", ")}`);
}
console.log("");
console.log("SAMPLE LOGINS:");
for (const i of identities.slice(0, 6)) console.log(`  ${i.name.padEnd(30)} ${i.username.padEnd(22)} ${i.password}`);

fs.mkdirSync("backups", { recursive: true });
const planFile = `backups/visiting-cards-plan-${PROD ? "prod" : "dev"}.json`;
fs.writeFileSync(planFile, JSON.stringify({ plan: { update: plan.update.map((u) => ({ buyer: u.buyer.business_name, card: u.card.business_name, how: u.how })), insert: plan.insert.map((p) => p.card.business_name) }, identities }, null, 1));
console.log(`\nplan written: ${planFile}`);

if (DRY) { console.log("\n--dry-run — nothing written."); process.exit(0); }

if (PROD) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`\nType IMPORT-PROD to write ${plan.insert.length} new buyers and re-issue ${identities.length} logins on PRODUCTION: `);
  rl.close();
  if (a.trim() !== "IMPORT-PROD") { console.error("Confirmation did not match — aborting."); process.exit(1); }
}

// ── apply ───────────────────────────────────────────────────────────────────
let inserted = 0, updated = 0, contactRows = 0, uploaded = 0, credentialed = 0;

async function writeContacts(buyerId, contacts) {
  // bc_buyer_phone_idx is a PARTIAL unique index (where phone is not null).
  // Postgres will not accept a partial index as an ON CONFLICT target unless
  // the predicate is restated, which PostgREST cannot express — so the
  // idempotency is done here, by reading what the buyer already has.
  const { data: already } = await admin.from("buyer_contacts").select("phone").eq("buyer_id", buyerId);
  const seen = new Set((already ?? []).map((r) => r.phone).filter(Boolean));
  for (const [i, c] of contacts.entries()) {
    if (!c.phone && !c.first_name && !c.last_name) continue;
    if (c.phone && seen.has(c.phone)) continue;
    const { error } = await admin.from("buyer_contacts").insert({
      buyer_id: buyerId, first_name: c.first_name, last_name: c.last_name,
      designation: c.designation, phone: c.phone, is_primary: i === 0,
      position: c.position ?? i + 1, source: "visiting_card", created_by: "import",
    });
    if (error) console.error(`  ! contact ${c.phone ?? c.first_name}: ${error.message}`);
    else { contactRows++; if (c.phone) seen.add(c.phone); }
  }
}

async function writeCards(buyerId, files) {
  const paths = [];
  for (const [i, f] of files.entries()) {
    try { paths.push(await uploadCard(buyerId, f, i)); uploaded++; }
    catch (e) { console.error(`  ! card for ${buyerId}: ${e.message}`); }
  }
  if (paths.length) {
    await admin.from("buyers").update({ card_image_path: paths[0], card_image_paths: paths }).eq("id", buyerId);
  }
}

for (const u of plan.update) {
  const c = u.card, b = u.buyer;
  const patch = { import_batch: BATCH };
  const kept = [];
  // The CARD wins; what the portal held is preserved in notes rather than lost.
  for (const [col, val] of [["business_name", c.business_name], ["gstin", c.gstin], ["address", c.address], ["email_alt", c.email_alt], ["category", c.category], ["website", c.website], ["instagram", c.instagram], ["facebook", c.facebook]]) {
    if (!val) continue;
    const prev = b[col];
    if (prev && String(prev).trim() && String(prev).trim() !== val) kept.push(`${col} was "${String(prev).trim()}"`);
    patch[col] = val;
  }
  const owner = c.contacts[0] ? [c.contacts[0].first_name, c.contacts[0].last_name].filter(Boolean).join(" ") : null;
  if (owner && !b.owner_name) patch.owner_name = owner;
  const note = [b.notes, kept.length ? `[${BATCH}] card import — ${kept.join("; ")}` : null].filter(Boolean).join("\n");
  if (note) patch.notes = note;
  const { error } = await admin.from("buyers").update(patch).eq("id", b.id);
  if (error) { console.error(`  ! update ${b.business_name}: ${error.message}`); continue; }
  updated++;
  await writeContacts(b.id, c.contacts);
  await writeCards(b.id, c.images);
}

for (const p of plan.insert) {
  const c = p.card;
  const owner = c.contacts[0] ? [c.contacts[0].first_name, c.contacts[0].last_name].filter(Boolean).join(" ") : null;
  const { data, error } = await admin.from("buyers").insert({
    business_name: c.business_name, owner_name: owner || null,
    // The FIRST AVAILABLE mobile, not contact 1's. Asopan's card names Vijay
    // Pajwani with a truncated landline and Jay Pajwani with a working mobile;
    // keying on contacts[0] left the buyer row with no phone at all while the
    // number sat on the second contact, which made the business unreachable
    // from the buyers list and unmessageable by the bulk credential send.
    phone: c.allPhones[0] ?? null,
    email: `${p.username}@${BUYER_LOGIN_DOMAIN}`,
    gstin: c.gstin, address: c.address, notes: c.notes,
    category: c.category, website: c.website, instagram: c.instagram, facebook: c.facebook,
    email_alt: c.email_alt || c.email || null,
    status: "active", source: "exhibition", import_batch: BATCH,
    // captured_by is a uuid FK to staff_users; an import is not a person, so
    // it stays null and import_batch records where the row came from.
    captured_at: new Date().toISOString(),
  }).select("id").single();
  if (error) { console.error(`  ! insert ${c.business_name}: ${error.message}`); continue; }
  inserted++;
  p.buyerId = data.id;
  await writeContacts(data.id, c.contacts);
  await writeCards(data.id, c.images);
}

// Credentials LAST: a buyer must exist before it gets a login.
for (const p of plan.insert) if (p.buyerId) identities.find((i) => i.username === p.username).buyerId = p.buyerId;
for (const id of identities) {
  // A buyer with no id (its insert failed) or no usable username cannot get a
  // login — GoTrue rejects "@buyers…" outright, and the failure reads as an
  // email-format error miles from the cause.
  if (!id.buyerId || !id.username) continue;
  const email = `${id.username}@${BUYER_LOGIN_DOMAIN}`;
  let authId = null;
  const { data: created, error: cErr } = await admin.auth.admin.createUser({ email, password: id.password, email_confirm: true });
  if (cErr && !/already/i.test(cErr.message)) { console.error(`  ! auth ${id.username}: ${cErr.message}`); continue; }
  authId = created?.user?.id ?? null;
  if (!authId) {
    // Already there — find and update it.
    const { data: page } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const hit = (page?.users ?? []).find((u) => (u.email || "").toLowerCase() === email);
    if (hit) await admin.auth.admin.updateUserById(hit.id, { password: id.password, email_confirm: true });
  }
  const { error: bErr } = await admin.from("buyers")
    .update({ email, encrypted_password: encryptPassword(id.password), status: "active" })
    .eq("id", id.buyerId);
  if (!bErr) credentialed++;
}

console.log("");
console.log(`DONE — inserted ${inserted}, updated ${updated}, contacts ${contactRows}, cards ${uploaded} (${viaSips} via sips), logins ${credentialed}`);
