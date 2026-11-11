import { describe, it, expect, vi, beforeEach } from "vitest";

// The buyer and staff account actions talk to Supabase, Next's request
// helpers and the audit log. Those are replaced with small fakes so the rules
// themselves (who may take which login, what an approval stamps, when a save
// reports failure) run for real against a recorded query log.

interface Call {
  table: string;
  op: "select" | "update" | "insert" | "delete";
  filters: Array<[string, string, unknown]>;
  payload?: unknown;
}
type Reply = { data?: unknown; error?: { message: string; code?: string } | null };

let respond: (c: Call) => Reply = () => ({});
let calls: Call[] = [];
const authAdmin = {
  listUsers: vi.fn(async () => ({ data: { users: [] as Array<{ id: string; email: string }> }, error: null })),
  createUser: vi.fn(async () => ({ data: { user: { id: "auth-new" } }, error: null })),
  updateUserById: vi.fn(async () => ({ error: null })),
};

function fakeAdmin() {
  return {
    auth: { admin: authAdmin },
    from(table: string) {
      const c: Call = { table, op: "select", filters: [] };
      const b: Record<string, unknown> = {};
      const chain = (fn: (...a: unknown[]) => void) => (...a: unknown[]) => { fn(...a); return b; };
      Object.assign(b, {
        select: chain(() => {}),
        update: chain((p) => { c.op = "update"; c.payload = p; }),
        insert: chain((p) => { c.op = "insert"; c.payload = p; }),
        delete: chain(() => { c.op = "delete"; }),
        eq: chain((k, v) => { c.filters.push(["eq", String(k), v]); }),
        neq: chain((k, v) => { c.filters.push(["neq", String(k), v]); }),
        not: chain((k, _op, v) => { c.filters.push(["not", String(k), v]); }),
        ilike: chain((k, v) => { c.filters.push(["ilike", String(k), v]); }),
        in: chain((k, v) => { c.filters.push(["in", String(k), v]); }),
        limit: chain(() => {}),
        order: chain(() => {}),
        maybeSingle: chain(() => {}),
        single: chain(() => {}),
        then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
          calls.push(c);
          return Promise.resolve({ data: null, error: null, ...respond(c) }).then(res, rej);
        },
      });
      return b;
    },
  };
}

const eqOf = (c: Call, k: string) => c.filters.find(([op, key]) => op === "eq" && key === k)?.[2];

const STAFF = { id: "staff-1", email: "rakesh@drevifashion.com", name: "Rakesh", role: "super_admin" as const };
const requireAdmin = vi.fn(async () => STAFF);
const writeAuditEvent = vi.fn(async (e: Record<string, unknown>) => { void e; });
const signOut = vi.fn(async (o?: unknown) => { void o; return { error: null }; });
const redirect = vi.fn();

vi.mock("next/headers", () => ({ headers: () => new Map<string, string>() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin() }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: () => ({ auth: { signOut } }) }));
vi.mock("@/lib/staff", () => ({ requireAdmin: () => requireAdmin(), requireStaff: () => requireAdmin() }));
vi.mock("@/lib/audit", () => ({ writeAuditEvent: (e: Record<string, unknown>) => writeAuditEvent(e) }));
vi.mock("@/lib/crypto", () => ({ encryptPassword: (p: string) => `enc:${p}`, decryptPassword: (c: string) => c.slice(4) }));
vi.mock("@/lib/password", () => ({ generateBuyerPassword: () => "Royal@4821", generateMemorablePassword: () => "maple-river-42" }));
vi.mock("@/lib/login-link", () => ({
  getOrCreateLoginToken: async () => ({ ok: false, error: "not in this test" }),
  resetLoginToken: async () => ({ ok: false, error: "not in this test" }),
  loginUrlFor: (t: string) => `https://example.test/go/${t}`,
}));
vi.mock("@/lib/storage", () => ({ uploadBuyerCardImage: async () => ({ ok: false }) }));
vi.mock("@/lib/contact", () => ({ WHOLESALE_PHONE: "+91 00000 00000" }));
// The real share module, so the login domain under test is the shipped one.
vi.mock("@/lib/share", async () => await import("../../lib/share"));

const buyers = await import("./buyers/actions");
const staffActions = await import("./staff/actions");
const { logout } = await import("../actions");

beforeEach(() => {
  calls = [];
  respond = () => ({});
  authAdmin.listUsers.mockClear();
  authAdmin.createUser.mockClear();
  authAdmin.updateUserById.mockClear();
  writeAuditEvent.mockClear();
  requireAdmin.mockImplementation(async () => STAFF);
  signOut.mockClear();
  redirect.mockClear();
});

