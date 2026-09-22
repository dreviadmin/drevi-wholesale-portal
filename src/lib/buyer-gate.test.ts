import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The buyer catalog gate (0062) rests on one property that no type can express:
// the sheet sync must never name buyer_visible. wholesale_visible is hardcoded
// true at sync.ts for every sheet row and re-stamped every 10 minutes, and on
// prod 183 of the 289 visible SKUs got there that way with no lock on them. If
// buyer_visible ever joins that payload, "the catalog is what Studio pushed"
// stops being true within one cron tick and nothing else in the suite notices.
//
// Guard tests like this one are the house pattern for invariants that live
// between files — see backup-tables.test.ts.

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
/** Source with comments stripped — these files EXPLAIN which flag they use and
 *  why, so a raw substring match reads the explanation as a violation. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("buyer catalog gate", () => {
  it("the sheet sync never writes buyer_visible", () => {
    expect(code("src/lib/sync.ts")).not.toContain("buyer_visible");
  });

  it("only a Studio wholesale push and the staff toggle turn it on", () => {
    // Anything under src/ that WRITES the column, as opposed to reading it in a
    // filter. Update this list deliberately — a new writer is a new way for the
    // catalog to fill up with things nobody pushed.
    const allowed = new Set([
      "src/lib/studio/publish.ts",                      // publishWholesale
      "src/app/admin/manage-catalog/actions.ts",        // staff pull it back
    ]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { walk(rel); continue; }
        if (!/\.(ts|tsx)$/.test(e.name) || e.name.endsWith(".test.ts")) continue;
        const src = code(rel);
        // A write looks like `buyer_visible: <value>` inside an object literal;
        // a read looks like .eq("buyer_visible", …) or product.buyer_visible.
        if (/\bbuyer_visible\s*:/.test(src) && !allowed.has(rel)) offenders.push(rel);
      }
    };
    walk("src");
    // types.ts declares the field on the interface, which is a declaration and
    // not a write — exclude it by shape rather than by name.
    expect(offenders.filter((f) => f !== "src/lib/types.ts")).toEqual([]);
  });

  it("the buyer surfaces gate on buyer_visible, not the ops flag", () => {
    for (const f of [
      "src/app/catalog/page.tsx",
      "src/app/product/[sku]/page.tsx",
      "src/lib/buyer-home.ts",
      "src/lib/cart.ts",
      "src/app/cart/actions.ts",
    ]) {
      expect(code(f), `${f} still reads wholesale_visible`).not.toContain("wholesale_visible");
    }
  });

  it("billing and shop-floor screens are left on the ops flag", () => {
    // The owner's constraint: "it must not stop billing - even for unpushed
    // products". These read wholesale_visible, which stays true for every sheet
    // row, so the decoupling cannot reach them.
    for (const f of [
      "src/app/admin/exhibition/[id]/page.tsx",
      "src/app/admin/exhibition/actions.ts",
      "src/app/admin/orders/actions.ts",
      "src/app/admin/price-check/page.tsx",
    ]) {
      expect(code(f), `${f} must not depend on the buyer gate`).not.toContain("buyer_visible");
    }
  });
});
