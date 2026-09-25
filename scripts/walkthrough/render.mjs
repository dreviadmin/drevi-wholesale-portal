/**
 * Render the walkthrough: real screen states, a finger that travels to and
 * taps the real buttons, scrolling paced to the voice, English captions.
 *
 *   node scripts/walkthrough/render.mjs <skeleton.json> <language.json> <statesDir> <audioDir> <out.mp4>
 *
 * THE TIMELINE IS BUILT FROM THE AUDIO. Each clip's trimmed voice duration is
 * measured; the clip occupies exactly that span plus a fixed gap. Every action
 * is scheduled relative to its clip, so "tap at 0.5s" means half a second into
 * the spoken line, not into some assumed slot. The picture is cut to the words
 * because the words cannot be cut to the picture (the TTS has no pace control).
 *
 * Frames are composed with sharp and streamed raw into ffmpeg; nothing touches
 * disk per frame.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";

const [skelFile, langFile, statesDir, audioDir, outFile] = process.argv.slice(2);
if (!outFile) { console.error("usage: <skeleton.json> <language.json> <statesDir> <audioDir> <out.mp4>"); process.exit(1); }

const W = 720, H = 1280, FPS = 30;
const CREAM = "#F5F1E8", INK = "#1A1A1A", GOLD = "#B08D3F", MUTED = "#6B6355";
const PH_W = 496, PH_H = 952, PAD = 12, PH_X = (W - PH_W) / 2, PH_Y = 88;
const IN_X = PH_X + PAD, IN_Y = PH_Y + PAD, IN_W = PH_W - PAD * 2, IN_H = PH_H - PAD * 2;
const CAP_Y = PH_Y + PH_H + 62;
const LEAD = 0.6, GAP = 0.45, SCENE_GAP = 0.9, TAIL = 1.4;
const TRAVEL = 0.55, RIPPLE = 0.42, SETTLE = 0.12, AUTOSCROLL = 0.5;

const skel = JSON.parse(fs.readFileSync(skelFile, "utf8"));
const lang = Object.fromEntries(JSON.parse(fs.readFileSync(langFile, "utf8")).map((c) => [c.id, c]));
const manifest = JSON.parse(fs.readFileSync(path.join(statesDir, "manifest.json"), "utf8"));
const durations = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(audioDir, "durations.json"), "utf8")).map((d) => [d.id, d.duration]));

const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const group = (state) => state.split("-")[0];
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── states: prescale each once, keep raw pixels ────────────────────────────
const S = IN_W / 1170; // every capture is 390css x 3dpr wide
const VIEW_H = Math.round(IN_H / S); // image px visible in the plate
const states = {};
for (const [name, m] of Object.entries(manifest)) {
  const file = path.join(statesDir, m.file);
  const { data, info } = await sharp(file).resize({ width: IN_W }).raw().toBuffer({ resolveWithObject: true });
  const stickyH = m.header?.sticky ? Math.round(m.header.height * S) : 0;
  const header = stickyH > 0 ? await sharp(data, { raw: info }).extract({ left: 0, top: 0, width: IN_W, height: stickyH }).png().toBuffer() : null;
  states[name] = { raw: data, info, width: m.width, height: m.height, maxScroll: Math.max(0, m.height - VIEW_H), stickyH, header, targets: m.targets ?? {} };
}
console.log(`${Object.keys(states).length} states loaded; plate shows ${Math.round(VIEW_H / 3)} css px of the viewport`);

function targetOf(state, name) {
  const t = states[state]?.targets?.[name];
  if (!t) throw new Error(`target ${name} not measured in state ${state}`);
  return t;
}

// ── timeline ───────────────────────────────────────────────────────────────
// Events are absolute-time keyframes the frame loop reads back.
const stateSwitches = [];   // {t, state}
const scrollKeys = [];      // {t0, t1, from, to}   (image px)
const cursorMoves = [];     // {t0, t1, from:{x,y}, to:{x,y}} screen coords (plate px)
const ripples = [];         // {t, x, y}
const captions = [];        // {t0, t1, text, idx}
let cursor = { x: IN_W * 0.5, y: IN_H * 0.62, visible: false };
let curState = null, curScroll = 0, t = LEAD;

function switchState(at, next) {
  if (next === curState) return;
  const reset = !curState || group(next) !== group(curState);
  if (reset) { scrollKeys.push({ t0: at, t1: at, from: 0, to: 0 }); curScroll = 0; }
  else { curScroll = clamp(curScroll, 0, states[next].maxScroll); scrollKeys.push({ t0: at, t1: at, from: curScroll, to: curScroll }); }
  stateSwitches.push({ t: at, state: next });
  curState = next;
}
function scrollTo(t0, t1, toImg) {
  const to = clamp(toImg, 0, states[curState].maxScroll);
  scrollKeys.push({ t0, t1, from: curScroll, to });
  curScroll = to;
}
/** Ensure the target is comfortably inside the plate before `by`; returns the scroll it will be at. */
function reveal(target, by) {
  const cy = target.y + target.h / 2;
  const lo = curScroll + VIEW_H * 0.18, hi = curScroll + VIEW_H * 0.82;
  if (cy >= lo && cy <= hi) return;
  const want = clamp(cy - VIEW_H * 0.55, 0, states[curState].maxScroll);
  scrollTo(by - AUTOSCROLL, by, want);
}
function screenOf(target) {
  return { x: (target.x + target.w / 2) * S, y: (target.y + target.h / 2 - curScroll) * S };
}
function moveCursor(t0, t1, to) {
  cursorMoves.push({ t0, t1, from: { ...cursor }, to });
  cursor = { ...to, visible: true };
}
function tap(at, targetName, then) {
  const target = targetOf(curState, targetName);
  reveal(target, at - TRAVEL - 0.1);
  const dst = screenOf(target);
  moveCursor(Math.max(at - TRAVEL, t - 0.01), at, dst);
  ripples.push({ t: at, x: dst.x, y: dst.y });
  if (then) switchState(at + SETTLE, then);
}

