import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for saved browser sessions (cookies are as sensitive as passwords).
 * Key = SHA-256 of LIFE_SECRET. Output: base64(iv | tag | ciphertext).
 */
function key(secret: string) {
  if (!secret || secret.length < 16) throw new Error("LIFE_SECRET must be set (16+ characters) to store browser sessions");
  return createHash("sha256").update(secret).digest();
}

export function encrypt(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function decrypt(blob: string, secret: string): string {
  const buf = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", key(secret), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}
