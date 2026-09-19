import { describe, expect, it } from "vitest";
import { attachmentHeader, safeStem } from "./attachment-name";

// A filename is a header value — these cases are the reason this module exists.
describe("safeStem", () => {
  it("keeps the name an operator recognises", () => {
    expect(safeStem("DD-LEH-FLR-115-GRN-front-production")).toBe("DD-LEH-FLR-115-GRN-front-production");
  });
  it("cannot inject a header", () => {
    expect(safeStem('front"\r\nSet-Cookie: a=b')).toBe("front-Set-Cookie-a-b");
    expect(safeStem("front; filename=evil.sh")).toBe("front-filename-evil.sh");
  });
  it("survives a colour name nobody sanitised on the way in", () => {
    expect(safeStem("DD-SAR-115-Rani Pink/Gold-front-source")).toBe("DD-SAR-115-Rani-Pink-Gold-front-source");
    expect(safeStem("साड़ी")).toBe("drevi-photo"); // nothing ASCII survives → fallback, never an empty name
  });
  it("is bounded and never ends in punctuation", () => {
    expect(safeStem("x".repeat(400)).length).toBe(100);
    expect(safeStem("front-".repeat(20)).endsWith("-")).toBe(false);
  });
});

describe("attachmentHeader", () => {
  it("extends by what was actually streamed, not by the ref", () => {
    expect(attachmentHeader("front-source", "image/png")).toBe('attachment; filename="front-source.png"');
    expect(attachmentHeader("front-source", "image/jpeg; charset=binary")).toBe('attachment; filename="front-source.jpg"');
    expect(attachmentHeader("front-source", "application/octet-stream")).toBe('attachment; filename="front-source.jpg"');
  });
});
