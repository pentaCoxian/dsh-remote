/** What a pairing QR carries. No field is a credential. */
export interface PairingPayload {
  /** iroh EndpointTicket: the host's EndpointId plus its relay and direct addresses. */
  readonly ticket: string;
  readonly challengeId: string;
  /** Session to open after pairing, when the QR came from `/rc` in a session. */
  readonly sessionId?: string;
  /** Display name for the confirm screen; untrusted until the host answers. */
  readonly hostName?: string;
}

/** iroh EndpointId: an Ed25519 public key in lowercase hex. It is also the host id. */
export const ENDPOINT_ID = /^[0-9a-f]{64}$/;
/** iroh EndpointTicket text form. */
export const TICKET = /^endpoint[a-z2-7]{52,1500}$/;
const CHALLENGE_ID = /^chl_[A-Za-z0-9_-]{22,64}$/;
const SESSION_ID = /^[\x21-\x7e]{1,200}$/;
const HOST_NAME = /^[^\x00-\x1f\x7f]{1,64}$/u;
const KEYS = ['v', 't', 'c', 's', 'n'];

/**
 * Pairing QR text, `dshremote://pair?v=2&t=<ticket>&c=<challenge>[&s=<session>][&n=<name>]`.
 * The phone dials the ticket's EndpointId, so QUIC pins the host from the first byte.
 */
export function buildPairingUrl(payload: PairingPayload): string {
  if (!TICKET.test(payload.ticket) || !CHALLENGE_ID.test(payload.challengeId)) throw new Error('pairing: invalid ticket or challenge id');
  const params = new URLSearchParams({ v: '2', t: payload.ticket, c: payload.challengeId });
  if (payload.sessionId !== undefined) params.set('s', payload.sessionId);
  if (payload.hostName !== undefined) params.set('n', payload.hostName);
  return `dshremote://pair?${params.toString()}`;
}

export function parsePairingUrl(text: string): PairingPayload | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'dshremote:' || url.host !== 'pair' || url.pathname !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    return undefined;
  }
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (params.getAll(key).length !== 1 || !KEYS.includes(key)) return undefined;
  }
  if (params.get('v') !== '2') return undefined;
  const ticket = params.get('t') ?? '';
  const challengeId = params.get('c') ?? '';
  const sessionId = params.get('s');
  const hostName = params.get('n');
  if (!TICKET.test(ticket) || !CHALLENGE_ID.test(challengeId)) return undefined;
  if (sessionId !== null && !SESSION_ID.test(sessionId)) return undefined;
  if (hostName !== null && !HOST_NAME.test(hostName)) return undefined;
  return { ticket, challengeId, ...(sessionId === null ? {} : { sessionId }), ...(hostName === null ? {} : { hostName }) };
}
