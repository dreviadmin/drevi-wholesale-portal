/* eslint-disable @typescript-eslint/no-explicit-any -- the fake query builder is untyped on purpose */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Studio, run against a small in-memory database that honours each query's
// filters, PostgREST's 1000-row cap on an un-ranged select, and the tables'
// unique keys (a plain insert batch fails whole on one duplicate, as Postgres
// does). The Studio modules under test are the REAL ones, loaded by relative
// path; Supabase, Shopify, storage, Drive and the Anthropic call are faked.

type Row = Record<string, any>;
let db: Record<string, Row[]> = {};
let nextId = 0;
/** Runs just before a write reaches the table: lets a test play another writer. */
let beforeWrite: ((table: string, op: string) => void) | null = null;
let failSelect: ((table: string) => string | null) | null = null;
/** Makes a write fail with this message (the table is left as it was). */
let failWrite: ((table: string, op: string) => string | null) | null = null;
/** The length of every .in() list sent: the longest is what a request URL carries. */
let inSizes: number[] = [];

const UNIQUE: Record<string, string[]> = {
  designs: ["base_sku", "color"],
  design_angles: ["design_id", "angle"],
  publish_targets: ["design_id", "portal"],
  product_images: ["sku_base", "color", "angle"],
  wholesale_products: ["sku"],
};

const likeTest = (pattern: string, flags = "") =>
  new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, flags);

function fakeAdmin() {
  return {
    from(table: string) {
      let op: "select" | "update" | "insert" | "upsert" | "delete" = "select";
      let cols = "";
      let payload: any;
      let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
      let returning = false;
      let one: "maybe" | "single" | null = null;
      const sorts: string[] = [];
      let range: [number, number] | null = null;
      const tests: ((r: Row) => boolean)[] = [];
      const b: any = {
        select(c?: string) {
          if (op !== "select") returning = true;
          else cols = c ?? "*";
          return b;
        },
        update(p: Row) { op = "update"; payload = p; return b; },
        insert(p: Row | Row[]) { op = "insert"; payload = p; return b; },
        upsert(p: Row | Row[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) { op = "upsert"; payload = p; upsertOpts = o ?? {}; return b; },
        delete() { op = "delete"; return b; },
        eq(k: string, v: unknown) { tests.push((r) => r[k] === v); return b; },
        is(k: string, v: unknown) { tests.push((r) => (r[k] ?? null) === v); return b; },
        in(k: string, vs: unknown[]) { inSizes.push(vs.length); tests.push((r) => vs.includes(r[k])); return b; },
        // Only the shape the tray lookup sends: col.ilike.pattern, OR-ed.
        or(expr: string) {
          const alts = expr.split(",").map((e) => { const [k, , p] = e.split("."); return { k, re: likeTest(p, "i") }; });
          tests.push((r) => alts.some((a) => a.re.test(String(r[a.k] ?? ""))));
          return b;
        },
        like(k: string, p: string) { const re = likeTest(p); tests.push((r) => re.test(String(r[k] ?? ""))); return b; },
        ilike(k: string, p: string) { const re = likeTest(p, "i"); tests.push((r) => re.test(String(r[k] ?? ""))); return b; },
        not(k: string, o: string, v: unknown) {
          if (o === "in") {
            const list = String(v).replace(/^\(|\)$/g, "").split(",").map((s) => s.trim());
            tests.push((r) => !list.includes(String(r[k])));
          } else tests.push((r) => (r[k] ?? null) !== v);
          return b;
        },
        order(k: string) { sorts.push(k); return b; },
        range(from: number, to: number) { range = [from, to]; return b; },
        limit() { return b; },
        maybeSingle() { one = "maybe"; return b; },
        single() { one = "single"; return b; },
        then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
          return Promise.resolve().then(run).then(res, rej);
        },
      };
      const rows = () => (db[table] ??= []);
      const match = () => rows().filter((r) => tests.every((t) => t(r)));
      const shape = (list: Row[]) => {
        const copy = structuredClone(list);
        if (one) return { data: copy[0] ?? null, error: one === "single" && !copy[0] ? { message: "no rows" } : null };
        return { data: copy, error: null };
      };
      const keyOf = (r: Row) => (UNIQUE[table] ?? ["id"]).map((k) => String(r[k])).join("|");
      const fresh = (p: Row): Row => ({ id: `${table}-${++nextId}`, ...structuredClone(p) });
      function run() {
        if (op === "select") {
          const why = failSelect?.(table);
          if (why) return { data: null, error: { message: why } };
          let list = match();
          if (sorts.length) {
            list = [...list].sort((x, y) => {
              for (const k of sorts) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
              return 0;
            });
          }
          // PostgREST's max-rows: an un-ranged select silently stops at 1000.
          list = range ? list.slice(range[0], range[1] + 1) : list.slice(0, 1000);
          if (table === "design_angles" && cols.includes("design_images!angle_id")) {
            list = list.map((a) => ({ ...a, design_images: (db.design_images ?? []).filter((i) => i.angle_id === a.id) }));
          }
          return shape(list);
        }
        beforeWrite?.(table, op);
        const writeErr = failWrite?.(table, op);
        if (writeErr) return { data: null, error: { message: writeErr } };
        if (op === "update") {
          const hit = match();
          for (const r of hit) Object.assign(r, structuredClone(payload));
          return returning ? shape(hit) : { data: null, error: null };
        }
        if (op === "insert") {
          const list = (Array.isArray(payload) ? payload : [payload]).map(fresh);
          const seen = new Set(rows().map(keyOf));
          for (const r of list) {
            if (seen.has(keyOf(r))) return { data: null, error: { message: `duplicate key value violates unique constraint on ${table}`, code: "23505" } };
            seen.add(keyOf(r));
          }
          rows().push(...list);
          return returning ? shape(list) : { data: null, error: null };
        }
        if (op === "upsert") {
          const keys = (upsertOpts.onConflict ?? "id").split(",").map((k) => k.trim());
          const out: Row[] = [];
          for (const p of Array.isArray(payload) ? payload : [payload]) {
            const hit = rows().find((r) => keys.every((k) => r[k] === p[k]));
            if (hit) {
              if (!upsertOpts.ignoreDuplicates) Object.assign(hit, structuredClone(p));
              out.push(hit);
            } else {
              const n = fresh(p);
              rows().push(n);
              out.push(n);
            }
          }
          return returning ? shape(out) : { data: null, error: null };
        }
        const hit = match();
        db[table] = rows().filter((r) => !hit.includes(r));
        return { data: null, error: null };
      }
      return b;
    },
  };
}

