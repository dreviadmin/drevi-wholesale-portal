/**
 * Lets a plain Node script call the app's own server code — the copy
 * generator, the Shopify push — instead of re-implementing it.
 *
 *   node --import ./scripts/lib/app-loader.mjs <script.mjs>
 *
 * Node 24 strips TypeScript types natively; this hook does the three things
 * it cannot: resolve the "@/..." alias to ./src, add the .ts extension to
 * extensionless imports, and replace the modules that only exist inside a
 * Next.js request — "server-only" (throws on import outside React), next/cache
 * (revalidatePath) and next/headers — with harmless stubs.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const STUBS = {
  "server-only": "export {};",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_noStore = () => {};",
  "next/headers": "export const headers = async () => new Map(); export const cookies = async () => ({ get: () => undefined, getAll: () => [] });",
  "next/navigation": "export const redirect = (u) => { throw new Error('redirect: ' + u); }; export const notFound = () => { throw new Error('notFound'); };",
};

register(new URL("data:text/javascript," + encodeURIComponent(`
  const STUBS = ${JSON.stringify(STUBS)};
  const ROOT = ${JSON.stringify(ROOT)};
  const fs = await import("node:fs"); const path = await import("node:path"); const { pathToFileURL, fileURLToPath } = await import("node:url");
  const exts = [".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.tsx"];
  export async function resolve(spec, ctx, next) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    let s = spec;
    if (s.startsWith("@/")) s = pathToFileURL(path.join(ROOT, "src", s.slice(2))).href;
    if (s.startsWith("file:") || s.startsWith("./") || s.startsWith("../")) {
      const base = s.startsWith("file:") ? fileURLToPath(s) : path.resolve(path.dirname(fileURLToPath(ctx.parentURL)), s);
      if (!path.extname(base) || !fs.existsSync(base)) for (const e of exts) { if (fs.existsSync(base + e)) { return { url: pathToFileURL(base + e).href, shortCircuit: true }; } }
      if (fs.existsSync(base)) return { url: pathToFileURL(base).href, shortCircuit: true };
    }
    return next(spec, ctx);
  }
  export async function load(url, ctx, next) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url.endsWith(".tsx")) { const r = await next(url, { ...ctx, format: "module-typescript" }); return r; }
    return next(url, ctx);
  }
`)));
