import type { Scope } from './constants.ts';

/** What a pairing QR carries. No field is a credential. */
export interface PairingPayload {
  /** Canonical https origin of the Access-protected API host. */
  readonly origin: string;
  readonly hostId: string;
  readonly challengeId: string;
  /** Fingerprint of the host identity key the phone must see again in the grant. */
  readonly hostKeyFingerprint: string;
  /** Session to open after pairing, when the QR came from `/rc` in a session. */
  readonly sessionId?: string;
}

const HOST_ID = /^host_[A-Za-z0-9_-]{16,64}$/;
const CHALLENGE_ID = /^chl_[A-Za-z0-9_-]{22,64}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const SESSION_ID = /^[\x21-\x7e]{1,200}$/;

/** A bare `https://host[:port]` origin with nothing after it. */
export function canonicalHttpsOrigin(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
  if (url.origin !== text) return undefined;
  return url.origin;
}

/**
 * Pairing URL on the public link host. The payload sits in the fragment, which
 * browsers never send, so the link host never sees it.
 */
export function buildPairingUrl(linkOrigin: string, payload: PairingPayload): string {
  if (canonicalHttpsOrigin(linkOrigin) === undefined) throw new Error('pairing: link origin must be a bare https origin');
  const params = new URLSearchParams({
    v: '1',
    o: payload.origin,
    h: payload.hostId,
    c: payload.challengeId,
    f: payload.hostKeyFingerprint,
  });
  if (payload.sessionId !== undefined) params.set('s', payload.sessionId);
  return `${linkOrigin}/p#${params.toString()}`;
}

export function parsePairingUrl(text: string): PairingPayload | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.pathname !== '/p' || url.search !== '') return undefined;
  const params = new URLSearchParams(url.hash.slice(1));
  for (const key of params.keys()) {
    if (params.getAll(key).length !== 1 || !['v', 'o', 'h', 'c', 'f', 's'].includes(key)) return undefined;
  }
  if (params.get('v') !== '1') return undefined;
  const origin = canonicalHttpsOrigin(params.get('o') ?? '');
  const hostId = params.get('h') ?? '';
  const challengeId = params.get('c') ?? '';
  const hostKeyFingerprint = params.get('f') ?? '';
  const sessionId = params.get('s');
  if (origin === undefined || !HOST_ID.test(hostId) || !CHALLENGE_ID.test(challengeId) || !FINGERPRINT.test(hostKeyFingerprint)) {
    return undefined;
  }
  if (sessionId !== null && !SESSION_ID.test(sessionId)) return undefined;
  return { origin, hostId, challengeId, hostKeyFingerprint, ...(sessionId === null ? {} : { sessionId }) };
}

/** Fields of a device grant covered by the host signature. */
export interface GrantFields {
  readonly hostId: string;
  readonly pairingRequestId: string;
  readonly deviceId: string;
  readonly deviceKeyFingerprint: string;
  readonly scopes: readonly Scope[];
  readonly expiresAt: number;
}

/**
 * The string the host identity key signs when it issues a grant. The phone
 * verifies it with the host key whose fingerprint the QR showed, which binds
 * the grant to this host, this pairing request and this phone's own key.
 */
export function grantSigningString(grant: GrantFields): string {
  return [
    'DSH-REMOTE-V1-GRANT',
    grant.hostId,
    grant.pairingRequestId,
    grant.deviceId,
    grant.deviceKeyFingerprint,
    [...grant.scopes].sort().join(','),
    String(grant.expiresAt),
  ].join('\n');
}