const STAFF = { id: "staff-1", email: "ayushi@drevifashion.com", name: "Ayushi", role: "super_admin" as const };
let signedIn: typeof STAFF | null = STAFF;
const writeAuditEvent = vi.fn(async (e: Record<string, unknown>) => { void e; });
const setShopifyStatus = vi.fn(async (id: string, status: string) => { void id; void status; });
const unarchiveShopifyProduct = vi.fn(async (id: string) => { void id; return true; });
let images: Record<string, { body: ArrayBuffer; contentType: string }> = {};
const fetchImageByRef = vi.fn(async (ref: string, size?: number) => { void size; return images[ref] ?? null; });
const storeDesignImage = vi.fn(async (a: { angle: string; kind: string }) => ({ fileRef: `sb:${a.angle}-${a.kind}-${++nextId}`, fileName: `${a.angle}.jpg`, driveFolderId: null }));
// A storage file moves under its folder's _archive/, as the real one does.
const archiveImageFile = vi.fn(async (ref: string) => ref.replace(/^sb:([^/]+)\/(?!_archive\/)/, "sb:$1/_archive/"));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin() }));
vi.mock("@/lib/staff", () => ({
  requireAdmin: async () => { if (!signedIn) throw new Error("no"); return signedIn; },
  requireStaff: async () => { if (!signedIn) throw new Error("no"); return signedIn; },
  getStaff: async () => signedIn,
}));
vi.mock("@/lib/audit", () => ({ writeAuditEvent: (e: Record<string, unknown>) => writeAuditEvent(e) }));
vi.mock("@/lib/shopify", () => ({
  setShopifyStatus: (id: string, s: string) => setShopifyStatus(id, s),
  shopifyProductStatus: async () => "ACTIVE",
  unarchiveShopifyProduct: (id: string) => unarchiveShopifyProduct(id),
  publishShopify: async () => ({ ok: true }),
}));
vi.mock("@/lib/storage", () => ({
  uploadPublishedImage: async (base: string, color: string, angle: string, width: number) => {
    const path = `${base}-${color}/${angle}-${width}.jpg`;
    return { url: `https://proj.supabase.co/storage/v1/object/public/product-images/${path}`, path };
  },
}));
vi.mock("@/lib/design-image-store", () => ({
  fetchImageByRef: (ref: string, size?: number) => fetchImageByRef(ref, size),
  downloadNameForRef: async () => "DD-LEH-FLR-115-GRN-front",
  storeDesignImage: (a: { angle: string; kind: string }) => storeDesignImage(a),
  archiveImageFile: (ref: string) => archiveImageFile(ref),
  isStorageRef: (r: string) => r.startsWith("sb:"),
  ingestDriveFolder: async () => ({ ok: true, added: 0 }),
}));
vi.mock("@/lib/drive", () => ({ listFolderImages: async () => [], listSubfolders: async () => [] }));
vi.mock("@/lib/design-imagery", () => ({ ensureDesignImagery: async () => ({}) }));
vi.mock("@/lib/pipeline/sweep", () => ({ sweepStaleJobs: async () => {}, cancelJobsForAngle: async () => 0 }));
vi.mock("@/lib/studio/catalog-front", () => ({ syncCatalogFrontQuietly: async () => {} }));
vi.mock("@/lib/sku/vocab-live", () => ({ loadVocab: async () => ({ categories: {}, colorGroups: [] }) }));
// The real modules behind the @/ specifiers (vitest here does not resolve the
// alias), so the flag check, the publish routine and the copy generator are
// the ones the app runs.
vi.mock("@/lib/supabase/fetch-all", async () => await import("../../lib/supabase/fetch-all"));
vi.mock("@/lib/studio/state", async () => await import("../../lib/studio/state"));
vi.mock("@/lib/studio/prompts", async () => await import("../../lib/studio/prompts"));
vi.mock("@/lib/studio/facts", async () => await import("../../lib/studio/facts"));
vi.mock("@/lib/studio/backgrounds", async () => await import("../../lib/studio/backgrounds"));
vi.mock("@/lib/studio/copy-models", async () => await import("../../lib/studio/copy-models"));
vi.mock("@/lib/pipeline/engines", async () => await import("../../lib/pipeline/engines"));
vi.mock("@/lib/studio/publish", async () => await import("../../lib/studio/publish"));
vi.mock("@/lib/studio/copy", async () => await import("../../lib/studio/copy"));
vi.mock("@/lib/attachment-name", async () => await import("../../lib/attachment-name"));
// Product Master's saves (specs and pricing). The ledger is faked; the price
// maths, the origin options and the Shopify-facts rule are the real ones.
vi.mock("@/lib/stock-ledger", () => ({
  applyMovement: async () => ({ ok: true }),
  canonicalFromMovements: () => 0,
  recomputeCache: async () => {},
  setStock: async () => ({ ok: true, stock: 0 }),
}));
vi.mock("@/lib/pricing", async () => await import("../../lib/pricing"));
vi.mock("@/lib/studio/copy-prompt", async () => await import("../../lib/studio/copy-prompt"));
vi.mock("@/lib/studio/shopify-facts", async () => await import("../../lib/studio/shopify-facts"));
vi.mock("@/lib/chunk", async () => await import("../../lib/chunk"));
vi.mock("@/lib/studio/buckets", async () => await import("../../lib/studio/buckets"));
// loadDesignDetail, rebuilt from the fake tables: what publish.ts reads.
vi.mock("../../lib/studio/load", () => ({
  loadDesignDetail: async (designId: string) => {
    const d = (db.designs ?? []).find((x) => x.id === designId);
    if (!d) return null;
    const angles = (db.design_angles ?? []).filter((a) => a.design_id === designId).map((a) => ({
      id: a.id,
      angle: a.angle,
      approvedImageId: a.approved_image_id ?? null,
      sourceRef: a.source_ref ?? null,
      sourceImageId: a.source_image_id ?? null,
      candidates: (db.design_images ?? []).filter((i) => i.angle_id === a.id).map((i) => ({ id: i.id, fileRef: i.file_ref })),
    }));
    const targets = (db.publish_targets ?? []).filter((t) => t.design_id === designId)
      .map((t) => ({ portal: t.portal, enabled: t.enabled !== false, state: t.state, hasProduct: !!t.remote_id, error: t.error ?? null }));
    const open = { ready: !d.discontinued_at, blockers: d.discontinued_at ? ["Discontinued — restore it first"] : [] };
    return {
      board: { id: d.id, baseSku: d.base_sku, color: d.color, discontinuedAt: d.discontinued_at ?? null, targets, gates: { wholesale: open, shopify: open }, copyPresent: false },
      angles,
      copy: null,
    };
  },
}));