describe("setCredentials: a buyer username may not be a staff username", () => {
  function world(staffEmails: string[]) {
    respond = (c) => {
      if (c.table === "buyers" && c.op === "select" && eqOf(c, "id") === "b1") return { data: { id: "b1", email: null } };
      if (c.table === "buyers" && c.op === "select") return { data: [] };
      if (c.table === "staff_users") return { data: staffEmails.includes(String(eqOf(c, "email"))) ? [{ id: "s9" }] : [] };
      return {};
    };
  }

  it("refuses sakshi@buyers… when sakshi@drevifashion.com is staff, before touching the login", async () => {
    world(["sakshi@drevifashion.com"]);
    const r = await buyers.setCredentials("b1", "Sakshi@buyers.drevifashion.com", "secret1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain('"sakshi" is a staff username');
    expect(authAdmin.listUsers).not.toHaveBeenCalled();
    expect(authAdmin.createUser).not.toHaveBeenCalled();
    expect(calls.some((c) => c.table === "buyers" && c.op === "update")).toBe(false);
  });

  it("allows a username no staff member has, and activates the buyer", async () => {
    world(["sakshi@drevifashion.com"]);
    const r = await buyers.setCredentials("b1", "royal@buyers.drevifashion.com", "secret1");
    expect(r.ok).toBe(true);
    expect(authAdmin.createUser).toHaveBeenCalledWith({ email: "royal@buyers.drevifashion.com", password: "secret1", email_confirm: true });
    const upd = calls.find((c) => c.table === "buyers" && c.op === "update");
    expect(upd?.payload).toMatchObject({ email: "royal@buyers.drevifashion.com", encrypted_password: "enc:secret1", status: "active" });
  });

  it("does not apply the username rule to an ordinary email", async () => {
    world(["sakshi@drevifashion.com"]);
    const r = await buyers.setCredentials("b1", "sakshi@gmail.com", "secret1");
    expect(r.ok).toBe(true);
    const staffLookups = calls.filter((c) => c.table === "staff_users").map((c) => eqOf(c, "email"));
    expect(staffLookups).toEqual(["sakshi@gmail.com"]);
  });
});

describe("addStaffUser: a staff email may not take over a buyer's username", () => {
  function world(buyerLogins: Array<{ email: string; business_name: string | null }>) {
    respond = (c) => {
      if (c.table === "staff_users" && c.op === "select") return { data: null };
      if (c.table === "buyers" && c.op === "select") {
        const hit = buyerLogins.filter((b) => b.email === eqOf(c, "email"));
        return { data: hit };
      }
      return {};
    };
  }

  it("refuses sakshi@drevifashion.com while a buyer signs in as sakshi", async () => {
    world([{ email: "sakshi@buyers.drevifashion.com", business_name: "Royal Sarees" }]);
    const r = await staffActions.addStaffUser({ name: "Sakshi", email: "Sakshi@drevifashion.com", role: "staff" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Royal Sarees already signs in as "sakshi" — use a different staff email.');
    expect(authAdmin.createUser).not.toHaveBeenCalled();
    expect(calls.some((c) => c.table === "staff_users" && c.op === "insert")).toBe(false);
    // The check only counts buyers who actually have a login.
    const q = calls.find((c) => c.table === "buyers" && eqOf(c, "email") === "sakshi@buyers.drevifashion.com");
    expect(q?.filters).toContainEqual(["not", "encrypted_password", null]);
  });

  it("creates the staff login when no buyer uses that username", async () => {
    world([{ email: "royal@buyers.drevifashion.com", business_name: "Royal Sarees" }]);
    const r = await staffActions.addStaffUser({ name: "Sakshi", email: "sakshi@drevifashion.com", role: "staff" });
    expect(r.ok).toBe(true);
    expect(r.password).toBe("maple-river-42");
    expect(authAdmin.createUser).toHaveBeenCalledOnce();
  });

  it("does not apply the username rule to a staff email on another domain", async () => {
    world([{ email: "sakshi@buyers.drevifashion.com", business_name: "Royal Sarees" }]);
    const r = await staffActions.addStaffUser({ name: "Sakshi", email: "sakshi@gmail.com", role: "staff" });
    expect(r.ok).toBe(true);
  });
});

describe("setBuyerStatus: Pending to Active is an approval", () => {
  function world(current: { status: string; encrypted_password: string | null }) {
    respond = (c) => (c.table === "buyers" && c.op === "select" ? { data: current } : {});
  }
  const statusUpdate = () => calls.find((c) => c.table === "buyers" && c.op === "update")?.payload as Record<string, unknown>;

  it("stamps who approved and when, and says so in the audit note", async () => {
    world({ status: "pending", encrypted_password: "enc:x" });
    const r = await buyers.setBuyerStatus("b1", "active");
    expect(r.ok).toBe(true);
    const p = statusUpdate();
    expect(p.status).toBe("active");
    expect(p.approved_by).toBe("staff-1");
    expect(typeof p.approved_at).toBe("string");
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "account_reactivated", notes: "approved from pending" }));
  });

  it("notes when the approved buyer has no login yet", async () => {
    world({ status: "pending", encrypted_password: null });
    await buyers.setBuyerStatus("b1", "active");
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ notes: "approved from pending (no login yet)" }));
  });

  it("leaves the original approval alone when reactivating a suspended buyer", async () => {
    world({ status: "suspended", encrypted_password: "enc:x" });
    await buyers.setBuyerStatus("b1", "active");
    const p = statusUpdate();
    expect(p).toEqual({ status: "active" });
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "account_reactivated", notes: null }));
  });

  it("suspending does not look up or stamp an approval", async () => {
    world({ status: "active", encrypted_password: "enc:x" });
    await buyers.setBuyerStatus("b1", "suspended", "unpaid");
    expect(statusUpdate()).toEqual({ status: "suspended" });
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "account_suspended", notes: "unpaid" }));
  });
});

