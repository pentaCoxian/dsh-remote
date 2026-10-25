import type { KeyObject } from 'node:crypto';
import { importP256PublicKey, LIMITS, SCOPES, type ErrorCode, type Scope } from '@dsh-remote/protocol';
import type { Clock } from './clock.ts';
import { randomId } from './ids.ts';
import { RateLimiter } from './limits.ts';
import type { PeerIdentity } from './peer.ts';
import type { KeyProof } from './proof.ts';
import type { DeviceRecord, HostState } from './state.ts';

export interface Challenge {
  readonly challengeId: string;
  readonly sessionId?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  used: boolean;
  failures: number;
}

/** Unsigned: it reaches the phone over the QUIC connection that authenticated `hostId`. */
export interface DeviceGrant {
  readonly hostId: string;
  readonly deviceId: string;
  readonly deviceKeyFingerprint: string;
  readonly scopes: readonly Scope[];
  readonly expiresAt: number;
}

export interface PairingRequest {
  readonly pairingRequestId: string;
  readonly challengeId: string;
  readonly sessionId?: string;
  readonly peerId: string;
  readonly deviceLabel: string;
  readonly platform: DeviceRecord['platform'];
  readonly hardwareBacked: boolean;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  state: 'pending' | 'approved' | 'denied';
  grant?: DeviceGrant;
}

export interface RedeemBody {
  readonly challengeId: string;
  readonly publicKey: string;
  readonly deviceLabel: string;
  readonly platform: DeviceRecord['platform'];
  readonly hardwareBacked: boolean;
}

export type ProofCheck = (key: KeyObject, fingerprint: string) => KeyProof;
type Failure = { readonly ok: false; readonly code: ErrorCode; readonly serverTime?: number };

export interface PairingOptions {
  /** Device grant lifetime. */
  readonly grantTtlMs: number;
  /** How long a redeemed request waits for the local owner. */
  readonly approvalTtlMs?: number;
}

const MAX_CHALLENGE_FAILURES = 3;
/** Redeems across all peers: iroh keys cost nothing to mint, so per-peer limits alone are not enough. */
const MAX_REDEEMS_PER_MINUTE = 30;

/**
 * QR challenges, redemption and the pending requests the local owner approves.
 * Approval is reachable only from local surfaces (the DSH Web card and the
 * admin socket); no native-api route can approve, so a phone cannot pair itself.
 */
export class Pairing {
  private readonly challenges = new Map<string, Challenge>();
  private readonly requests = new Map<string, PairingRequest>();
  private readonly perPeer = new RateLimiter(10, 60_000);
  private readonly overall = new RateLimiter(MAX_REDEEMS_PER_MINUTE, 60_000);
  private readonly listeners = new Set<(request: PairingRequest) => void>();
  private readonly approvalTtlMs: number;

  private readonly state: HostState;
  private readonly hostId: string;
  private readonly clock: Clock;
  private readonly options: PairingOptions;

  constructor(
    state: HostState,
    hostId: string,
    clock: Clock,
    options: PairingOptions,
  ) {
    this.state = state;
    this.hostId = hostId;
    this.clock = clock;
    this.options = options;
    this.approvalTtlMs = options.approvalTtlMs ?? 5 * 60_000;
  }

  createChallenge(sessionId?: string): Challenge {
    this.prune();
    const now = this.clock.now();
    const challenge: Challenge = {
      challengeId: randomId('chl'),
      ...(sessionId === undefined ? {} : { sessionId }),
      createdAt: now,
      expiresAt: now + LIMITS.challengeTtlMs,
      used: false,
      failures: 0,
    };
    this.challenges.set(challenge.challengeId, challenge);
    return challenge;
  }