const studio = await import("./studio/actions");
const workbench = await import("./studio/[designId]/actions");
const imageActions = await import("./studio/[designId]/image-actions");
const master = await import("./studio/master/[designId]/actions");
const bucketActions = await import("./studio/bucket-actions");
const { ingestDesigns } = await import("../../lib/studio/ingest");
const publish = await import("../../lib/studio/publish");
const drivePhoto = await import("../api/drive-photo/route");

const DESIGN = "design-grn";
const OTHER = "design-red";
const BASE = "DD-LEH-FLR-115";

const target = (designId: string, portal: string) => db.publish_targets.find((t) => t.design_id === designId && t.portal === portal);
const sizes = (color: string, visible = true) =>
  ["S", "M", "L"].map((s) => ({ sku: `${BASE}-${s}-${color}`, buyer_visible: visible, wholesale_visible: true, locked_fields: [], image_urls: [] }));
const jpeg = (label: string) => ({ body: new TextEncoder().encode(label).buffer as ArrayBuffer, contentType: "image/jpeg" });

beforeEach(() => {
  nextId = 0;
  beforeWrite = null;
  failSelect = null;
  failWrite = null;
  inSizes = [];
  signedIn = STAFF;
  images = {};
  db = {
    designs: [
      { id: DESIGN, base_sku: BASE, color: "GRN", discontinued_at: null },
      { id: OTHER, base_sku: BASE, color: "RED", discontinued_at: null },
    ],
    publish_targets: [
      { design_id: DESIGN, portal: "wholesale", enabled: true, state: "live", error: null, remote_id: null },
      { design_id: DESIGN, portal: "shopify", enabled: true, state: "live", error: null, remote_id: "gid://shopify/Product/1" },
      { design_id: OTHER, portal: "wholesale", enabled: true, state: "live", error: null, remote_id: null },
      { design_id: OTHER, portal: "shopify", enabled: true, state: "live", error: null, remote_id: null },
    ],
    wholesale_products: [...sizes("GRN"), ...sizes("RED")],
    design_angles: [],
    design_images: [],
    design_copy: [],
    product_images: [],
    pipeline_jobs: [],
  };
  writeAuditEvent.mockClear();
  setShopifyStatus.mockClear();
  unarchiveShopifyProduct.mockClear();
  fetchImageByRef.mockClear();
  storeDesignImage.mockClear();
  archiveImageFile.mockClear();
});

