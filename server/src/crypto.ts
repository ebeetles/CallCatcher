import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.ts";

/**
 * At-rest encryption for stored secrets (tenant Twilio subaccount tokens).
 * AES-256-GCM keyed by SECRETS_KEY (64 hex chars = 32 bytes). Format:
 * "v1:<iv>:<tag>:<ciphertext>" (hex fields).
 */

export function secretsConfigured(): boolean {
  return /^[0-9a-fA-F]{64}$/.test(config.secretsKey);
}

function key(): Buffer {
  if (!secretsConfigured()) {
    throw new Error("SECRETS_KEY missing or malformed (need 64 hex chars — generate with `openssl rand -hex 32`)");
  }
  return Buffer.from(config.secretsKey, "hex");
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ct.toString("hex")}`;
}

export function decryptSecret(stored: string): string {
  const [v, ivHex, tagHex, ctHex] = stored.split(":");
  if (v !== "v1" || !ivHex || !tagHex || !ctHex) throw new Error("malformed secret ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
}
