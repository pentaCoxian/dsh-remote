import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { decodeBase64Url } from './keys.ts';

/**
 * ALPN of the push gateway: HTTP/1.1 over each bi-stream, like the host API.
 * Phones register device tokens there; hosts send sealed notifications to it.
 */
export const PUSH_ALPN = 'dsh-remote/push/1';

export type PushKind = 'approval' | 'turn.finished' | 'turn.failed' | 'test';
export type PushPlatform = 'apns' | 'fcm';

/** Which host events notify a phone. */
export interface PushEvents {
  readonly approval: boolean;
  readonly turnFinished: boolean;
  readonly turnFailed: boolean;
}

/** Approvals notify by default; finished and failed turns are opt-in. */
export const DEFAULT_PUSH_EVENTS: PushEvents = { approval: true, turnFinished: false, turnFailed: false };

/** One notification as the phone reads it after decryption. */
export interface PushMessage {
  readonly v: 1;
  /** Unique per notification; the phone drops repeats. */
  readonly id: string;
  readonly kind: PushKind;
  readonly hostId: string;
  readonly hostName: string;
  readonly sessionId?: string;
  readonly title: string;
  readonly body: string;
  readonly ts: number;
}

/** Text is clipped by UTF-8 bytes, so any script fits the same envelope size. */
export const PUSH_LIMITS = {
  titleBytes: 240,
  bodyBytes: 1000,
  hostNameBytes: 120,
  /** Plaintext is padded with spaces to a multiple of this, so lengths say little. */
  padBytes: 256,
  /** Fits APNs' and FCM's 4 KB payloads with room for the rest. */
  maxEnvelopeChars: 3072,
} as const;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Associated data: the envelope only opens for this host and this gateway handle. */
export function pushAad(hostId: string, handle: string): Buffer {
  return Buffer.from(`${PUSH_ALPN}\n${hostId}\n${handle}`, 'utf8');
}

/** At most `maxBytes` of UTF-8, cut on a character boundary and marked with an ellipsis. */
function clip(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let kept = '';
  let bytes = 3; // the ellipsis
  for (const char of text) {
    bytes += Buffer.byteLength(char, 'utf8');
    if (bytes > maxBytes) break;
    kept += char;
  }
  return `${kept}…`;
}

/**
 * Seal `message` with the phone's 32-byte push key: AES-256-GCM, a random
 * 12-byte nonce, space-padded JSON. Returns base64url(nonce ‖ ciphertext ‖ tag).
 */
export function sealPush(key: Uint8Array, handle: string, message: PushMessage, nonce: Uint8Array = randomBytes(NONCE_BYTES)): string {
  if (key.length !== 32) throw new Error('push key must be 32 bytes');
  if (nonce.length !== NONCE_BYTES) throw new Error('push nonce must be 12 bytes');
  const clipped = { ...message, hostName: clip(message.hostName, PUSH_LIMITS.hostNameBytes), title: clip(message.title, PUSH_LIMITS.titleBytes), body: clip(message.body, PUSH_LIMITS.bodyBytes) };
  const json = Buffer.from(JSON.stringify(clipped), 'utf8');
  const padded = Buffer.alloc(Math.ceil(json.length / PUSH_LIMITS.padBytes) * PUSH_LIMITS.padBytes, 0x20);
  json.copy(padded);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(pushAad(message.hostId, handle));
  const sealed = Buffer.concat([Buffer.from(nonce), cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  return sealed.toString('base64url');
}

/** Open an envelope from `hostId`; undefined when it is not authentic or not a notification. */
export function openPush(key: Uint8Array, hostId: string, handle: string, envelope: string): PushMessage | undefined {
  const sealed = decodeBase64Url(envelope);
  if (sealed === undefined || sealed.length < NONCE_BYTES + TAG_BYTES || key.length !== 32) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, NONCE_BYTES));
    decipher.setAAD(pushAad(hostId, handle));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)), decipher.final()]);
    const message = JSON.parse(plain.toString('utf8')) as PushMessage;
    return message?.v === 1 && message.hostId === hostId ? message : undefined;
  } catch {
    return undefined;
  }
}