describe("Discontinue and Restore leave the wholesale target honest", () => {
  it("Discontinue takes a live wholesale target to ready, alongside main's catalog hide and Shopify archive", async () => {
    target(DESIGN, "wholesale")!.error = "old push error";
    const r = await studio.setDiscontinued(DESIGN, true, "end of season");
    expect(r).toMatchObject({ ok: true, hiddenSkus: 3, shopifyArchived: true });
    expect(target(DESIGN, "wholesale")).toMatchObject({ state: "ready", error: null });
    // main's newer behaviour is untouched: Shopify ARCHIVED, its target ready.
    expect(setShopifyStatus).toHaveBeenCalledWith("gid://shopify/Product/1", "ARCHIVED");
    expect(target(DESIGN, "shopify")).toMatchObject({ state: "ready", error: null });
    expect(db.wholesale_products.filter((p) => p.sku.endsWith("-GRN")).every((p) => !p.buyer_visible)).toBe(true);
    expect(db.wholesale_products.filter((p) => p.sku.endsWith("-GRN")).every((p) => p.wholesale_visible)).toBe(true);
    // The other colour of the same base keeps everything.
    expect(target(OTHER, "wholesale")!.state).toBe("live");
    expect(db.wholesale_products.filter((p) => p.sku.endsWith("-RED")).every((p) => p.buyer_visible)).toBe(true);
  });

  it("Discontinue also clears changes pending, and leaves a target that was never out there alone", async () => {
    target(DESIGN, "wholesale")!.state = "changes_pending";
    await studio.setDiscontinued(DESIGN, true);
    expect(target(DESIGN, "wholesale")!.state).toBe("ready");

    target(OTHER, "wholesale")!.state = "error";
    target(OTHER, "wholesale")!.error = "variant failed";
    await studio.setDiscontinued(OTHER, true);
    expect(target(OTHER, "wholesale")).toMatchObject({ state: "error", error: "variant failed" });
  });

  it("keeps the target 'live' (and Unpublish wholesale with it) when hiding the sizes fails, and says so", async () => {
    failWrite = (t, op) => (t === "wholesale_products" && op === "update" ? "statement timeout" : null);
    const r = await studio.setDiscontinued(DESIGN, true, "end of season");
    expect(r).toMatchObject({ ok: true, hiddenSkus: 0, catalogError: "statement timeout" });
    expect(target(DESIGN, "wholesale")!.state).toBe("live");
    expect(db.wholesale_products.filter((p) => p.sku.endsWith("-GRN")).every((p) => p.buyer_visible)).toBe(true);
    expect(String(writeAuditEvent.mock.calls.at(-1)?.[0]?.notes)).toContain("CATALOG NOT HIDDEN: statement timeout");
    // Retired all the same — the design row says so.
    expect(db.designs.find((d) => d.id === DESIGN)!.discontinued_at).toBeTruthy();
  });

  it("keeps the target 'live' when the sizes cannot even be read", async () => {
    failSelect = (t) => (t === "wholesale_products" ? "connection reset" : null);
    const r = await studio.setDiscontinued(DESIGN, true);
    expect(r).toMatchObject({ ok: true, hiddenSkus: 0, catalogError: "connection reset" });
    expect(target(DESIGN, "wholesale")!.state).toBe("live");
  });

  it("after Discontinue then Restore, the Wholesale card reads ready (asks for a push), and Shopify is back to draft", async () => {
    await studio.setDiscontinued(DESIGN, true);
    const r = await studio.setDiscontinued(DESIGN, false);
    expect(r).toMatchObject({ ok: true, shopifyUnarchived: true });
    expect(unarchiveShopifyProduct).toHaveBeenCalledWith("gid://shopify/Product/1");
    expect(target(DESIGN, "wholesale")!.state).toBe("ready");
    // Restore still does not put it back in the catalog: that stays a push.
    expect(db.wholesale_products.filter((p) => p.sku.endsWith("-GRN")).some((p) => p.buyer_visible)).toBe(false);
  });

  it("Restore corrects a product retired before the reset existed: hidden rows, target still 'live'", async () => {
    const d = db.designs.find((x) => x.id === DESIGN)!;
    d.discontinued_at = "2026-10-20T05:00:00.000Z";
    for (const p of db.wholesale_products) if (p.sku.endsWith("-GRN")) p.buyer_visible = false;
    await studio.setDiscontinued(DESIGN, false);
    expect(target(DESIGN, "wholesale")!.state).toBe("ready");
    expect(target(OTHER, "wholesale")!.state).toBe("live");
  });

  it("Restore keeps 'live' when a size is still in the buyer catalog, or when the catalog cannot be read", async () => {
    const d = db.designs.find((x) => x.id === DESIGN)!;
    d.discontinued_at = "2026-10-20T05:00:00.000Z";
    for (const p of db.wholesale_products) if (p.sku.endsWith("-GRN")) p.buyer_visible = p.sku.includes("-M-");
    await studio.setDiscontinued(DESIGN, false);
    expect(target(DESIGN, "wholesale")!.state).toBe("live");

    d.discontinued_at = "2026-10-20T05:00:00.000Z";
    for (const p of db.wholesale_products) if (p.sku.endsWith("-GRN")) p.buyer_visible = false;
    failSelect = (t) => (t === "wholesale_products" ? "timeout" : null);
    const r = await studio.setDiscontinued(DESIGN, false);
    expect(r.ok).toBe(true);
    expect(target(DESIGN, "wholesale")!.state).toBe("live");
  });
});

describe("0075 gives designs retired before the reset the state Discontinue gives new ones", () => {
  const sql = readFileSync(join(__dirname, "..", "..", "..", "supabase", "migrations", "0075_lock_down_rpcs.sql"), "utf8");
  const stmt = sql.slice(sql.indexOf("update public.publish_targets"));
  const body = stmt.slice(0, stmt.indexOf(";") + 1);

  it("is the one data update in the file, and writes only the wholesale target of a discontinued design", () => {
    expect(sql.match(/^update /gm)).toHaveLength(1);
    expect(body).toContain("set state = 'ready', error = null");
    expect(body).toContain("pt.portal = 'wholesale'");
    expect(body).toContain("pt.state in ('live', 'changes_pending')");
    expect(body).toContain("d.discontinued_at is not null");
    // The Shopify target (archive state and its error) and the buckets are not touched.
    expect(body).not.toMatch(/shopify|bucket/i);
  });

  it("skips a design while a size is still in the buyer catalog, matching sizes as setDiscontinued does", () => {
    expect(body).toMatch(/and not exists \(\s*select 1\s+from public\.wholesale_products wp\s+where wp\.buyer_visible/);
    expect(body).toContain("starts_with(wp.sku, d.base_sku || '-')");
    expect(body).toContain("right(upper(wp.sku), length(d.color) + 1) = '-' || upper(d.color)");
  });
});

describe("Run FASHN while model swap is parked", () => {
  const prev = process.env.FASHN_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.FASHN_ENABLED;
    else process.env.FASHN_ENABLED = prev;
  });
  const fashnAngle = () => db.design_angles.push({ id: "a-front", design_id: DESIGN, angle: "front", engine: "fashn", source_ref: "src-front", approved_image_id: null });

  it("refuses, dry run included, and queues nothing", async () => {
    delete process.env.FASHN_ENABLED;
    fashnAngle();
    expect(await studio.runFashnBatch([DESIGN], true)).toEqual({ ok: false, error: "Model swap is parked — set FASHN_ENABLED=true to bring it back" });
    expect((await studio.runFashnBatch([DESIGN], false)).ok).toBe(false);
    expect(db.pipeline_jobs).toHaveLength(0);
  });

  it("still counts the work when the flag is on", async () => {
    process.env.FASHN_ENABLED = "true";
    fashnAngle();
    expect(await studio.runFashnBatch([DESIGN], true)).toEqual({ ok: true, jobs: 1, credits: 2 });
  });
});

