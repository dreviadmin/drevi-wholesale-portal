import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPasswordFile, parseRotateArgs } from "./rotate-args.mjs";

describe("parseRotateArgs", () => {
  it("reads --only and --except in both the spaced and the = form", () => {
    for (const argv of [
      ["--prod", "--write", "--only", "Rakesh@drevifashion.com,jyoti@drevifashion.com"],
      ["--prod", "--write", "--only=Rakesh@drevifashion.com,jyoti@drevifashion.com"],
    ]) {
      expect(parseRotateArgs(argv)).toEqual({
        ok: true, prod: true, write: true, kill: false,
        only: ["rakesh@drevifashion.com", "jyoti@drevifashion.com"], except: [],
      });
    }
    expect(parseRotateArgs(["--except=ansh@drevifashion.com", "--kill-sessions"])).toMatchObject({
      ok: true, kill: true, only: null, except: ["ansh@drevifashion.com"],
    });
    expect(parseRotateArgs(["--except", "ansh@drevifashion.com"])).toMatchObject({ ok: true, except: ["ansh@drevifashion.com"] });
  });

  it("with no subset chooses everyone, as before", () => {
    expect(parseRotateArgs([])).toEqual({ ok: true, prod: false, write: false, kill: false, only: null, except: [] });
  });

  it("refuses --only / --except with no usable list instead of rotating everyone", () => {
    for (const argv of [["--write", "--only"], ["--only=", "--write"], ["--only", "--write"], ["--except="], ["--only=,,"]]) {
      const r = parseRotateArgs(argv);
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ error: expect.stringContaining("needs a comma-separated list") });
    }
  });

  it("refuses an argument it does not know", () => {
    for (const bad of ["--onyl=rakesh@drevifashion.com", "rakesh@drevifashion.com", "--write=yes", "-w"]) {
      expect(parseRotateArgs(["--prod", bad])).toEqual({ ok: false, error: `Unknown argument: ${bad}` });
    }
  });
});

describe("openPasswordFile", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("creates an owner-only file before any password, then adds each one as it comes", () => {
    dir = mkdtempSync(join(tmpdir(), "rotate-"));
    const path = join(dir, "staff-passwords.txt");
    const file = openPasswordFile(path, "Staff passwords (dev)");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("Staff passwords (dev)\n\n");
    file.add("Rakesh  rakesh@drevifashion.com  Amber-Lotus-1234");
    // On disk already, before the next person is rotated.
    expect(readFileSync(path, "utf8")).toBe("Staff passwords (dev)\n\nRakesh  rakesh@drevifashion.com  Amber-Lotus-1234\n");
    file.add("Jyoti  jyoti@drevifashion.com  Coral-River-5678");
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(4);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("never reuses a file that already exists", () => {
    dir = mkdtempSync(join(tmpdir(), "rotate-"));
    const path = join(dir, "staff-passwords.txt");
    writeFileSync(path, "old\n", { mode: 0o644 });
    expect(() => openPasswordFile(path, "Staff passwords (dev)")).toThrow();
    expect(readFileSync(path, "utf8")).toBe("old\n");
  });
});
