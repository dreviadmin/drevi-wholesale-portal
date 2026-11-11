import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { GATING_ROWS_FILTER, gatingStatusesAllow, rowGatesBuyer, sameEmailAllowsBuyer, type SameEmailRow } from "./buyer-access";

const STATUSES = ["pending", "active", "suspended", "rejected"];
const me: SameEmailRow = { status: "active", hasLogin: true };

describe("buyer gate, duplicate emails", () => {
  it("lets a lone active buyer in", () => {
    expect(sameEmailAllowsBuyer([me])).toBe(true);
  });

  it("ignores a pending row with no login — the public inquiry lockout", () => {
    expect(sameEmailAllowsBuyer([me, { status: "pending", hasLogin: false }])).toBe(true);
  });

  it("still blocks on a suspended or rejected duplicate", () => {
    for (const status of ["suspended", "rejected"]) {
      expect(sameEmailAllowsBuyer([me, { status, hasLogin: false }]), status).toBe(false);
    }
  });

  it("blocks when nothing that gates is left", () => {
    expect(sameEmailAllowsBuyer([])).toBe(false);
    expect(sameEmailAllowsBuyer([{ status: "pending", hasLogin: false }])).toBe(false);
    expect(gatingStatusesAllow([])).toBe(false);
  });

  it("a pending row WITH a login gates (it is someone's account awaiting approval)", () => {
    expect(rowGatesBuyer({ status: "pending", hasLogin: true })).toBe(true);
    expect(sameEmailAllowsBuyer([{ status: "pending", hasLogin: true }])).toBe(false);
  });
});

// The session-client reads (middleware, resolveActiveRole, the login action)
// filter in PostgREST instead of calling rowGatesBuyer, so the two must agree
// on every row. A tiny evaluator for the filter's own grammar — just enough for
// "col.op.value" and "col.not.is.null" terms, OR'd — pins that.
function filterKeeps(filter: string, row: { status: string; encrypted_password: string | null }): boolean {
  return filter.split(",").some((term) => {
    const [col, ...rest] = term.split(".");
    const value = (row as Record<string, string | null>)[col];
    const op = rest.join(".");
    if (op === "not.is.null") return value !== null;
    if (op === "is.null") return value === null;
    if (op.startsWith("neq.")) return value !== null && value !== op.slice(4);
    if (op.startsWith("eq.")) return value === op.slice(3);
    throw new Error(`filterKeeps does not understand "${term}" — extend it with the filter`);
  });
}

describe("GATING_ROWS_FILTER", () => {
  it("keeps exactly the rows rowGatesBuyer says gate", () => {
    for (const status of STATUSES) {
      for (const hasLogin of [true, false]) {
        const kept = filterKeeps(GATING_ROWS_FILTER, { status, encrypted_password: hasLogin ? "ciphertext" : null });
        expect(kept, `${status}/${hasLogin ? "login" : "no login"}`).toBe(rowGatesBuyer({ status, hasLogin }));
      }
    }
  });

  it("is what middleware and resolveActiveRole actually read with", () => {
    // Guard in the style of buyer-gate.test.ts: the rule only holds if every
    // gate applies it, and a gate that drops the filter goes back to letting a
    // stray inquiry lock buyers out.
    for (const f of ["src/middleware.ts", "src/lib/supabase/server.ts", "src/app/login/actions.ts"]) {
      const src = fs.readFileSync(path.join(process.cwd(), f), "utf8");
      expect(src, f).toContain(".or(GATING_ROWS_FILTER)");
    }
  });
});
