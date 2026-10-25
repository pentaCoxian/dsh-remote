import { createHash } from 'node:crypto';

/** First line of every signed request string. */
export const SIGNING_PREFIX = 'DSH-REMOTE-V1';

/** The six fields the phone signs for one HTTP request or WebSocket upgrade. */
export interface CanonicalRequest {
  /** Uppercase HTTP method exactly as sent. */
  readonly method: string;
  /** Raw origin-form request target: path plus query, exactly as sent. */
  readonly target: string;
  /** Lowercase hex SHA-256 of the exact body bytes (of the empty string when there is no body). */
  readonly bodySha256Hex: string;
  /** Unix milliseconds from `X-DSH-Timestamp`. */
  readonly timestampMs: number;
  /** base64url nonce from `X-DSH-Nonce`. */
  readonly nonce: string;
}

const METHOD = /^[A-Z]{3,7}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** 16 to 48 random bytes in unpadded base64url. */
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
const TIMESTAMP = /^(0|[1-9][0-9]{0,15})$/;

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export const EMPTY_BODY_SHA256 = sha256Hex('');

export function isValidNonce(nonce: string): boolean {
  return NONCE.test(nonce);
}

/**
 * Parse `X-DSH-Timestamp`: a plain decimal integer with no sign, padding or exponent.
 * @returns the timestamp, or undefined when the header text is not canonical.
 */
export function parseTimestamp(text: string): number | undefined {
  if (!TIMESTAMP.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Build the exact string a device signs (spec §5): six lines joined with LF, no trailing LF.
 * @throws when a field could make the string ambiguous.
 */
export function canonicalRequestString(request: CanonicalRequest): string {
  if (!METHOD.test(request.method)) throw new Error('canonical request: method must be uppercase letters');
  if (!request.target.startsWith('/') || /[\s\x00-\x1f\x7f]/.test(request.target)) {
    throw new Error('canonical request: target must be an origin-form path without whitespace');
  }
  if (!HEX64.test(request.bodySha256Hex)) throw new Error('canonical request: body hash must be lowercase hex SHA-256');
  if (!Number.isSafeInteger(request.timestampMs) || request.timestampMs < 0) throw new Error('canonical request: invalid timestamp');
  if (!isValidNonce(request.nonce)) throw new Error('canonical request: invalid nonce');
  return [SIGNING_PREFIX, request.method, request.target, request.bodySha256Hex, String(request.timestampMs), request.nonce].join('\n');
}