  redeem(identity: PeerIdentity, body: RedeemBody, prove: ProofCheck): { ok: true; request: PairingRequest } | Failure {
    const now = this.clock.now();
    if (!this.perPeer.hit(identity.peerId, now) || !this.overall.hit('all', now)) return { ok: false, code: 'RATE_LIMITED' };
    const challenge = this.challenges.get(body.challengeId);
    if (challenge === undefined || challenge.expiresAt <= now || challenge.used || challenge.failures >= MAX_CHALLENGE_FAILURES) {
      return { ok: false, code: 'CHALLENGE_INVALID' };
    }
    const key = importP256PublicKey(body.publicKey);
    if (key === undefined) {
      challenge.failures += 1;
      return { ok: false, code: 'BAD_REQUEST' };
    }
    const proof = prove(key.key, key.fingerprint);
    if (!proof.ok) {
      challenge.failures += 1;
      return proof;
    }
    challenge.used = true;
    const request: PairingRequest = {
      pairingRequestId: randomId('pair'),
      challengeId: challenge.challengeId,
      ...(challenge.sessionId === undefined ? {} : { sessionId: challenge.sessionId }),
      peerId: identity.peerId,
      deviceLabel: body.deviceLabel,
      platform: body.platform,
      hardwareBacked: body.hardwareBacked,
      publicKey: body.publicKey,
      fingerprint: key.fingerprint,
      createdAt: now,
      expiresAt: now + this.approvalTtlMs,
      state: 'pending',
    };
    this.requests.set(request.pairingRequestId, request);
    for (const listener of this.listeners) listener(request);
    return { ok: true, request };
  }

  /** Status for the phone that redeemed; other peers see NOT_FOUND. */
  status(pairingRequestId: string, identity: PeerIdentity, prove: ProofCheck): { ok: true; state: 'pending' | 'approved' | 'denied' | 'expired'; grant?: DeviceGrant } | Failure {
    const request = this.requests.get(pairingRequestId);
    if (request === undefined || request.peerId !== identity.peerId) return { ok: false, code: 'NOT_FOUND' };
    const key = importP256PublicKey(request.publicKey)!;
    const proof = prove(key.key, request.fingerprint);
    if (!proof.ok) return proof;
    if (request.state === 'pending' && request.expiresAt <= this.clock.now()) return { ok: true, state: 'expired' };
    return request.grant === undefined ? { ok: true, state: request.state } : { ok: true, state: request.state, grant: request.grant };
  }

  pending(): PairingRequest[] {
    const now = this.clock.now();
    return [...this.requests.values()].filter((request) => request.state === 'pending' && request.expiresAt > now);
  }

  request(pairingRequestId: string): PairingRequest | undefined {
    return this.requests.get(pairingRequestId);
  }

  /** Local owner approval: mint the device grant. */
  async approve(pairingRequestId: string): Promise<DeviceRecord | undefined> {
    const request = this.requests.get(pairingRequestId);
    const now = this.clock.now();
    if (request === undefined || request.state !== 'pending' || request.expiresAt <= now) return undefined;
    const device: DeviceRecord = {
      deviceId: randomId('dev'),
      label: request.deviceLabel,
      platform: request.platform,
      hardwareBacked: request.hardwareBacked,
      publicKey: request.publicKey,
      fingerprint: request.fingerprint,
      peerId: request.peerId,
      scopes: [...SCOPES],
      createdAt: now,
      expiresAt: now + this.options.grantTtlMs,
      lastSeenAt: null,
      revokedAt: null,
    };
    request.state = 'approved';
    await this.state.addDevice(device);
    request.grant = {
      hostId: this.hostId,
      deviceId: device.deviceId,
      deviceKeyFingerprint: device.fingerprint,
      scopes: device.scopes,
      expiresAt: device.expiresAt,
    };
    for (const listener of this.listeners) listener(request);
    return device;
  }

  deny(pairingRequestId: string): boolean {
    const request = this.requests.get(pairingRequestId);
    if (request === undefined || request.state !== 'pending') return false;
    request.state = 'denied';
    for (const listener of this.listeners) listener(request);
    return true;
  }

  /** Called on every new, approved or denied request (drives the local approval UIs). */
  onChange(listener: (request: PairingRequest) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private prune(): void {
    const now = this.clock.now();
    for (const [id, challenge] of this.challenges) if (challenge.expiresAt <= now) this.challenges.delete(id);
    for (const [id, request] of this.requests) if (request.expiresAt + 10 * 60_000 <= now) this.requests.delete(id);
  }
}
