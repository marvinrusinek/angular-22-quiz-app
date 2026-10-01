import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts/decrypts the ONE thing in this feature that must survive a retry
 * byte-for-byte but can never be re-derived from what is durably stored
 * elsewhere: a claimant_verify row's rendered email payload, including its
 * raw (unhashed) verification token. See migration 009's encrypted_payload
 * column comment and certificate-notification-dispatcher.ts for why this
 * exists at all — in short, the intended provider (Resend) rejects a
 * retried idempotency key whose payload differs from the original, so a
 * retry must resend EXACTLY what was sent before, not a freshly-minted
 * token under the same key.
 *
 * AES-256-GCM: authenticated encryption, so a wrong key (e.g. after a
 * rotation) or corrupted ciphertext fails LOUDLY inside this module and is
 * reported as `null` to the caller — never silently decrypts to garbage.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const KEY_LENGTH_BYTES = 32;

/**
 * CERTIFICATE_OUTBOX_ENCRYPTION_KEY must be exactly 64 hex characters (32
 * bytes) — generate one with `openssl rand -hex 32` or
 * `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
 * Throws rather than silently truncating/padding a wrong-length key, which
 * would otherwise produce a key that "works" but is weaker than intended.
 */
export function parseOutboxEncryptionKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptOutboxPayload(key: Buffer, data: unknown): string {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`outbox encryption key must be ${KEY_LENGTH_BYTES} bytes, got ${key.length}`);
  }
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/**
 * Returns `null` — never throws — on any failure: wrong key (rotation),
 * truncated/corrupted data, or a tampered auth tag. The dispatcher treats
 * `null` as "no usable stored payload" and falls back to minting a fresh
 * one, which is always safe, just not free (see its own doc comment).
 */
export function decryptOutboxPayload<T>(key: Buffer, encoded: string): T | null {
  try {
    const raw = Buffer.from(encoded, 'base64');
    const iv = raw.subarray(0, IV_LENGTH_BYTES);
    const authTag = raw.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
    const ciphertext = raw.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  } catch {
    return null;
  }
}
