import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

const B64URL = /^[A-Za-z0-9_-]+$/;

export function decodeBase64Url(text: string): Buffer | undefined {
  if (!B64URL.test(text)) return undefined;
  const bytes = Buffer.from(text, 'base64url');
  // Reject non-canonical encodings so one key or signature has exactly one spelling.
  return bytes.toString('base64url') === text ? bytes : undefined;
}

/** Lowercase hex SHA-256 of a SPKI DER public key. */
export function spkiFingerprint(spkiDer: Uint8Array): string {
  return createHash('sha256').update(spkiDer).digest('hex');
}

/** First 16 hex digits in groups of four, for people comparing two screens. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 16).replace(/(.{4})(?!$)/g, '$1 ');
}

/**
 * Import a base64url SPKI DER key and require it to be P-256.
 * @returns the key and its fingerprint, or undefined for anything else.
 */
export function importP256PublicKey(spkiBase64Url: string): { key: KeyObject; fingerprint: string } | undefined {
  const der = decodeBase64Url(spkiBase64Url);
  if (der === undefined) return undefined;
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return undefined;
    const canonical = key.export({ format: 'der', type: 'spki' });
    if (!canonical.equals(der)) return undefined;
    return { key, fingerprint: spkiFingerprint(der) };
  } catch {
    return undefined;
  }
}

/**
 * Verify a base64url DER-encoded ECDSA P-256 / SHA-256 signature over UTF-8 text.
 * @returns false for any malformed input instead of throwing.
 */
export function verifyP256Signature(key: KeyObject, text: string, signatureBase64Url: string): boolean {
  const signature = decodeBase64Url(signatureBase64Url);
  if (signature === undefined || signature.length < 8 || signature.length > 72) return false;
  try {
    return verify('sha256', Buffer.from(text, 'utf8'), { key, dsaEncoding: 'der' }, signature);
  } catch {
    return false;
  }
}