describe("A large Studio selection is acted on in full", () => {
  /** n designs, each with a Shopify target, as a Select all on a big board makes them. */
  const many = (n: number) => {
    const ids = Array.from({ length: n }, (_, i) => `bulk-${i}`);
    db.designs = ids.map((id, i) => ({ id, base_sku: `DD-LEH-FLR-${String(i).padStart(4, "0")}`, color: "GRN", tier: "standard", discontinued_at: null }));
    db.publish_targets = ids.map((id) => ({ design_id: id, portal: "shopify", enabled: true, state: "ready" }));
    return ids;
  };
  const longestIn = () => Math.max(0, ...inSizes);

  it("Set hero reaches every design past the old 500, in short requests", async () => {
    const ids = many(620);
    expect(await studio.setTierBatch(ids, "hero")).toEqual({ ok: true });
    expect(db.designs.every((d) => d.tier === "hero")).toBe(true);
    expect(longestIn()).toBeLessThanOrEqual(150);
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "studio_tier_set", notes: "tier=hero on 620 design(s)" }));
  });

  it("past the sanity cap it says so and changes nothing", async () => {
    const ids = many(2001);
    expect(await studio.setTierBatch(ids, "hero")).toEqual({ ok: false, error: "Select at most 2,000 designs at a time." });
    expect(await studio.togglePortalBatch(ids, "shopify", false)).toEqual({ ok: false, error: "Select at most 2,000 designs at a time." });
    expect(db.designs.some((d) => d.tier === "hero")).toBe(false);
    expect(db.publish_targets.every((t) => t.enabled)).toBe(true);
  });

  it("Shopify off reaches every selected design", async () => {
    const ids = many(620);
    expect(await studio.togglePortalBatch(ids, "shopify", false)).toEqual({ ok: true });
    expect(db.publish_targets.every((t) => !t.enabled)).toBe(true);
    expect(longestIn()).toBeLessThanOrEqual(150);
  });

  it("Use candidates lists every angle, past the 1,000-row cap on one read", async () => {
    const ids = many(200);
    const angles = ["front", "back", "side", "lifestyle", "detail_1", "detail_2"];
    db.design_angles = ids.flatMap((id) => angles.map((angle) => ({ id: `${id}-${angle}`, design_id: id, angle, approved_image_id: null })));
    db.design_images = db.design_angles.map((a) => ({ id: `img-${a.id}`, angle_id: a.id, role: "candidate", file_ref: `ref-${a.id}`, status: "active", created_at: "2026-11-01T00:00:00Z" }));
    const r = await studio.approveAllPreflight(ids);
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(1200);
    expect(longestIn()).toBeLessThanOrEqual(100);
  });

  it("Print labels finds the tags of every design past the old 200", async () => {
    const ids = many(250);
    db.sku_registry = db.designs.flatMap((d) => ["S", "M"].map((s) => ({ variant_sku: `${d.base_sku}-${s}-GRN` })));
    const r = await studio.traySkusForDesigns(ids);
    expect(r).toMatchObject({ ok: true, groups: 250, missing: [] });
    expect(r.skus).toHaveLength(500);
    expect(longestIn()).toBeLessThanOrEqual(100);
  });

  it("a bucket add and a clear reach every selected design, in short requests", async () => {
    const ids = many(400);
    db.studio_buckets = [{ key: "c_rush", label: "Rush", sort: 1, preset: false, active: true }];
    db.design_buckets = [];
    expect(await bucketActions.changeDesignBuckets(ids, { add: ["c_rush"] })).toMatchObject({ ok: true, updated: 400 });
    expect(db.design_buckets).toHaveLength(400);
    inSizes = [];
    expect(await bucketActions.changeDesignBuckets(ids, { clear: true })).toMatchObject({ ok: true, updated: 400 });
    expect(db.design_buckets).toHaveLength(0);
    expect(longestIn()).toBeLessThanOrEqual(150);
  });

  it("a bucket change over the cap is refused whole, as before", async () => {
    const ids = many(501);
    expect(await bucketActions.changeDesignBuckets(ids, { clear: true })).toEqual({ ok: false, error: "Select at most 500 designs at a time." });
  });
});

describe("Changing what a live design publishes asks for a Re-push", () => {
  it("a copy edit flips live targets to changes pending, though the copy row was never approved", async () => {
    db.design_copy = [{ design_id: DESIGN, status: "draft", title: "Old", description: "Old words" }];
    target(DESIGN, "shopify")!.state = "ready";
    const r = await workbench.saveCopyEdit(DESIGN, { title: "Green floral lehenga", description: "New words.", tags: { color: "Green" } });
    expect(r).toEqual({ ok: true });
    expect(target(DESIGN, "wholesale")!.state).toBe("changes_pending");
    expect(target(DESIGN, "shopify")!.state).toBe("ready");
    expect(target(OTHER, "wholesale")!.state).toBe("live");
  });

  it("a new source on an angle with no approved image flips; one behind an approved image does not", async () => {
    db.design_images = [
      { id: "img-pool", design_id: DESIGN, angle_id: null, file_ref: "pool-ref", status: "active" },
      { id: "img-ok", design_id: DESIGN, angle_id: "a-back", file_ref: "studio-back", status: "active" },
    ];
    db.design_angles = [
      { id: "a-front", design_id: DESIGN, angle: "front", source_ref: "src-front", source_image_id: null, approved_image_id: null },
      { id: "a-back", design_id: DESIGN, angle: "back", source_ref: "src-back", source_image_id: null, approved_image_id: "img-ok" },
    ];
    expect(await imageActions.setAngleSource("a-back", "img-pool")).toEqual({ ok: true });
    expect(target(DESIGN, "wholesale")!.state).toBe("live");

    expect(await imageActions.setAngleSource("a-front", "img-pool")).toEqual({ ok: true });
    expect(target(DESIGN, "wholesale")!.state).toBe("changes_pending");
    expect(target(DESIGN, "shopify")!.state).toBe("changes_pending");
  });

  it("an uploaded reshoot of an unapproved front flips the live targets", async () => {
    db.design_angles = [{ id: "a-front", design_id: DESIGN, angle: "front", source_ref: "src-front", source_image_id: null, approved_image_id: null }];
    const form = new FormData();
    form.set("photo", new File([new Uint8Array([1, 2, 3])], "front.jpg", { type: "image/jpeg" }));
    const r = await imageActions.uploadSource("a-front", form);
    expect(r.ok).toBe(true);
    expect(db.design_angles[0].source_ref).toMatch(/^sb:front-src-/);
    expect(target(DESIGN, "wholesale")!.state).toBe("changes_pending");
  });
});