const clips = skel.clips;
let lastScene = null;
for (const [i, c] of clips.entries()) {
  const D = durations[c.id];
  if (D == null) throw new Error(`no audio duration for ${c.id}`);
  if (lastScene && c.scene !== lastScene) t += SCENE_GAP - GAP;
  lastScene = c.scene;
  const t0 = t;
  switchState(t0 - 0.05, c.state);
  captions.push({ t0: t0 - (i === 0 ? LEAD : GAP), t1: t0 + D + GAP, text: lang[c.id].caption, idx: i });
  for (const a of c.actions ?? []) {
    if (a.type === "tap") tap(t0 + a.at, a.target, a.then);
    else if (a.type === "point") { const tg = targetOf(curState, a.target); reveal(tg, t0 + (a.at ?? 0.3)); moveCursor(t0 + (a.at ?? 0.3), t0 + (a.at ?? 0.3) + 0.7, screenOf(tg)); }
    else if (a.type === "scroll") {
      const [f0, f1] = a.over;
      let to = a.to != null ? a.to * 3 : null;
      if (a.toTarget) { const tg = targetOf(curState, a.toTarget); to = tg.y + tg.h / 2 - VIEW_H * 0.5; }
      // A finger left hovering over the header while the page scrolls under it
      // reads as a mistake; ease it aside to a resting spot as the scroll starts.
      if (cursor.visible) moveCursor(t0 + D * f0 - 0.5, t0 + D * f0, { x: IN_W * 0.88, y: IN_H * 0.58 });
      scrollTo(t0 + D * f0, t0 + D * f1, to);
    } else if (a.type === "typing") {
      const [f0, f1] = a.over;
      const tg = targetOf(curState, a.target);
      reveal(tg, t0 + D * f0 - TRAVEL);
      const dst = screenOf(tg);
      moveCursor(t0 + D * f0 - TRAVEL, t0 + D * f0, dst);
      ripples.push({ t: t0 + D * f0, x: dst.x, y: dst.y });
      const n = a.states.length, span = D * (f1 - f0);
      a.states.forEach((s, k) => switchState(t0 + D * f0 + SETTLE + (span * (k + 1)) / (n + 0.6), s));
    }
  }
  t = t0 + D + GAP;
}
// Actions inside one clip are scheduled in the order written, not the order
// they happen — a typing sweep can finish after a tap that follows it. The
// frame loop walks each list with a forward index, so they must be sorted.
for (const list of [stateSwitches, scrollKeys, cursorMoves, ripples]) list.sort((a, b) => (a.t ?? a.t0) - (b.t ?? b.t0));
const TOTAL = t - GAP + TAIL;
console.log(`timeline: ${clips.length} clips, ${TOTAL.toFixed(1)}s, ${ripples.length} taps, ${stateSwitches.length} state switches`);

