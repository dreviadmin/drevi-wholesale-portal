/**
 * Send ONE AiSensy campaign message. A probe, not the bulk sender.
 *
 *   node scripts/aisensy-send.mjs --to +918169992981 --name ansh \
 *        --campaign "Wholesale Launch test" \
 *        --media <url> --filename x.mp4 \
 *        --param "Drevi Fashion" --param "https://..." --param login --param pass
 *
 * Verified against AiSensy's Campaign API reference (wiki.aisensy.com 11501889):
 *   POST https://backend.aisensy.com/campaign/t1/api/v2
 *   apiKey goes in the BODY, not an Authorization header.
 *   campaignName addresses a dashboard API Campaign that must be status "Live";
 *   there is no per-call template name.
 *   destination is ONE string with a leading + and the country code.
 *   userName is REQUIRED.
 *   media is {url, filename}; the URL must be publicly fetchable.
 *   templateParams length must equal the campaign template's param count.
 *
 * It prints the FULL response body. AiSensy documents success only as "a status
 * of 200" and publishes no success or error schema for this endpoint, so the
 * body is the only thing that distinguishes accepted from rejected — treating
 * res.ok as "sent" is exactly the bug being avoided here.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("dotenv").config({ path: process.argv.includes("--dev") ? ".env.development.local" : ".env.local" });

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const many = (n) => argv.reduce((a, v, i) => (v === `--${n}` ? [...a, argv[i + 1]] : a), []);

const apiKey = process.env.AISENSY_API_KEY;
if (!apiKey) { console.error("Missing AISENSY_API_KEY"); process.exit(1); }

const to = flag("to");
const userName = flag("name");
const campaignName = flag("campaign");
if (!to || !userName || !campaignName) { console.error("--to, --name and --campaign are all required"); process.exit(1); }

// AiSensy resolves an unrecognisable destination to India by DEFAULT rather
// than erroring, so a malformed number does not fail — it delivers somewhere
// else. Refuse anything that is not already strict E.164.
if (!/^\+[1-9]\d{7,14}$/.test(to)) { console.error(`destination "${to}" is not strict E.164 (+<cc><number>) — refusing`); process.exit(1); }

const media = flag("media");
const body = {
  apiKey,
  campaignName,
  destination: to,
  userName,
  source: "drevi-wholesale-portal",
  ...(media ? { media: { url: media, filename: flag("filename", "video.mp4") } } : {}),
  ...(many("param").length ? { templateParams: many("param") } : {}),
};

const shown = { ...body, apiKey: `${apiKey.slice(0, 12)}…(${apiKey.length} chars)` };
console.log("POST https://backend.aisensy.com/campaign/t1/api/v2");
console.log(JSON.stringify(shown, null, 2));

const res = await fetch("https://backend.aisensy.com/campaign/t1/api/v2", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(20000),
});
const text = await res.text();
console.log(`\nHTTP ${res.status} ${res.statusText}`);
console.log("response body:");
console.log(text || "(empty)");