describe("Use directly replaces a production image the way every approval does", () => {
  it("archives the old row AND moves its file, flips live targets and logs the approval", async () => {
    db.design_images = [
      { id: "img-old", design_id: DESIGN, angle_id: "a-front", role: "ident", file_ref: "sb:DD-GRN/old.jpg", status: "active" },
      { id: "img-new", design_id: DESIGN, angle_id: null, role: "ident", file_ref: "sb:DD-GRN/new.jpg", status: "active" },
    ];
    db.design_angles = [{ id: "a-front", design_id: DESIGN, angle: "front", source_ref: "sb:DD-GRN/old.jpg", source_image_id: "img-old", approved_image_id: "img-old" }];
    expect(await imageActions.applyImageDirectly("a-front", "img-new")).toEqual({ ok: true });
    expect(db.design_angles[0]).toMatchObject({ source_image_id: "img-new", source_ref: "sb:DD-GRN/new.jpg", approved_image_id: "img-new" });
    expect(db.design_images.find((i) => i.id === "img-new")).toMatchObject({ angle_id: "a-front", status: "active" });
    expect(archiveImageFile).toHaveBeenCalledTimes(1);
    expect(archiveImageFile).toHaveBeenCalledWith("sb:DD-GRN/old.jpg");
    expect(db.design_images.find((i) => i.id === "img-old")).toMatchObject({ status: "archived", file_ref: "sb:DD-GRN/_archive/old.jpg" });
    expect(target(DESIGN, "wholesale")!.state).toBe("changes_pending");
    expect(target(DESIGN, "shopify")!.state).toBe("changes_pending");
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "studio_candidate_approved", notes: expect.stringContaining("img-new") }));
  });

  it("using the production image again moves nothing", async () => {
    db.design_images = [{ id: "img-a", design_id: DESIGN, angle_id: "a-front", role: "ident", file_ref: "sb:DD-GRN/a.jpg", status: "active" }];
    db.design_angles = [{ id: "a-front", design_id: DESIGN, angle: "front", source_ref: "sb:DD-GRN/a.jpg", source_image_id: "img-a", approved_image_id: "img-a" }];
    expect(await imageActions.applyImageDirectly("a-front", "img-a")).toEqual({ ok: true });
    expect(archiveImageFile).not.toHaveBeenCalled();
    expect(db.design_images[0]).toMatchObject({ status: "active", file_ref: "sb:DD-GRN/a.jpg" });
  });
});

describe("Reject takes a Use-directly photo out of the published set", () => {
  it("clears the source as well as the approval, and asks for a Re-push", async () => {
    db.design_images = [{ id: "img-pool", design_id: DESIGN, angle_id: null, role: "ident", file_ref: "pool-ref", status: "active" }];
    db.design_angles = [{ id: "a-front", design_id: DESIGN, angle: "front", source_ref: null, source_image_id: null, approved_image_id: null }];
    expect(await imageActions.applyImageDirectly("a-front", "img-pool")).toEqual({ ok: true });
    expect(db.design_angles[0]).toMatchObject({ source_image_id: "img-pool", source_ref: "pool-ref", approved_image_id: "img-pool" });
    for (const t of db.publish_targets) t.state = "live";

    expect(await imageActions.rejectImage("img-pool")).toEqual({ ok: true });
    expect(db.design_angles[0]).toMatchObject({ source_image_id: null, source_ref: null, approved_image_id: null });
    expect(db.design_images[0].status).toBe("rejected");
    expect(target(DESIGN, "wholesale")!.state).toBe("changes_pending");
    expect(target(DESIGN, "shopify")!.state).toBe("changes_pending");
    expect(target(OTHER, "wholesale")!.state).toBe("live");
  });

  it("a rejected source behind another approved image is cleared without a Re-push", async () => {
    db.design_images = [
      { id: "img-src", design_id: DESIGN, angle_id: "a-front", role: "source", file_ref: "src-ref", status: "active" },
      { id: "img-ok", design_id: DESIGN, angle_id: "a-front", role: "candidate", file_ref: "ok-ref", status: "active" },
    ];
    db.design_angles = [{ id: "a-front", design_id: DESIGN, angle: "front", source_ref: "src-ref", source_image_id: "img-src", approved_image_id: "img-ok" }];
    expect(await imageActions.rejectImage("img-src")).toEqual({ ok: true });
    expect(db.design_angles[0]).toMatchObject({ source_image_id: null, source_ref: null, approved_image_id: "img-ok" });
    expect(target(DESIGN, "wholesale")!.state).toBe("live");
  });

  it("rejecting a candidate leaves the angle's source alone", async () => {
    db.design_images = [
      { id: "img-src", design_id: DESIGN, angle_id: "a-front", role: "source", file_ref: "src-ref", status: "active" },
      { id: "img-cand", design_id: DESIGN, angle_id: "a-front", role: "candidate", file_ref: "cand-ref", status: "active" },
    ];
    db.design_angles = [{ id: "a-front", design_id: DESIGN, angle: "front", source_ref: "src-ref", source_image_id: "img-src", approved_image_id: null }];
    expect(await imageActions.rejectImage("img-cand")).toEqual({ ok: true });
    expect(db.design_angles[0]).toMatchObject({ source_image_id: "img-src", source_ref: "src-ref", approved_image_id: null });
    expect(target(DESIGN, "wholesale")!.state).toBe("live");
  });
});

