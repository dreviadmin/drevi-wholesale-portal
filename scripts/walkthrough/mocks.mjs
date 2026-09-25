/**
 * The two screens that are not the portal: the WhatsApp message the buyer
 * starts from, and the closing card. Drawn at the same 1170x2532 as the
 * captures so the renderer treats them as any other state. The link on the
 * WhatsApp screen is a measured target like a real button.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
const dir = process.argv[2];
const W = 1170, H = 2532;
const SANS = "-apple-system, Helvetica Neue, Helvetica, Arial, sans-serif";
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

// WhatsApp — mirrors src/lib/share.ts buildWhatsAppMessage, password masked.
const lines = [["Welcome to Drevi Wholesale Portal", "b"], ["", ""], ["Link: drevi-wholesale-portal-swart.vercel.app", "link"], ["Username: royal", ""], ["Password: ••••••••", ""], ["", ""], ["Save this message. Tap the link anytime to", ""], ["browse our full catalog with wholesale pricing.", ""], ["", ""], ["- Rakesh", ""], ["+91 88280 43555", ""]];
let y = 420; const rows = []; let linkBox = null;
for (const [txt, kind] of lines) {
  if (txt) {
    if (kind === "link") linkBox = { x: 130, y: y - 44, w: 930, h: 60 };
    rows.push(`<text x="130" y="${y}" font-family="${SANS}" font-size="46" font-weight="${kind === "b" ? 700 : 400}" fill="${kind === "link" ? "#1B7FD4" : "#111B21"}"${kind === "link" ? ' text-decoration="underline"' : ""}>${txt.replace(/&/g, "&amp;")}</text>`);
  }
  y += txt ? 72 : 34;
}
const bh = y - 420 + 120;
const wa = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#EFE7DE"/><rect width="${W}" height="240" fill="#075E54"/>
<circle cx="150" cy="140" r="52" fill="#fff" opacity="0.9"/><text x="150" y="158" font-family="Georgia, serif" font-size="46" fill="#075E54" text-anchor="middle">D</text>
<text x="240" y="126" font-family="${SANS}" font-size="48" font-weight="600" fill="#fff">Drevi Fashion</text><text x="240" y="186" font-family="${SANS}" font-size="36" fill="#CFE9E3">business account</text>
<rect x="70" y="330" width="1000" height="${bh}" rx="28" fill="#fff"/>${rows.join("")}
<text x="1010" y="${330 + bh - 36}" font-family="${SANS}" font-size="34" fill="#8696A0" text-anchor="end">10:42 am</text></svg>`;
await sharp(Buffer.from(wa)).png().toFile(path.join(dir, "whatsapp.png"));
manifest.whatsapp = { file: "whatsapp.png", width: W, height: H, viewportH: H, header: { sticky: false, height: 0 }, targets: { "wa.link": linkBox } };

// Outro
const outro = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#F5F1E8"/>
<text x="${W / 2}" y="1060" text-anchor="middle" font-family="Didot, Georgia, serif" font-size="120" letter-spacing="40" fill="#1A1A1A">DREVI</text>
<text x="${W / 2}" y="1150" text-anchor="middle" font-family="Didot, Georgia, serif" font-size="40" letter-spacing="14" fill="#B08D3F">WHOLESALE PORTAL</text>
<line x1="${W / 2 - 90}" y1="1230" x2="${W / 2 + 90}" y2="1230" stroke="#B08D3F" stroke-width="4"/>
<text x="${W / 2}" y="1360" text-anchor="middle" font-family="${SANS}" font-size="50" fill="#1A1A1A">Questions? Reply on WhatsApp</text>
<text x="${W / 2}" y="1450" text-anchor="middle" font-family="${SANS}" font-size="44" fill="#6B6355">Rakesh · +91 88280 43555</text></svg>`;
await sharp(Buffer.from(outro)).png().toFile(path.join(dir, "outro.png"));
manifest.outro = { file: "outro.png", width: W, height: H, viewportH: H, header: { sticky: false, height: 0 }, targets: {} };
fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
console.log("mocks written: whatsapp (wa.link", JSON.stringify(linkBox) + "), outro");
