import { ENDPOINT_ID } from '@dsh-remote/protocol';

/** The remote end of a connection as QUIC authenticated it: an iroh EndpointId. */
export interface PeerIdentity {
  /** Ed25519 public key of the phone install, lowercase hex. Device grants bind to it. */
  readonly peerId: string;
}

export function isPeerId(value: string): boolean {
  return ENDPOINT_ID.test(value);
}

/** The first 10 hex digits, as iroh's `fmtShort` prints an id. */
export function shortPeerId(peerId: string): string {
  return peerId.slice(0, 10);
}