// ── audio track: clips placed at their timeline start ──────────────────────
const SR = 24000;
const track = new Int16Array(Math.ceil(TOTAL * SR));
{
  let tt = LEAD, last = null;
  for (const c of clips) {
    if (last && c.scene !== last) tt += SCENE_GAP - GAP;
    last = c.scene;
    const buf = fs.readFileSync(path.join(audioDir, `${c.id}.wav`));
    let p = 12, data = null;
    while (p + 8 <= buf.length) { const id = buf.toString("ascii", p, p + 4), sz = buf.readUInt32LE(p + 4); if (id === "data") { data = buf.subarray(p + 8, p + 8 + sz); break; } p += 8 + sz + (sz % 2); }
    const s = new Int16Array(data.buffer, data.byteOffset, data.length / 2);
    track.set(s.subarray(0, Math.min(s.length, track.length - Math.round(tt * SR))), Math.round(tt * SR));
    tt += durations[c.id] + GAP;
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + track.length * 2, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(track.length * 2, 40);
  fs.writeFileSync(outFile.replace(/\.mp4$/, ".voice.wav"), Buffer.concat([h, Buffer.from(track.buffer)]));
}

// ── static layers ──────────────────────────────────────────────────────────
function wrap(text, max) { const out = []; let cur = ""; for (const w of text.split(/\s+/)) { if (cur && (cur + " " + w).length > max) { out.push(cur); cur = w; } else cur = cur ? cur + " " + w : w; } if (cur) out.push(cur); return out; }
const baseCache = new Map();
async function baseFor(caption) {
  if (baseCache.has(caption)) return baseCache.get(caption);
  const lines = wrap(caption, 30);
  const fs1 = lines.length > 1 ? 34 : 38;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${CREAM}"/>
  <text x="${W / 2}" y="46" text-anchor="middle" font-family="Didot, Georgia, serif" font-size="24" letter-spacing="9" fill="${INK}">DREVI</text>
  <text x="${W / 2}" y="72" text-anchor="middle" font-family="Didot, Georgia, serif" font-size="12" letter-spacing="4" fill="${GOLD}">WHOLESALE</text>
  ${lines.map((l, i) => `<text x="${W / 2}" y="${CAP_Y + i * (fs1 + 10)}" text-anchor="middle" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="${fs1}" font-weight="500" fill="${INK}">${esc(l)}</text>`).join("")}
  <rect x="60" y="${H - 54}" width="${W - 120}" height="3" fill="#DED6C6"/>
  <rect x="${PH_X - 5}" y="${PH_Y - 5}" width="${PH_W + 10}" height="${PH_H + 10}" rx="42" fill="${INK}"/>
  <rect x="${IN_X}" y="${IN_Y}" width="${IN_W}" height="${IN_H}" fill="#ffffff"/>
</svg>`;
  const raw = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
  baseCache.set(caption, raw);
  return raw;
}
const fingerPng = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60">
  <circle cx="30" cy="30" r="21" fill="${GOLD}" fill-opacity="0.42" stroke="#ffffff" stroke-opacity="0.9" stroke-width="2.5"/>
  <circle cx="30" cy="30" r="5" fill="#ffffff"/></svg>`)).png().toBuffer();
