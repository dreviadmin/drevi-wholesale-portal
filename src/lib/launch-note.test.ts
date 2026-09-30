import { describe, it, expect } from "vitest";
import { launchNote, parseLaunchNote } from "./launch-note";

describe("launch audit notes", () => {
  it("round-trips every form the senders write", () => {
    for (const kind of ["greeting", "login"] as const) {
      for (const admin of [false, true]) {
        for (const unconfirmed of [false, true]) {
          const note = launchNote(kind, "one-tap login sent over WhatsApp (AiSensy) to +919812345678", { admin, unconfirmed });
          expect(parseLaunchNote(note)).toEqual({ kind, unconfirmed });
        }
      }
    }
  });

  it("ignores notes that are not launch sends", () => {
    for (const n of ["WhatsApp", "Copy", "login link · Copy", "credentials sent over WhatsApp to 98…", "launched", "launch loginX: x", null, undefined, ""]) {
      expect(parseLaunchNote(n)).toBeNull();
    }
  });
});
