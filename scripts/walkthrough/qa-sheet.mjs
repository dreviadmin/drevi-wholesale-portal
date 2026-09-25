/**
 * One frame at every tap, tiled — the check that catches what the timeline
 * numbers cannot: is the finger on the button, is the right screen showing,
 * is anything visible that should not be.
 *
 *   node scripts/walkthrough/qa-sheet.mjs <video.mp4> <out.jpg>
 * Reads <video>.timeline.json written by render.mjs. Also samples the two
 * scroll clips and the last frame.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import ffmpeg from "ffmpeg-static";

const [video, out] = process.argv.slice(2);
const tl = JSON.parse(fs.readFileSync(video.replace(/\.mp4$/, ".timeline.json"), "utf8"));
const times = tl.ripples.map((r, i) => ({ label: `tap ${i}`, t: r.t + 0.06 }));
for (const c of tl.captions) if (/^(Every design|Fabric)/.test(c.text)) times.push({ label: "scroll", t: (c.t0 + c.t1) / 2 });
times.push({ label: "end", t: tl.total - 0.5 });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qa-"));
const W = 220, H = 391, COLS = 8, rows = Math.ceil(times.length / COLS), tiles = [];
for (const [i, x] of times.entries()) {
  const f = path.join(tmp, `${i}.png`);
  execFileSync(ffmpeg, ["-y", "-ss", x.t.toFixed(3), "-i", video, "-frames:v", "1", f], { stdio: "ignore" });
  const label = Buffer.from(`<svg width="${W}" height="22"><rect width="${W}" height="22" fill="#000" opacity="0.65"/><text x="5" y="16" font-family="Helvetica" font-size="13" fill="#fff">${x.label}</text></svg>`);
  tiles.push({ input: await sharp(await sharp(f).resize(W, H).toBuffer()).composite([{ input: label, left: 0, top: 0 }]).toBuffer(), left: (i % COLS) * W, top: Math.floor(i / COLS) * H });
}
await sharp({ create: { width: W * COLS, height: H * rows, channels: 3, background: "#222" } }).composite(tiles).jpeg({ quality: 84 }).toFile(out);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${path.basename(video)}: ${tl.total.toFixed(1)}s, ${tl.ripples.length} taps -> ${out}`);
