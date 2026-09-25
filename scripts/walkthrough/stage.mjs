/**
 * Copy a rendered walkthrough into the delivery folder with its SRTs and a
 * transcript, all at the timings the render actually used.
 *   node scripts/walkthrough/stage.mjs <video.mp4> <language.json> <audioDir> <outDir> <name>
 */
import fs from "node:fs"; import path from "node:path";
const [video, langFile, audioDir, outDir, name] = process.argv.slice(2);
const tl = JSON.parse(fs.readFileSync(video.replace(/\.mp4$/, ".timeline.json"), "utf8"));
const lang = JSON.parse(fs.readFileSync(langFile, "utf8"));
const dur = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(audioDir, "durations.json"), "utf8")).map((d) => [d.id, d.duration]));
const ts = (t, sep = ",") => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), ms = Math.round((t - Math.floor(t)) * 1000); return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(ms).padStart(3, "0")}`; };
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(video, path.join(outDir, `${name}.mp4`));
const caps = tl.captions;
fs.writeFileSync(path.join(outDir, `${name}.captions-english.srt`), caps.map((c, i) => `${i + 1}\n${ts(c.t0)} --> ${ts(c.t1)}\n${c.text}\n`).join("\n"));
const rows = []; const voice = [];
caps.forEach((c, i) => { const l = lang[i]; const t0 = c.t0 + (i === 0 ? 0.6 : 0.45); const text = l.text ?? l.hindi; voice.push(`${i + 1}\n${ts(t0)} --> ${ts(t0 + dur[l.id])}\n${text}\n`); rows.push(`| ${l.id} | ${ts(t0, ".").slice(3, 8)} | ${c.text} | ${text} |`); });
fs.writeFileSync(path.join(outDir, `${name}.voice.srt`), voice.join("\n"));
fs.writeFileSync(path.join(outDir, `${name}.transcript.md`), `# ${name}\n\n\`${name}.mp4\` — 720x1280, 30 fps, ${tl.total.toFixed(0)}s, H.264 + AAC. English captions burned in.\n\n| # | starts | caption | spoken |\n|---|---|---|---|\n${rows.join("\n")}\n`);
console.log(`${name}: ${tl.total.toFixed(1)}s -> ${outDir}`);
