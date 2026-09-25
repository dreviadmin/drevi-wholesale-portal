/**
 * Render the Hindi portal-walkthrough video from a scene script + captured frames.
 *
 *   node scripts/build-walkthrough-video.mjs <scenes.json> <framesDir> <out.mp4>
 *
 * scenes.json is an array of:
 *   { n, startSec, endSec, frame, onScreenHindi, voiceoverHindi, ... }
 * where `frame` is a filename in framesDir.
 *
 * Output is 1280x720, H.264 yuv420p, NO AUDIO — the Hindi voiceover is generated
 * separately from the transcript and laid over this, so the picture has to hold
 * its own timing exactly. Every scene's duration is taken verbatim from the
 * script, and the phone screenshot pans slowly inside its frame so a long scene
 * does not read as a frozen slide.
 *
 * Captions are drawn as SVG through sharp/librsvg rather than ffmpeg drawtext:
 * Devanagari needs real shaping for conjuncts and matras, and drawtext renders
 * it as broken standalone glyphs.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import ffmpeg from "ffmpeg-static";

const [scenesFile, framesDir, outFile] = process.argv.slice(2);
if (!scenesFile || !framesDir || !outFile) {
  console.error("usage: node scripts/build-walkthrough-video.mjs <scenes.json> <framesDir> <out.mp4>");
  process.exit(1);
}

// PORTRAIT, deliberately. This is a phone screen being explained to someone
// watching on a phone: a 1280x720 landscape frame shrinks a 390pt-wide screen
// to about a quarter scale and the UI text becomes unreadable, which defeats
// the point of a walkthrough. Portrait lets the phone plate be 480px wide, so
// 16pt UI text lands near 19px on the canvas — legible in a WhatsApp preview.
const W = 720, H = 1280, FPS = 25;
const CREAM = "#F5F1E8", INK = "#1A1A1A", GOLD = "#B08D3F", MUTED = "#6B6355";
const DEVA = "Kohinoor Devanagari, Devanagari Sangam MN, Noto Sans Devanagari, sans-serif";
const SERIF = "Didot, Playfair Display, Georgia, serif";

// Phone plate
const PH_W = 496, PH_H = 952, PH_X = (W - PH_W) / 2, PH_Y = 88, PAD = 12;
// Caption sits between the phone and the progress rule; two lines at 46px plus
// leading must clear H-54, or the second line collides with the bar.
const CAP_Y = PH_Y + PH_H + 66;

const scenes = JSON.parse(fs.readFileSync(scenesFile, "utf8"));
const TMP = fs.mkdtempSync("/tmp/wt-");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Wrap a Devanagari caption by words. Devanagari has no reliable per-character
// width, so this is measured in rough em units and kept deliberately short —
// the script caps captions at ~8 words for exactly this reason.
function wrap(text, maxChars) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > maxChars) { lines.push(cur); cur = w; }
    else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

async function phonePlate(framePath, progress) {
  // Slow vertical pan: long pages reveal themselves instead of sitting still.
  const src = sharp(framePath);
  const meta = await src.metadata();
  const innerW = PH_W - PAD * 2, innerH = PH_H - PAD * 2;
  const scaled = await src.resize({ width: innerW }).toBuffer();
  const sMeta = await sharp(scaled).metadata();
  const travel = Math.max(0, sMeta.height - innerH);
  const top = Math.round(travel * Math.min(1, Math.max(0, progress)));
  return sharp(scaled).extract({ left: 0, top, width: innerW, height: Math.min(innerH, sMeta.height) }).toBuffer();
}

function chrome(caption, idx, total, elapsed, totalSec) {
  const lines = wrap(caption, 26);
  const fs1 = lines.length > 2 ? 40 : 46;
  const bar = Math.min(1, elapsed / totalSec);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${CREAM}"/>
  <text x="${W / 2}" y="46" text-anchor="middle" font-family="${SERIF}" font-size="24" letter-spacing="9" fill="${INK}">DREVI</text>
  <text x="${W / 2}" y="72" text-anchor="middle" font-family="${SERIF}" font-size="12" letter-spacing="4" fill="${GOLD}">WHOLESALE</text>
  ${lines.map((l, i) => `<text x="${W / 2}" y="${CAP_Y + i * (fs1 + 12)}" text-anchor="middle" font-family="${DEVA}" font-size="${fs1}" fill="${INK}">${esc(l)}</text>`).join("\n  ")}
  <rect x="60" y="${H - 54}" width="${W - 120}" height="3" fill="#DED6C6"/>
  <rect x="60" y="${H - 54}" width="${Math.round((W - 120) * bar)}" height="3" fill="${GOLD}"/>
  <text x="${W - 60}" y="${H - 72}" text-anchor="end" font-family="${DEVA}" font-size="20" fill="${MUTED}">${idx} / ${total}</text>
  <rect x="${PH_X - 5}" y="${PH_Y - 5}" width="${PH_W + 10}" height="${PH_H + 10}" rx="42" fill="${INK}"/>
  <rect x="${PH_X + PAD}" y="${PH_Y + PAD}" width="${PH_W - PAD * 2}" height="${PH_H - PAD * 2}" fill="#ffffff"/>
</svg>`);
}

let frameNo = 0;
const totalSec = scenes[scenes.length - 1].endSec;
console.log(`rendering ${scenes.length} scenes, ${totalSec}s @ ${FPS}fps`);

for (const [i, sc] of scenes.entries()) {
  const dur = sc.endSec - sc.startSec;
  const count = Math.max(1, Math.round(dur * FPS));
  const framePath = path.join(framesDir, sc.frame);
  if (!fs.existsSync(framePath)) { console.error(`  ! missing frame ${sc.frame} for scene ${sc.n}`); process.exit(1); }
  for (let f = 0; f < count; f++) {
    const p = count === 1 ? 0 : f / (count - 1);
    // Hold the top for the first third, then pan — a pan that starts instantly
    // reads as drift rather than as scrolling.
    const panP = Math.max(0, (p - 0.33) / 0.67);
    const plate = await phonePlate(framePath, panP);
    const elapsed = sc.startSec + dur * p;
    const canvas = sharp(chrome(sc.onScreenHindi, i + 1, scenes.length, elapsed, totalSec));
    const out = path.join(TMP, `f${String(frameNo++).padStart(5, "0")}.png`);
    await canvas.composite([{ input: plate, left: PH_X + PAD, top: PH_Y + PAD }]).png({ compressionLevel: 6 }).toFile(out);
  }
  console.log(`  scene ${sc.n}: ${dur}s (${count} frames) <- ${sc.frame}`);
}

console.log(`encoding ${frameNo} frames...`);
execFileSync(ffmpeg, [
  "-y", "-framerate", String(FPS), "-i", path.join(TMP, "f%05d.png"),
  "-c:v", "libx264", "-profile:v", "main", "-pix_fmt", "yuv420p",
  "-preset", "slow", "-crf", "23", "-movflags", "+faststart", "-an",
  outFile,
], { stdio: ["ignore", "ignore", "pipe"] });

fs.rmSync(TMP, { recursive: true, force: true });
const mb = (fs.statSync(outFile).size / 1048576).toFixed(2);
console.log(`\n${outFile}  ${mb} MB  ${totalSec}s  ${W}x${H}  H.264 no-audio`);