const rippleCache = [];
for (let k = 0; k < 12; k++) {
  const p = k / 11, r = 20 + 30 * p, op = 0.75 * (1 - p);
  rippleCache.push(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="${r}" fill="none" stroke="${GOLD}" stroke-opacity="${op.toFixed(2)}" stroke-width="4"/></svg>`)).png().toBuffer());
}
const gold = await sharp({ create: { width: W - 120, height: 3, channels: 3, background: GOLD } }).png().toBuffer();

// ── frame loop ─────────────────────────────────────────────────────────────
const ff = spawn(ffmpegPath, ["-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-",
  "-i", outFile.replace(/\.mp4$/, ".voice.wav"), "-c:v", "libx264", "-preset", "slow", "-crf", "22", "-pix_fmt", "yuv420p", "-profile:v", "main",
  "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-shortest", "-movflags", "+faststart", outFile], { stdio: ["pipe", "ignore", "pipe"] });
let ffErr = ""; ff.stderr.on("data", (d) => { ffErr += d; if (ffErr.length > 8000) ffErr = ffErr.slice(-4000); });
const write = (buf) => new Promise((res) => (ff.stdin.write(buf) ? res() : ff.stdin.once("drain", res)));

const frames = Math.round(TOTAL * FPS);
let sIdx = 0, kIdx = 0, cIdx = 0;
for (let f = 0; f < frames; f++) {
  const tt = f / FPS;
  while (sIdx + 1 < stateSwitches.length && stateSwitches[sIdx + 1].t <= tt) sIdx++;
  const st = states[stateSwitches[sIdx].state];
  // scroll: the latest key whose span has started
  let scroll = 0;
  for (const k of scrollKeys) { if (k.t0 > tt) break; scroll = k.t1 <= tt ? k.to : k.from + (k.to - k.from) * ease((tt - k.t0) / Math.max(1e-6, k.t1 - k.t0)); }
  scroll = clamp(scroll, 0, st.maxScroll);
  // cursor
  let cx = null, cy = null;
  for (const m of cursorMoves) { if (m.t0 > tt) break; const p = m.t1 <= tt ? 1 : ease((tt - m.t0) / Math.max(1e-6, m.t1 - m.t0)); cx = m.from.x + (m.to.x - m.from.x) * p; cy = m.from.y + (m.to.y - m.from.y) * p; }
  while (cIdx + 1 < captions.length && captions[cIdx + 1].t0 <= tt) cIdx++;
  const cap = captions[cIdx];

  const base = await baseFor(cap.text);
  const top = Math.round(scroll * S);
  const plate = await sharp(st.raw, { raw: st.info }).extract({ left: 0, top: Math.min(top, st.info.height - IN_H), width: IN_W, height: IN_H }).png().toBuffer();
  const layers = [{ input: plate, left: IN_X, top: IN_Y }];
  if (st.header && top > 2) layers.push({ input: st.header, left: IN_X, top: IN_Y });
  for (const r of ripples) { const d = tt - r.t; if (d >= 0 && d < RIPPLE) layers.push({ input: rippleCache[Math.min(11, Math.floor((d / RIPPLE) * 12))], left: Math.round(IN_X + r.x - 60), top: Math.round(IN_Y + r.y - 60) }); }
  if (cx != null && st.targets && Object.keys(st.targets).length) layers.push({ input: fingerPng, left: Math.round(IN_X + cx - 30), top: Math.round(IN_Y + cy - 30) });
  layers.push({ input: await sharp(gold).extract({ left: 0, top: 0, width: Math.max(1, Math.round((W - 120) * (tt / TOTAL))), height: 3 }).png().toBuffer(), left: 60, top: H - 54 });

  const frame = await sharp(base.data, { raw: base.info }).composite(layers).removeAlpha().raw().toBuffer();
  await write(frame);
  if (f % 300 === 0) process.stdout.write(`  ${Math.round((f / frames) * 100)}%\r`);
}
ff.stdin.end();
await new Promise((res, rej) => ff.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg ${code}: ${ffErr.slice(-800)}`)))));
fs.writeFileSync(outFile.replace(/\.mp4$/, ".timeline.json"), JSON.stringify({ total: TOTAL, captions, ripples, stateSwitches }, null, 1));
console.log(`\n${outFile}  ${(fs.statSync(outFile).size / 1048576).toFixed(2)} MB  ${TOTAL.toFixed(1)}s  ${W}x${H}@${FPS}`);
