/**
 * Capture clean phone-sized frames of the buyer journey, for the explainer video.
 *
 *   node scripts/capture-walkthrough.mjs <outDir>
 *
 * Read-only: it logs in as the QA buyer, walks the catalogue and fills a cart,
 * but never submits an order. The confirmation frame is taken from the order
 * that already exists, so re-running this does not litter production with
 * orders.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const OUT = process.argv[2] ?? "/tmp/frames";
const BASE = "https://drevi-wholesale-portal-swart.vercel.app";
const USER = "zzqatest";
const PASS = "zzqatestxdrevi";
const ORDER_ID = "b005bbc4-534b-468f-aae7-ca46adb23699";

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,           // crisp enough to sit inside a 1080p frame
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
let n = 0;
const shot = async (name, opts = {}) => {
  // Product imagery streams in from Supabase; a frame captured mid-load is the
  // grey-box screenshot that fooled me in the browser pane earlier.
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(opts.settle ?? 900);
  const file = path.join(OUT, `${String(++n).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  ${path.basename(file)}`);
};

console.log("capturing:");
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await shot("login-empty");

await page.fill('input[type="text"]', USER);
await page.fill('input[type="password"]', PASS);
await shot("login-filled");

await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
await shot("home", { settle: 2500 });

await page.goto(`${BASE}/catalog`, { waitUntil: "domcontentloaded" });
await shot("catalog-all", { settle: 2500 });

await page.goto(`${BASE}/catalog?cat=Lehenga`, { waitUntil: "domcontentloaded" });
await shot("catalog-lehenga", { settle: 2500 });

const search = page.locator('input[placeholder*="Search"]').first();
if (await search.count()) { await search.fill("mirror"); await shot("catalog-search", { settle: 1600 }); }

await page.goto(`${BASE}/product/DD-LEH-FLR-077-L-GLD`, { waitUntil: "domcontentloaded" });
await shot("product-top", { settle: 2500 });

await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await shot("product-qty", { settle: 1200 });

const inc = page.getByRole("button", { name: "Increase" });
if (await inc.count()) { await inc.first().click(); await inc.first().click(); await shot("product-qty-3", { settle: 700 }); }

const add = page.getByRole("button", { name: /add to cart/i }).first();
if (await add.count()) { await add.click(); await page.waitForTimeout(2500); }

await page.goto(`${BASE}/cart`, { waitUntil: "domcontentloaded" });
await shot("cart", { settle: 2200 });

await page.goto(`${BASE}/order/${ORDER_ID}`, { waitUntil: "domcontentloaded" });
await shot("order-confirmed", { settle: 2500 });

await page.goto(`${BASE}/account/orders`, { waitUntil: "domcontentloaded" });
await shot("my-orders", { settle: 1800 });

await browser.close();
console.log(`\n${n} frames -> ${OUT}`);
