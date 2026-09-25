/**
 * Capture every screen STATE the walkthrough animates through, as a full-page
 * image plus the pixel box of every element a finger will tap.
 *
 *   node scripts/walkthrough/capture.mjs <outDir> <username> <password>
 *
 * Full-page rather than viewport shots so the renderer can scroll smoothly by
 * sliding a window down the image. The one thing a full-page shot gets wrong
 * is a sticky header — it appears once at the top and then scrolls away — so
 * each state also records the header's height when it is sticky/fixed and the
 * renderer pins it back on.
 *
 * Boxes are in IMAGE pixels (CSS px x deviceScaleFactor), measured with the
 * page scrolled to the top so viewport coords are page coords.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const [OUT, USER, PASS] = process.argv.slice(2);
if (!OUT || !USER || !PASS) { console.error("usage: <outDir> <username> <password>"); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const BASE = "https://drevi-wholesale-portal-swart.vercel.app";
const DPR = 3;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: DPR, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const manifest = {};

async function box(locator) {
  const el = locator.first();
  if (!(await el.count())) return null;
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const b = await el.boundingBox();
  if (!b) return null;
  const sy = await page.evaluate(() => window.scrollY);
  return { x: Math.round(b.x * DPR), y: Math.round((b.y + sy) * DPR), w: Math.round(b.width * DPR), h: Math.round(b.height * DPR) };
}

async function capture(name, targets = {}, opts = {}) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(opts.settle ?? 1400);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  const measured = {};
  for (const [k, loc] of Object.entries(targets)) {
    const b = await box(loc);
    if (b) measured[k] = b; else console.log(`    ! target ${k} not found in ${name}`);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  // The top bar is a plain <div class="sticky top-0">, not a <header>: scroll
  // down, ask what is drawn at the top of the viewport, and walk up to the
  // sticky/fixed ancestor. Its height is what the renderer pins back on.
  const header = await page.evaluate(() => {
    const maxY = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    if (maxY < 200) return { sticky: false, height: 0 };
    window.scrollTo(0, Math.min(700, maxY));
    let el = document.elementFromPoint(195, 12), hit = null;
    while (el && el !== document.body) { const p = getComputedStyle(el).position; if (p === "sticky" || p === "fixed") { hit = el; break; } el = el.parentElement; }
    window.scrollTo(0, 0);
    return hit ? { sticky: true, height: Math.round(hit.getBoundingClientRect().height) } : { sticky: false, height: 0 };
  });
  await page.waitForTimeout(150);
  const file = path.join(OUT, `${name}.png`);
  const full = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.scrollHeight }));
  const MAX_H = 4200; // CSS px; the walkthrough never scrolls further than ~1500
  const dims = { w: full.w, h: Math.min(full.h, MAX_H) };
  await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, width: dims.w, height: dims.h } });
  manifest[name] = { file: `${name}.png`, width: dims.w * DPR, height: dims.h * DPR, viewportH: 844 * DPR, header: { sticky: header.sticky, height: header.height * DPR }, targets: measured };
  console.log(`  ${name.padEnd(18)} ${dims.w}x${dims.h}css  header ${header.sticky ? "sticky " + header.height : "static"}  targets: ${Object.keys(measured).join(", ") || "-"}`);
}

const T = {
  loginU: () => page.locator('input[type="text"]'),
  loginP: () => page.locator('input[type="password"]'),
  signin: () => page.getByRole("button", { name: /sign in/i }),
  forgotLink: () => page.getByRole("link", { name: /forgot password/i }),
  menu: () => page.getByRole("button", { name: /^menu$/i }),
  cartIcon: () => page.locator('a[href="/cart"]'),
  chipLehenga: () => page.locator('a[href="/catalog?cat=Lehenga"]'),
  chipLehengaBtn: () => page.getByRole("button", { name: /^lehenga$/i }),
  menuCatalog: () => page.getByRole("link", { name: /^catalog$/i }),
  search: () => page.locator('input[placeholder*="Search"]'),
  firstCard: () => page.locator('a[href^="/product/"]'),
  inc: () => page.getByRole("button", { name: "Increase" }),
  dec: () => page.getByRole("button", { name: "Decrease" }),
  addToCart: () => page.getByRole("button", { name: /add to cart/i }),
  remove: () => page.getByRole("button", { name: "Remove" }),
  note: () => page.locator("textarea"),
  submit: () => page.getByRole("button", { name: /submit order request/i }),
  myOrders: () => page.getByRole("link", { name: /my orders/i }),
  forgotU: () => page.locator("input").first(),
  forgotBtn: () => page.getByRole("link", { name: /message rakesh/i }),
};

console.log("capturing states:");
// ── login ─────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await capture("login-empty", { "login.username": T.loginU(), "login.password": T.loginP(), "login.signin": T.signin(), "login.forgot": T.forgotLink() });
for (const [i, v] of ["r", "ro", "roya", USER].entries()) { await T.loginU().fill(v); await capture(`login-u${i + 1}`, { "login.username": T.loginU(), "login.password": T.loginP(), "login.signin": T.signin() }, { settle: 300 }); }
for (const [i, v] of [PASS.slice(0, 4), PASS.slice(0, 11), PASS].entries()) { await T.loginP().fill(v); await capture(`login-p${i + 1}`, { "login.password": T.loginP(), "login.signin": T.signin() }, { settle: 300 }); }

await T.signin().click();
await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
// ── home ──────────────────────────────────────────────────────────────────
await capture("home", { "home.menu": T.menu(), "header.cart": T.cartIcon(), "home.chip.lehenga": T.chipLehenga() }, { settle: 2800 });
await T.menu().click(); await page.waitForTimeout(700);
await capture("home-menu", { "menu.catalog": T.menuCatalog(), "home.menu": T.menu() }, { settle: 400 });

// ── catalog ───────────────────────────────────────────────────────────────
await page.goto(`${BASE}/catalog`, { waitUntil: "domcontentloaded" });
await capture("catalog-all", { "catalog.chip.lehenga": T.chipLehengaBtn(), "catalog.search": T.search(), "catalog.card.first": T.firstCard() }, { settle: 3000 });
await page.goto(`${BASE}/catalog?cat=Lehenga`, { waitUntil: "domcontentloaded" });
await capture("catalog-lehenga", { "catalog.chip.lehenga": T.chipLehengaBtn(), "catalog.search": T.search(), "catalog.card.first": T.firstCard() }, { settle: 3000 });
const productHref = await T.firstCard().first().getAttribute("href");
await T.search().fill("mirror"); await page.waitForTimeout(1500);
await capture("catalog-search", { "catalog.search": T.search(), "catalog.card.first": T.firstCard() }, { settle: 1200 });

// ── product ───────────────────────────────────────────────────────────────
await page.goto(`${BASE}${productHref}`, { waitUntil: "domcontentloaded" });
const productTargets = () => ({ "product.plus": T.inc(), "product.qty": T.dec(), "product.addToCart": T.addToCart(), "header.cart": T.cartIcon() });
await capture("product-top", productTargets(), { settle: 3000 });
await T.inc().first().click(); await capture("product-qty2", productTargets(), { settle: 500 });
await T.inc().first().click(); await capture("product-qty3", productTargets(), { settle: 500 });
await T.addToCart().first().click(); await page.waitForTimeout(1800);
await capture("product-added", productTargets(), { settle: 600 });

// a second line for the cart, added quietly from the catalog
await page.goto(`${BASE}/catalog?cat=Saree`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const cardAdd = page.getByRole("button", { name: /add to cart/i }).first();
if (await cardAdd.count()) { await cardAdd.click(); await page.waitForTimeout(1800); }

// ── cart ──────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/cart`, { waitUntil: "domcontentloaded" });
const cartTargets = () => ({ "cart.plus.line1": T.inc().first(), "cart.remove.line2": T.remove().nth(1), "cart.note": T.note(), "cart.submit": T.submit() });
await capture("cart", cartTargets(), { settle: 2600 });
await T.inc().first().click(); await page.waitForTimeout(2200);
await capture("cart-plus", cartTargets(), { settle: 600 });
await T.remove().nth(1).click(); await page.waitForTimeout(2200);
await capture("cart-removed", { "cart.plus.line1": T.inc().first(), "cart.note": T.note(), "cart.submit": T.submit() }, { settle: 600 });

// ── submit ────────────────────────────────────────────────────────────────
await T.note().fill("Demo order for the walkthrough video — please ignore.");
await T.submit().click();
await page.waitForURL((u) => u.pathname.startsWith("/order/"), { timeout: 40000 });
await capture("order-received", { "order.myOrders": T.myOrders() }, { settle: 3000 });
await page.goto(`${BASE}/account/orders`, { waitUntil: "domcontentloaded" });
await capture("my-orders", {}, { settle: 2000 });

// ── forgot password ───────────────────────────────────────────────────────
await page.goto(`${BASE}/forgot-password`, { waitUntil: "domcontentloaded" });
await capture("forgot", { "forgot.username": T.forgotU(), "forgot.message": T.forgotBtn() }, { settle: 1500 });
for (const [i, v] of ["roy", USER].entries()) { await T.forgotU().fill(v); await capture(`forgot-u${i + 1}`, { "forgot.username": T.forgotU(), "forgot.message": T.forgotBtn() }, { settle: 300 }); }
manifest["forgot-typed"] = { ...manifest["forgot-u2"] };

await browser.close();
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));
console.log(`\n${Object.keys(manifest).length} states -> ${OUT}/manifest.json`);