describe("password changes report a stored copy that did not save", () => {
  function world(encWriteFails: boolean) {
    respond = (c) => {
      if (c.table === "buyers" && c.op === "select") return { data: { email: "royal@buyers.drevifashion.com", owner_name: "Raj", business_name: "Royal" } };
      if (c.table === "buyers" && c.op === "update") return encWriteFails ? { error: { message: "timeout" } } : {};
      return {};
    };
    authAdmin.listUsers.mockImplementationOnce(async () => ({ data: { users: [{ id: "auth-royal", email: "royal@buyers.drevifashion.com" }] }, error: null }));
  }

  // The login password has already changed by the time the stored copy is
  // written, so the change is logged either way, with a note when the stored
  // copy is stale.
  const STALE_NOTE = "login password changed; stored copy failed to save";

  it("regeneratePassword fails, hands back no password, and still logs the change when the stored copy fails", async () => {
    world(true);
    const r = await buyers.regeneratePassword("b1");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stored copy did not save/);
    expect(r.password).toBeUndefined();
    expect(authAdmin.updateUserById).toHaveBeenCalledWith("auth-royal", { password: "Royal@4821", email_confirm: true });
    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "credential_regenerated", buyerId: "b1", staffUserId: STAFF.id, notes: STALE_NOTE }),
    );
  });

  it("regeneratePassword returns the new password when both writes land", async () => {
    world(false);
    const r = await buyers.regeneratePassword("b1");
    expect(r).toEqual({ ok: true, password: "Royal@4821" });
    expect(authAdmin.updateUserById).toHaveBeenCalledWith("auth-royal", { password: "Royal@4821", email_confirm: true });
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "credential_regenerated", notes: null }));
  });

  it("changePassword fails with its own 'press Save again' message and still logs the change when the stored copy fails", async () => {
    world(true);
    const r = await buyers.changePassword("b1", "newpass1");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stored copy did not save/);
    expect(r.error).toMatch(/press Save again/);
    expect(r.password).toBeUndefined();
    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "credential_changed", buyerId: "b1", staffUserId: STAFF.id, notes: STALE_NOTE }),
    );
  });

  it("changePassword returns the new password and logs a plain change when both writes land", async () => {
    world(false);
    const r = await buyers.changePassword("b1", "newpass1");
    expect(r).toEqual({ ok: true, password: "newpass1" });
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "credential_changed", notes: null }));
  });
});

describe("addNote reports whether the note saved", () => {
  it("returns ok when the write lands", async () => {
    respond = () => ({});
    expect(await buyers.addNote("b1", "prefers COD")).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ table: "buyers", op: "update", payload: { notes: "prefers COD" } });
  });

  it("returns the database error when it does not", async () => {
    respond = () => ({ error: { message: "connection reset" } });
    expect(await buyers.addNote("b1", "prefers COD")).toEqual({ ok: false, error: "connection reset" });
  });

  it("refuses a non-admin without writing", async () => {
    requireAdmin.mockImplementationOnce(async () => { throw new Error("no"); });
    expect(await buyers.addNote("b1", "x")).toEqual({ ok: false, error: "Not authorized." });
    expect(calls).toHaveLength(0);
  });
});

describe("logout", () => {
  it("signs out this device only, then goes to the login page", async () => {
    await logout();
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(redirect).toHaveBeenCalledWith("/login");
  });
});