describe("Product Master saves ask Shopify for a Re-push when they move what it shows", () => {
  const facts = { fabric: "Silk", handwork: "Zardosi", origin: "curated", color_name: "Emerald" };
  const specsPatch = { fabric: "Silk", handwork: "Zardosi", origin: "curated", colorName: "Emerald", specsVerified: true };
  beforeEach(() => {
    Object.assign(db.designs[0], facts, { auto_mrp: null, mrp_override: 5999, compare_at_price: null });
  });

  it("a fabric change flips the live Shopify target only", async () => {
    expect(await master.saveSpecs(DESIGN, { ...specsPatch, fabric: "Georgette" })).toEqual({ ok: true });
    expect(target(DESIGN, "shopify")!.state).toBe("changes_pending");
    expect(target(DESIGN, "wholesale")!.state).toBe("live");
    expect(target(OTHER, "shopify")!.state).toBe("live");
  });

  it("a supply-only save leaves Shopify live", async () => {
    expect(await master.saveSpecs(DESIGN, { ...specsPatch, supply: { supplyNote: "Two weeks to make" } })).toEqual({ ok: true });
    expect(db.designs[0].supply_note).toBe("Two weeks to make");
    expect(target(DESIGN, "shopify")!.state).toBe("live");
  });

  it("a new MRP flips it; the same MRP again does not", async () => {
    const pricing = { markupMultiplier: 2.5, mrpOverride: 5999, wholesaleMultiplier: 1.2, wholesaleOverride: null };
    expect((await master.savePricing(DESIGN, pricing)).ok).toBe(true);
    expect(target(DESIGN, "shopify")!.state).toBe("live");

    expect((await master.savePricing(DESIGN, { ...pricing, mrpOverride: 6499 })).ok).toBe(true);
    expect(db.designs[0].mrp_override).toBe(6499);
    expect(target(DESIGN, "shopify")!.state).toBe("changes_pending");
    expect(target(DESIGN, "wholesale")!.state).toBe("live");
  });

  it("a new compare-at flips it", async () => {
    const r = await master.savePricing(DESIGN, { markupMultiplier: 2.5, mrpOverride: 5999, wholesaleMultiplier: 1.2, wholesaleOverride: null, compareAtPrice: 7999 });
    expect(r.ok).toBe(true);
    expect(target(DESIGN, "shopify")!.state).toBe("changes_pending");
  });

  it("a refused save changes nothing", async () => {
    const r = await master.savePricing(DESIGN, { markupMultiplier: 2.5, mrpOverride: 6499, wholesaleMultiplier: 1.2, wholesaleOverride: null, compareAtPrice: 100 });
    expect(r.ok).toBe(false);
    expect(target(DESIGN, "shopify")!.state).toBe("live");
  });
});

describe("Generate copy: the photos it describes, and the Re-push it asks for", () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  let sent: string[][] = [];
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    sent = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      sent.push(body.messages[0].content.filter((c: { type: string }) => c.type === "image").map((c: { source: { data: string } }) => Buffer.from(c.source.data, "base64").toString()));
      return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ title: "Green lehenga", description: "Words.", tags: { color: "Green" } }) }] }), { status: 200 });
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  });

  it("sends the front and back sources ahead of a lone detail approval, and flips live targets", async () => {
    db.designs[0] = { ...db.designs[0], specs_verified: true, tier: "standard", category: "LEH", sub_category: "FLR" };
    db.design_angles = [
      { id: "a-d1", design_id: DESIGN, angle: "detail_1", source_ref: "src-d1", approved_image_id: "img-macro" },
      { id: "a-back", design_id: DESIGN, angle: "back", source_ref: "src-back", approved_image_id: null },
      { id: "a-front", design_id: DESIGN, angle: "front", source_ref: "src-front", approved_image_id: null },
    ];
    db.design_images = [{ id: "img-macro", angle_id: "a-d1", file_ref: "macro", status: "active" }];
    images = { "src-front": jpeg("FRONT"), "src-back": jpeg("BACK"), macro: jpeg("MACRO"), "src-d1": jpeg("D1") };
    const r = await workbench.generateCopy(DESIGN);
    expect(r).toEqual({ ok: true });
    expect(sent).toEqual([["FRONT", "BACK", "MACRO"]]);
    expect(db.design_copy[0]).toMatchObject({ title: "Green lehenga", status: "draft" });
    expect(target(DESIGN, "wholesale")!.state).toBe("changes_pending");
    expect(target(DESIGN, "shopify")!.state).toBe("changes_pending");
    expect(target(OTHER, "wholesale")!.state).toBe("live");
  });
});

