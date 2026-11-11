import { describe, it, expect } from "vitest";
import { planMigrations, USAGE } from "./migration-plan.mjs";
import { devEnvFileMissing, DEV_ENV_FILE } from "./dev-env-guard.mjs";

// Audit round 2: a bare `npm run db:migrate` used to replay every migration,
// re-running old data backfills (0062 re-showed hidden SKUs, 0053 reset
// Coloured backgrounds, …). The whole chain now needs --all; --only keeps
// working exactly as before.

const FILES = [
  "0002_carts.sql",
  "0001_init.sql",
  "0053_bg_style.sql",
  "0054_a.sql",
  "0055_b.sql",
  "README.md",
];

describe("planMigrations", () => {
  it("applies nothing on a bare run and prints the usage", () => {
    expect(planMigrations(FILES, ["node", "apply-migration.mjs"])).toEqual({ error: USAGE });
    // --prod alone is a target, not a file list.
    expect(planMigrations(FILES, ["node", "apply-migration.mjs", "--prod"])).toEqual({ error: USAGE });
  });

  it("replays the whole chain, sorted, only with --all", () => {
    expect(planMigrations(FILES, ["node", "x", "--all"])).toEqual({
      mode: "all",
      files: ["0001_init.sql", "0002_carts.sql", "0053_bg_style.sql", "0054_a.sql", "0055_b.sql"],
    });
  });

  it("keeps --only=NNNN working, sorted, comma-separated", () => {
    expect(planMigrations(FILES, ["node", "x", "--only=0055,0054"])).toEqual({
      mode: "only",
      files: ["0054_a.sql", "0055_b.sql"],
    });
    expect(planMigrations(FILES, ["node", "x", "--only=0053_bg_style.sql", "--prod"])).toEqual({
      mode: "only",
      files: ["0053_bg_style.sql"],
    });
  });

  it("refuses an --only that matches nothing", () => {
    expect(planMigrations(FILES, ["node", "x", "--only=0099"])).toEqual({
      error: "--only=0099 matched no migration file.",
    });
  });

  it("refuses --all together with --only", () => {
    const plan = planMigrations(FILES, ["node", "x", "--all", "--only=0054"]);
    expect("error" in plan).toBe(true);
  });

  it("refuses --all on an empty folder", () => {
    expect("error" in planMigrations(["notes.md"], ["--all"])).toBe(true);
  });
});

describe("devEnvFileMissing", () => {
  // Without the dev file a dev run fell back to .env.local — PRODUCTION.
  it("flags a dev run with no dev env file", () => {
    expect(devEnvFileMissing("dev", () => false)).toBe(true);
  });

  it("lets a dev run through when the dev env file exists", () => {
    const seen: string[] = [];
    expect(devEnvFileMissing("dev", (p) => { seen.push(String(p)); return true; })).toBe(false);
    // Checked relative to the cwd, the same path dotenv loads.
    expect(seen).toEqual([DEV_ENV_FILE]);
  });

  it("never blocks a deliberate prod run", () => {
    expect(devEnvFileMissing("prod", () => false)).toBe(false);
  });
});
