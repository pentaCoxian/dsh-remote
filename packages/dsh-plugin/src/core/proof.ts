import type { KeyObject } from 'node:crypto';
import {
  canonicalRequestString,
  importP256PublicKey,
  isValidNonce,
  LIMITS,
  parseTimestamp,
  PENDING_DEVICE_ID,
  PROTOCOL_VERSION,
  sha256Hex,
  verifyP256Signature,
  type ErrorCode,
  type Scope,
} from '@dsh-remote/protocol';
import type { Clock } from './clock.ts';
import { NonceCache } from './limits.ts';
import type { PeerIdentity } from './peer.ts';
import type { DeviceRecord, HostState } from './state.ts';

/** The `X-DSH-*` header values of one request, each present at most once. */
export interface ProofHeaders {
  readonly protocol: string | undefined;
  readonly deviceId: string | undefined;
  readonly timestamp: string | undefined;
  readonly nonce: string | undefined;
  readonly signature: string | undefined;
}

export interface SignedRequest {
  readonly method: string;
  /** Raw origin-form target exactly as received. */
  readonly target: string;
  readonly body: Uint8Array;
  readonly headers: ProofHeaders;
  readonly identity: PeerIdentity;
}

export type ProofFailure = { readonly ok: false; readonly code: ErrorCode; readonly serverTime?: number };
export type DeviceProof = { readonly ok: true; readonly device: DeviceRecord } | ProofFailure;
export type KeyProof = { readonly ok: true } | ProofFailure;

const DEVICE_ID = /^dev_[A-Za-z0-9_-]{16,64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Verifies the per-device request proof of spec §5 on top of the peer
 * identity QUIC already authenticated. The two keys back each other: the iroh
 * key lives in app storage, the request key in the phone's secure hardware.
 * Order: cheap shape checks, timestamp, grant, then
 * the signature; the nonce is remembered only after the signature verifies.
 */
export class ProofVerifier {
  private readonly nonces = new NonceCache(LIMITS.nonceTtlMs);

  /**
   * @param bootMs - process start. Signatures made before it are refused, so a
   *   request captured before a restart cannot be replayed after it even though
   *   the nonce table is in memory only.
   */
  private readonly state: HostState;
  private readonly clock: Clock;
  private readonly bootMs: number;

  constructor(
    state: HostState,
    clock: Clock,
    bootMs: number,
  ) {
    this.state = state;
    this.clock = clock;
    this.bootMs = bootMs;
  }

  /** Proof for a paired device: grant lookup, peer binding, signature, nonce, scope. */
  verifyDevice(request: SignedRequest, scope: Scope): DeviceProof {
    const shape = this.checkShape(request);
    if (!shape.ok) return shape;
    const deviceId = request.headers.deviceId;
    if (deviceId === undefined || !DEVICE_ID.test(deviceId)) return { ok: false, code: 'DEVICE_UNPAIRED' };
    const device = this.state.device(deviceId);
    if (device === undefined) return { ok: false, code: 'DEVICE_UNPAIRED' };
    if (device.revokedAt !== null) return { ok: false, code: 'DEVICE_REVOKED' };
    if (device.expiresAt <= this.clock.now()) return { ok: false, code: 'DEVICE_UNPAIRED' };
    if (device.peerId !== request.identity.peerId) return { ok: false, code: 'ACCESS_DENIED' };
    const key = importP256PublicKey(device.publicKey);
    if (key === undefined) return { ok: false, code: 'DEVICE_UNPAIRED' };
    const signed = this.checkSignature(request, key.key, `${deviceId}:${request.headers.nonce}`);
    if (!signed.ok) return signed;
    if (!device.scopes.includes(scope)) return { ok: false, code: 'SCOPE_DENIED' };
    this.state.touchDevice(deviceId);
    return { ok: true, device };
  }

  /** Proof of possession for a key that has no grant yet (pair redeem and status). */
  verifyPendingKey(request: SignedRequest, key: KeyObject, fingerprint: string): KeyProof {
    const shape = this.checkShape(request);
    if (!shape.ok) return shape;
    if (request.headers.deviceId !== PENDING_DEVICE_ID) return { ok: false, code: 'BAD_REQUEST' };
    return this.checkSignature(request, key, `${PENDING_DEVICE_ID}:${fingerprint}:${request.headers.nonce}`);
  }

  private checkShape(request: SignedRequest): KeyProof {
    const { headers } = request;
    if (headers.protocol !== String(PROTOCOL_VERSION)) return { ok: false, code: 'PROTOCOL_UNSUPPORTED' };
    if (headers.timestamp === undefined || headers.nonce === undefined || headers.signature === undefined) {
      return { ok: false, code: 'SIGNATURE_INVALID' };
    }
    if (!isValidNonce(headers.nonce) || !SIGNATURE.test(headers.signature)) return { ok: false, code: 'SIGNATURE_INVALID' };
    const timestamp = parseTimestamp(headers.timestamp);
    if (timestamp === undefined) return { ok: false, code: 'SIGNATURE_INVALID' };
    const now = this.clock.now();
    if (Math.abs(now - timestamp) > LIMITS.timestampWindowMs || timestamp < this.bootMs) {
      return { ok: false, code: 'TIMESTAMP_SKEW', serverTime: now };
    }
    return { ok: true };
  }

  private checkSignature(request: SignedRequest, key: KeyObject, nonceKey: string): KeyProof {
    let canonical: string;
    try {
      canonical = canonicalRequestString({
        method: request.method,
        target: request.target,
        bodySha256Hex: sha256Hex(request.body),
        timestampMs: Number(request.headers.timestamp),
        nonce: request.headers.nonce!,
      });
    } catch {
      return { ok: false, code: 'SIGNATURE_INVALID' };
    }
    if (!verifyP256Signature(key, canonical, request.headers.signature!)) return { ok: false, code: 'SIGNATURE_INVALID' };
    if (!this.nonces.remember(nonceKey, this.clock.now())) return { ok: false, code: 'NONCE_REPLAYED' };
    return { ok: true };
  }
}