describe("Studio ingest past PostgREST's 1000-row cap", () => {
  const ANGLES = ["front", "back", "side", "lifestyle", "detail_1", "detail_2"];
  function seed(n: number) {
    db.designs = [];
    db.design_angles = [];
    db.publish_targets = [];
    for (let i = 0; i < n; i++) {
      const id = `d-${String(i).padStart(4, "0")}`;
      db.designs.push({ id, base_sku: `DD-LEH-FLR-${String(i).padStart(3, "0")}`, color: "GRN" });
      for (const angle of ANGLES) db.design_angles.push({ id: `${id}-${angle}`, design_id: id, angle });
      for (const portal of ["wholesale", "shopify"]) db.publish_targets.push({ design_id: id, portal, state: "not_ready" });
    }
  }
  const sheetRow = (sku: string) => ({ sku, title: null, category: null, sub_category: null });

  it("a new sheet-born design gets its six angles and two targets with 1,800 angle rows already there", async () => {
    seed(300);
    const warnings: string[] = [];
    const r = await ingestDesigns(fakeAdmin() as any, [sheetRow("DD-LEH-FLR-999-M-PNK"), sheetRow("DD-LEH-FLR-005-M-GRN")], warnings);
    expect(warnings).toEqual([]);
    expect(r).toEqual({ designs: 301, created: 1 });
    const fresh = db.designs.find((d) => d.base_sku === "DD-LEH-FLR-999")!;
    expect(db.design_angles.filter((a) => a.design_id === fresh.id).map((a) => a.angle).sort()).toEqual([...ANGLES].sort());
    expect(db.publish_targets.filter((t) => t.design_id === fresh.id)).toHaveLength(2);
    // Nothing existing was duplicated or rewritten.
    expect(db.design_angles).toHaveLength(301 * 6);
    expect(db.publish_targets).toHaveLength(301 * 2);
  });

  it("a row another writer added between the read and the write is skipped, not fatal to the batch", async () => {
    seed(2);
    beforeWrite = (table, op) => {
      if (table !== "design_angles" || op === "select") return;
      const fresh = db.designs.find((d) => d.base_sku === "DD-LEH-FLR-999");
      if (fresh && !db.design_angles.some((a) => a.design_id === fresh.id)) {
        db.design_angles.push({ id: "race-front", design_id: fresh.id, angle: "front", source_ref: "kept" });
      }
    };
    const warnings: string[] = [];
    await ingestDesigns(fakeAdmin() as any, [sheetRow("DD-LEH-FLR-999-M-PNK")], warnings);
    expect(warnings).toEqual([]);
    const fresh = db.designs.find((d) => d.base_sku === "DD-LEH-FLR-999")!;
    const mine = db.design_angles.filter((a) => a.design_id === fresh.id);
    expect(mine).toHaveLength(6);
    expect(mine.find((a) => a.angle === "front")).toMatchObject({ id: "race-front", source_ref: "kept" });
  });
});

describe("The published image set", () => {
  function photographed() {
    db.design_angles = [
      { id: "a-front", design_id: DESIGN, angle: "front", source_ref: "src-front", source_image_id: "img-src-front", approved_image_id: null },
      { id: "a-life", design_id: DESIGN, angle: "lifestyle", source_ref: null, source_image_id: null, approved_image_id: null },
    ];
    images = { "src-front": jpeg("FRONT") };
    db.product_images = [
      { sku_base: BASE, color: "GRN", angle: "front", storage_path: `${BASE}-GRN/front-2048.jpg`, source_candidate_id: "img-old", published_at: "2026-10-01T00:00:00.000Z" },
      // An imported lifestyle, since rejected: nothing behind the angle now.
      { sku_base: BASE, color: "GRN", angle: "lifestyle", storage_path: `${BASE}-GRN/lifestyle-2048.jpg`, source_candidate_id: "img-life", published_at: "2026-10-01T00:00:00.000Z" },
      { sku_base: BASE, color: "RED", angle: "lifestyle", storage_path: `${BASE}-RED/lifestyle-2048.jpg`, source_candidate_id: "img-red", published_at: "2026-10-01T00:00:00.000Z" },
    ];
  }

  it("notices a registered photo the design no longer has", async () => {
    photographed();
    db.product_images[0].source_candidate_id = "img-src-front";
    expect(await publish.publishedSetIsStale(DESIGN)).toBe(true);
    db.product_images = db.product_images.filter((p) => !(p.color === "GRN" && p.angle === "lifestyle"));
    expect(await publish.publishedSetIsStale(DESIGN)).toBe(false);
  });

  it("prunes that photo from the registry, and only for this design", async () => {
    photographed();
    const r = await publish.publishImageSet(DESIGN);
    expect(r).toMatchObject({ ok: true, count: 1 });
    expect(db.product_images.filter((p) => p.color === "GRN").map((p) => p.angle)).toEqual(["front"]);
    expect(db.product_images.filter((p) => p.color === "RED")).toHaveLength(1);
  });

  it("the wholesale push hands buyers a versioned URL, so a reshoot is not served from a 7-day cache", async () => {
    photographed();
    target(DESIGN, "wholesale")!.state = "changes_pending";
    const r = await publish.publishWholesale(DESIGN, STAFF.id, STAFF.email);
    expect(r).toMatchObject({ ok: true, published: 1, variants: 3 });
    const front = db.product_images.find((p) => p.color === "GRN" && p.angle === "front")!;
    // The registry keeps the bare path; the stamp is the same one the board puts on its thumbnail.
    expect(front.storage_path).toBe(`${BASE}-GRN/front-2048.jpg`);
    const url = `https://proj.supabase.co/storage/v1/object/public/product-images/${BASE}-GRN/front-2048.jpg?v=${Date.parse(front.published_at)}`;
    for (const p of db.wholesale_products.filter((x) => x.sku.endsWith("-GRN"))) {
      expect(p.image_urls).toEqual([url]);
      expect(p.buyer_visible).toBe(true);
    }
    expect(target(DESIGN, "wholesale")!.state).toBe("live");
  });
});

describe("/api/drive-photo serves photos as photos and nothing else", () => {
  const get = (q: string) => drivePhoto.GET(new Request(`https://portal.test/api/drive-photo?${q}`));

  it("a JPEG renders inline, with nosniff and a sandbox", async () => {
    images = { photo: jpeg("x") };
    const res = await get("id=photo&s=400");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("HTML or SVG behind a Drive id goes out as an opaque download, never as a page", async () => {
    for (const type of ["text/html", "image/svg+xml"]) {
      images = { doc: { body: new TextEncoder().encode("<script>1</script>").buffer as ArrayBuffer, contentType: type } };
      const res = await get("id=doc");
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("dl=1 still downloads a real photo under its own type", async () => {
    images = { photo: { body: new ArrayBuffer(3), contentType: "image/heif" } };
    const res = await get("id=photo&dl=1");
    expect(res.headers.get("content-type")).toBe("image/heif");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="DD-LEH-FLR-115-GRN-front.heic"');
  });

  it("still refuses anyone without a staff session", async () => {
    signedIn = null;
    const res = await get("id=photo");
    expect(res.status).toBe(401);
  });
});
