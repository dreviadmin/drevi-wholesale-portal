import "server-only";

import crypto from "node:crypto";
import { getEnv } from "@/lib/env";

// AES-256-GCM at-rest encryption for buyer passwords (CLAUDE.md → Security).
// Payload layout: base64( iv[12] | authTag[16] | ciphertext ). The master key
// is PORTAL_PASSWORD_MASTER_KEY (32 bytes, base64). Used ONLY by admin-gated
// server routes — never on the client, never logged.

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function masterKey(): Buffer {
  const key = Buffer.from(getEnv("PORTAL_PASSWORD_MASTER_KEY"), "base64");
  if (key.length !== 32) {
    throw new Error("PORTAL_PASSWORD_MASTER_KEY must decode to 32 bytes (base64-encoded AES-256 key).");
  }
  return key;
}

export function encryptPassword(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptPassword(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
