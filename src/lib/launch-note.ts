// The audit-log note on every WhatsApp login send, written and read in one
// place. scripts/send-launch.mjs reads these back to decide who has already
// had which message, so the writer and the parser must never drift apart
// (they did once: "launch login: …".split(" ")[1] is "login:", which matched
// nothing and left a lost state file as the only guard against a double send).

export type LaunchKind = "greeting" | "login";

/**
 * `launch <kind>[ (admin)][ (unconfirmed)]: <detail>`. "(admin)" marks the
 * buyers-page bulk send; "(unconfirmed)" a send that timed out, so it may or
 * may not have reached the buyer — still treated as sent unless retried.
 */
export function launchNote(kind: LaunchKind, detail: string, opts: { admin?: boolean; unconfirmed?: boolean } = {}): string {
  return `launch ${kind}${opts.admin ? " (admin)" : ""}${opts.unconfirmed ? " (unconfirmed)" : ""}: ${detail}`;
}

export function parseLaunchNote(notes: string | null | undefined): { kind: LaunchKind; unconfirmed: boolean } | null {
  const m = /^launch (greeting|login)\b([^:]*):/.exec(notes ?? "");
  if (!m) return null;
  return { kind: m[1] as LaunchKind, unconfirmed: m[2].includes("(unconfirmed)") };
}
