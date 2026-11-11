/**
 * Refuse a DEV run when the dev env file is missing.
 *
 * Most scripts load .env.local (PRODUCTION) first for shared credentials and
 * then let .env.development.local override it for a dev run. When the dev file
 * is absent — a fresh clone, the wholesale-portal-main checkout — nothing
 * overrides, so the run quietly reaches PRODUCTION while printing "DEV". An
 * audit (round 2) found `npm run db:migrate` doing exactly that: "Target: DEV"
 * on screen, SQL posted to the prod project. Stopping is the only safe answer.
 *
 * The path is relative to the working directory on purpose: it is the same
 * relative path dotenv resolves, so this checks the file dotenv would load.
 */
import { existsSync } from "node:fs";

export const DEV_ENV_FILE = ".env.development.local";

/** True when a dev run would fall back to production credentials. */
export function devEnvFileMissing(target, exists = existsSync) {
  return target === "dev" && !exists(DEV_ENV_FILE);
}

/**
 * Exit before any env file is loaded when a dev run has no dev env file.
 * `prodFlag` names the script's own opt-in for production (null when the
 * script is dev-only), so the message never suggests a flag it lacks.
 */
export function refuseDevWithoutEnvFile(target, prodFlag = "--prod") {
  if (!devEnvFileMissing(target)) return;
  console.error(
    `Target DEV, but ${DEV_ENV_FILE} is missing — refusing to run.\n` +
      "Without it this script would fall back to .env.local, which is PRODUCTION.\n" +
      `Create ${DEV_ENV_FILE} with the dev project's keys` +
      (prodFlag ? `, or pass ${prodFlag} deliberately.` : "."),
  );
  process.exit(1);
}
