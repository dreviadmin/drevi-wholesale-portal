/**
 * One voice recording per clip, via fal (Gemini TTS, voice Charon), trimmed.
 *
 *   node scripts/walkthrough/tts.mjs <language.json> <outDir>
 *
 * Trimming is the point. Every generation carries ~1-1.5s of silence at the
 * head and tail (the "2.6s overhead" measured on 24 Sep). Left in, a tap
 * scheduled at "0.5s into the clip" lands in dead air before the voice has
 * started. Each wav is cut to its speech span (with 80ms in, 160ms out) so the
 * timeline can place actions against words, and the gap between clips is
 * something the renderer decides rather than something the model left behind.
 *
 * Idempotent: a clip whose text has not changed keeps its wav.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config({ path: ".env.development.local" });
const KEY = process.env.FAL_KEY;
if (!KEY) { console.error("Missing FAL_KEY"); process.exit(1); }
const [langFile, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });

const STYLE =
  "Speak in warm, natural Indian Hindi, unhurried and friendly, like a shopkeeper " +
  "explaining something helpful to another shopkeeper on the phone. Not a newsreader, not an " +
  "advertisement. Read the English words (login, Sign In, Add to Cart, Submit Order Request, " +
  "My Orders, Catalog, Cart, WhatsApp, Password, Forgot Password) as ordinary spoken words, " +
  "never letter by letter.";

function parseWav(buf) {
  let p = 12, sr = 24000, ch = 1, bits = 16, data = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === "fmt ") { ch = buf.readUInt16LE(p + 10); sr = buf.readUInt32LE(p + 12); bits = buf.readUInt16LE(p + 22); }
    else if (id === "data") { data = buf.subarray(p + 8, p + 8 + size); break; }
    p += 8 + size + (size % 2);
  }
  if (!data || bits !== 16 || ch !== 1) throw new Error(`unexpected wav: ${bits}bit ${ch}ch`);
  return { sr, samples: new Int16Array(data.buffer, data.byteOffset, data.length / 2) };
}
function writeWav(samples, sr) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + samples.length * 2, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(samples.length * 2, 40);
  return Buffer.concat([h, Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2)]);
}
/** Speech span by RMS over 20ms windows; threshold relative to the loudest window. */
function trim(samples, sr) {
  const win = Math.round(sr * 0.02);
  const n = Math.floor(samples.length / win);
  const rms = new Float64Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) { let acc = 0; for (let j = 0; j < win; j++) { const v = samples[i * win + j] / 32768; acc += v * v; } rms[i] = Math.sqrt(acc / win); if (rms[i] > peak) peak = rms[i]; }
  const thr = Math.max(0.006, peak * 0.05);
  let a = 0, b = n - 1;
  while (a < n && rms[a] < thr) a++;
  while (b > a && rms[b] < thr) b--;
  const start = Math.max(0, a * win - Math.round(sr * 0.08));
  const end = Math.min(samples.length, (b + 1) * win + Math.round(sr * 0.16));
  return samples.subarray(start, end);
}

const clips = JSON.parse(fs.readFileSync(langFile, "utf8"));
const cacheFile = path.join(outDir, "cache.json");
const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
const out = [];
let spent = 0;
for (const c of clips) {
  const hash = crypto.createHash("sha1").update(c.hindi + "|" + STYLE).digest("hex").slice(0, 12);
  const raw = path.join(outDir, `${c.id}.raw.wav`), trimmed = path.join(outDir, `${c.id}.wav`);
  if (cache[c.id] === hash && fs.existsSync(trimmed)) {
    const { sr, samples } = parseWav(fs.readFileSync(trimmed));
    out.push({ id: c.id, file: trimmed, duration: samples.length / sr, cached: true });
    console.log(`  ${c.id} cached ${(samples.length / sr).toFixed(2)}s`); continue;
  }
  process.stdout.write(`  ${c.id} (${c.hindi.length} ch) … `);
  const res = await fetch("https://fal.run/fal-ai/gemini-3.1-flash-tts", {
    method: "POST", headers: { Authorization: `Key ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: c.hindi, style_instructions: STYLE, voice: "Charon", language_code: "Hindi (India)", output_format: "wav", temperature: 0.7 }),
  });
  const text = await res.text();
  if (!res.ok) { console.log(`FAILED ${res.status} ${text.slice(0, 160)}`); process.exit(1); }
  const url = JSON.parse(text)?.audio?.url; if (!url) { console.log("no audio url"); process.exit(1); }
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  fs.writeFileSync(raw, buf);
  const { sr, samples } = parseWav(buf);
  const t = trim(samples, sr);
  fs.writeFileSync(trimmed, writeWav(t, sr));
  cache[c.id] = hash; spent += c.hindi.length;
  out.push({ id: c.id, file: trimmed, duration: t.length / sr, rawDuration: samples.length / sr });
  console.log(`${(samples.length / sr).toFixed(2)}s raw -> ${(t.length / sr).toFixed(2)}s speech`);
}
fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
fs.writeFileSync(path.join(outDir, "durations.json"), JSON.stringify(out, null, 1));
const total = out.reduce((s, o) => s + o.duration, 0);
console.log(`\n${out.length} clips · speech ${total.toFixed(1)}s · ${spent} chars ≈ $${(spent / 1000 * 0.05).toFixed(3)}`);
