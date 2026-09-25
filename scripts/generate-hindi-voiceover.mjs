/**
 * Generate the Hindi voiceover for the portal walkthrough via fal.ai.
 *
 *   node scripts/generate-hindi-voiceover.mjs <scenes.json> <outDir>
 *
 * Model: fal-ai/gemini-3.1-flash-tts, voice Charon (calm professional male),
 * language_code "Hindi (India)". It is the only fal TTS endpoint with a
 * style_instructions field, which is how the delivery is asked for in words
 * rather than approximated with a stability slider.
 *
 * WAV, NOT MP3, on purpose: there is no ffprobe on this machine, and a wav
 * header gives the exact duration as arithmetic — data-chunk bytes / 48000 for
 * 24kHz 16-bit mono. Inferring duration from an mp3's size overestimates by
 * most of a second because of encoder padding, and every scene boundary in the
 * video is cut to these numbers.
 *
 * The call is SYNCHRONOUS — POST and the finished audio comes back on the same
 * connection, no queue to poll. Sequential by design: the account concurrency
 * limit is low and a bare fetch has nothing to retry a 429 for you.
 *
 * fal keeps generated files on its CDN for "at least 7 days", so the bytes are
 * written to disk in the same run rather than the URL being stored.
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: ".env.development.local" });
const KEY = process.env.FAL_KEY;
if (!KEY) { console.error("Missing FAL_KEY"); process.exit(1); }

const [scenesFile, outDir] = process.argv.slice(2);
if (!scenesFile || !outDir) { console.error("usage: <scenes.json> <outDir>"); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const ENDPOINT = "https://fal.run/fal-ai/gemini-3.1-flash-tts";
// Byte-identical on every call so the delivery does not drift between scenes.
const STYLE =
  "Speak in warm, natural Indian Hindi, unhurried and friendly, like a shopkeeper " +
  "explaining something helpful to another shopkeeper. Not a newsreader, not an " +
  "advertisement. Read the English words (login, Add to Cart, Submit Order Request, " +
  "WhatsApp, Password, Cart, Catalog) as ordinary spoken words, never letter by letter.";

/** Exact duration from the wav header — no ffprobe needed. */
function wavDuration(buf) {
  let p = 12;
  let sampleRate = 24000, bits = 16, channels = 1;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(p + 10);
      sampleRate = buf.readUInt32LE(p + 12);
      bits = buf.readUInt16LE(p + 22);
    } else if (id === "data") {
      return size / (sampleRate * channels * (bits / 8));
    }
    p += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in wav");
}

const scenes = JSON.parse(fs.readFileSync(scenesFile, "utf8"));
const results = [];
let spentChars = 0;

for (const sc of scenes) {
  const text = sc.voiceoverHindi;
  process.stdout.write(`  scene ${String(sc.n).padStart(2)} (${text.length} chars) … `);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Key ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: text,
      style_instructions: STYLE,
      voice: "Charon",
      language_code: "Hindi (India)",
      output_format: "wav",
      temperature: 0.7,
    }),
  });
  const bodyText = await res.text();
  if (!res.ok) { console.log(`FAILED ${res.status}`); console.error(bodyText.slice(0, 400)); process.exit(1); }
  let body;
  try { body = JSON.parse(bodyText); } catch { console.log("unparseable response"); console.error(bodyText.slice(0, 400)); process.exit(1); }
  const url = body?.audio?.url;
  if (!url) { console.log("no audio.url"); console.error(JSON.stringify(body).slice(0, 400)); process.exit(1); }

  const audio = Buffer.from(await (await fetch(url)).arrayBuffer());
  const file = path.join(outDir, `seg-${String(sc.n).padStart(2, "0")}.wav`);
  fs.writeFileSync(file, audio);
  const dur = wavDuration(audio);
  spentChars += text.length;
  results.push({ n: sc.n, file, duration: dur, chars: text.length, slot: sc.endSec - sc.startSec });
  console.log(`${dur.toFixed(2)}s  (slot was ${(sc.endSec - sc.startSec).toFixed(1)}s)`);
}

fs.writeFileSync(path.join(outDir, "durations.json"), JSON.stringify(results, null, 1));
const total = results.reduce((s, r) => s + r.duration, 0);
console.log(`\n${results.length} segments · speech ${total.toFixed(1)}s · ${spentChars} chars ≈ $${(spentChars / 1000 * 0.05).toFixed(3)}`);
