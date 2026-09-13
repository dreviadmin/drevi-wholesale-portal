// Regenerates the PWA icon set from the brand lockup.
//
// Source of truth: assets/brand/drevi-lockup.png — artboard 1 of the master
// Illustrator file (gold #C4A35A DREVI over letterspaced FASHION on Rich
// Black #1A1A1A), cropped to the ink with a 6% margin. The master is committed
// so the icons are reproducible without the .ai file. It lives OUTSIDE public/
// deliberately: it is a build-time source, and anything under public/ would be
// served to the world and swept into the service worker precache.
//
// The lockup is ~2.7:1, so a square icon is necessarily letterboxed (Ansh's
// call, 13 Sep). Two widths are used:
//   any       84% of the canvas — shown whole on iOS and in browser UI.
//   maskable  66% — Android crops a maskable icon to an arbitrary shape and
//             only guarantees the inner 80% circle. A 2.7:1 element fits that
//             circle up to ~75% width; 66% leaves a comfortable margin.
//
// Run: node scripts/generate-pwa-icons.mjs
import sharp from "sharp";
import { mkdir } from "node:fs/promises";

const BG = "#1A1A1A";
const SRC = "assets/brand/drevi-lockup.png";
const OUT = "public/icons";

/** Letterbox the lockup on a square Rich Black field. */
async function icon(size, widthPct, file, { alpha = true } = {}) {
  const target = Math.round(size * widthPct);
  const lockup = await sharp(SRC)
    .resize({ width: target, kernel: sharp.kernel.lanczos3 })
    .toBuffer({ resolveWithObject: true });

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: alpha ? { r: 26, g: 26, b: 26, alpha: 1 } : BG,
    },
  })
    .composite([
      {
        input: lockup.data,
        left: Math.round((size - lockup.info.width) / 2),
        top: Math.round((size - lockup.info.height) / 2),
      },
    ])
    .png({ compressionLevel: 9 })
    .toFile(`${OUT}/${file}`);
}

await mkdir(OUT, { recursive: true });

const built = [];
for (const [size, pct, name] of [
  [192, 0.84, "icon-192.png"],
  [512, 0.84, "icon-512.png"],
  [192, 0.66, "icon-192-maskable.png"],
  [512, 0.66, "icon-512-maskable.png"],
  [180, 0.84, "apple-touch-icon.png"],
]) {
  const r = await icon(size, pct, name);
  built.push(`${name} ${r.width}x${r.height} ${(r.size / 1024).toFixed(1)}KB`);
}
console.log(built.join("\n"));
