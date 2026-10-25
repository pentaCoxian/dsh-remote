import { buildPairingUrl, shortFingerprint } from '@dsh-remote/protocol';
import { EventsSocket } from './api/events.ts';
import { metaRoutes } from './api/meta.ts';
import { pairingRoutes } from './api/pairing.ts';
import { sessionRoutes } from './api/sessions.ts';
import type { AccessVerifier } from './core/access.ts';
import type { SessionAdapter } from './core/adapter.ts';
import { Approvals } from './core/approvals.ts';
import type { Audit } from './core/audit.ts';
import type { Clock } from './core/clock.ts';
import { EventHub } from './core/events.ts';
import type { HostIdentity } from './core/host-identity.ts';
import { Leases } from './core/leases.ts';
import { Pairing, type PairingRequest } from './core/pairing.ts';
import { ProofVerifier } from './core/proof.ts';
import { Receipts, type ReceiptsDocument } from './core/receipts.ts';
import { HostState, type DeviceRecord, type HostStateDocument } from './core/state.ts';
import type { DocumentStore } from './core/store.ts';
import { NativeApi } from './http/server.ts';

export interface RemoteHostOptions {
  readonly adapter: SessionAdapter;
  readonly access: AccessVerifier;
  readonly clock: Clock;
  readonly identity: HostIdentity;
  readonly stateStore: DocumentStore<HostStateDocument>;
  readonly receiptsStore: DocumentStore<ReceiptsDocument>;
  readonly audit: Audit;
  /** Access-protected API hostname, e.g. `dsh.example.com`. */
  readonly publicHost: string;
  /** Public static link host origin for pairing QR codes, e.g. `https://link.example.com`. */
  readonly linkOrigin: string;
  readonly port: number;
  readonly hostName: string;
  readonly grantTtlMs: number;
  readonly remoteApprovalTimeoutMs: number;
  readonly heartbeatMs?: number;
  /** Process start; signatures older than it are refused. */
  readonly bootMs?: number;
}

export interface PairingOffer {
  readonly challengeId: string;
  readonly url: string;
  readonly expiresAt: number;
  readonly hostKeyFingerprint: string;
  readonly sessionId?: string;
}

/** What the local owner sees for one pending pairing request. */
export interface PendingPairing {
  readonly pairingRequestId: string;
  readonly accessEmail: string;
  readonly deviceLabel: string;
  readonly platform: string;
  readonly hardwareBacked: boolean;
  readonly fingerprint: string;
  readonly shortFingerprint: string;
  readonly expiresAt: number;
}

export interface DeviceSummary {
  readonly deviceId: string;
  readonly label: string;
  readonly platform: string;
  readonly accessEmail: string;
  readonly shortFingerprint: string;
  readonly hardwareBacked: boolean;
  readonly lastSeenAt: number | null;
  readonly expiresAt: number;
  readonly revoked: boolean;
}

const CAPABILITIES = ['sessions', 'events', 'prompts', 'cancel', 'approvals', 'control-lease'];

/**
 * DSH Remote assembled: native API + events socket on loopback, plus the
 * owner operations the local surfaces (`/rc` card, `dsh-remote` CLI) call.
 * Owner operations are methods here, never native-api routes.
 */
export class RemoteHost {
  readonly state: HostState;
  readonly pairing: Pairing;
  readonly events: EventHub;
  readonly receipts: Receipts;
  readonly leases: Leases;
  readonly approvals: Approvals;
  readonly api: NativeApi;
  readonly socket: EventsSocket;
  private readonly options: RemoteHostOptions;
  private readonly disposers: (() => void)[] = [];
  private listeningPort: number | undefined;

  private constructor(options: RemoteHostOptions, state: HostState, receipts: Receipts) {
    this.options = options;
    this.state = state;
    this.receipts = receipts;
    const { clock } = options;
    this.pairing = new Pairing(state, options.identity, clock, { grantTtlMs: options.grantTtlMs });
    this.events = new EventHub(options.adapter, state);
    this.leases = new Leases(clock);
    this.approvals = new Approvals(state, this.events, clock, { remoteTimeoutMs: options.remoteApprovalTimeoutMs });
    this.socket = new EventsSocket({ events: this.events, state, leases: this.leases, approvals: this.approvals, clock, ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }) });
    const proof = new ProofVerifier(state, clock, options.bootMs ?? clock.now());
    this.api = new NativeApi({
      publicHost: options.publicHost,
      port: options.port,
      access: options.access,
      proof,
      routes: [
        ...metaRoutes({ state, clock, hostName: options.hostName, capabilities: CAPABILITIES }),
        ...pairingRoutes({ pairing: this.pairing, proof, host: options.identity }),
        ...sessionRoutes({ adapter: options.adapter, state, events: this.events, receipts, leases: this.leases, approvals: this.approvals, clock }),
      ],
      upgrade: this.socket.route,
      audit: options.audit,
      clock,
    });
  }

  static async create(options: RemoteHostOptions): Promise<RemoteHost> {
    const state = await HostState.open(options.stateStore, options.clock);
    const receipts = await Receipts.open(options.receiptsStore, options.clock);
    return new RemoteHost(options, state, receipts);
  }

  get port(): number | undefined {
    return this.listeningPort;
  }

  get origin(): string {
    return `https://${this.options.publicHost}`;
  }

  async start(): Promise<number> {
    const { adapter } = this.options;
    this.disposers.push(
      adapter.answerApprovals(this.approvals.answerer),
      this.events.onPrompt((progress) => this.receipts.observe(progress)),
      this.state.onDeviceRevoked((device) => {
        this.leases.releaseDevice(device.deviceId);
        adapter.accessChanged();
      }),
      this.state.onPublicationChanged(() => adapter.accessChanged()),
    );
    this.events.start();
    this.listeningPort = await this.api.listen();
    return this.listeningPort;
  }

  async stop(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.events.stop();
    this.socket.close();
    await this.api.close();
  }

  // ---- owner operations (local surfaces only) ----

  isPublished(sessionId: string): boolean {
    return this.state.isPublished(sessionId);
  }

  publish(sessionId: string): Promise<boolean> {
    return this.state.setPublished(sessionId, true);
  }

  unpublish(sessionId: string): Promise<boolean> {
    return this.state.setPublished(sessionId, false);
  }

  /** A fresh 120 s QR challenge. The URL is not a credential, but never write it to the session log. */
  offerPairing(sessionId?: string): PairingOffer {
    const challenge = this.pairing.createChallenge(sessionId);
    const url = buildPairingUrl(this.options.linkOrigin, {
      origin: this.origin,
      hostId: this.state.hostId,
      challengeId: challenge.challengeId,
      hostKeyFingerprint: this.options.identity.fingerprint,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    return {
      challengeId: challenge.challengeId,
      url,
      expiresAt: challenge.expiresAt,
      hostKeyFingerprint: this.options.identity.fingerprint,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  }

  pendingPairings(): PendingPairing[] {
    return this.pairing.pending().map(describePairing);
  }

  async approvePairing(pairingRequestId: string): Promise<DeviceSummary | undefined> {
    const device = await this.pairing.approve(pairingRequestId);
    return device === undefined ? undefined : describeDevice(device);
  }

  denyPairing(pairingRequestId: string): boolean {
    return this.pairing.deny(pairingRequestId);
  }

  onPairingChange(listener: (request: PairingRequest) => void): () => void {
    return this.pairing.onChange(listener);
  }

  devices(): DeviceSummary[] {
    return this.state.devices().map(describeDevice);
  }

  revokeDevice(deviceId: string): Promise<boolean> {
    return this.state.revokeDevice(deviceId);
  }

  status(): { hostId: string; hostName: string; origin: string; listening: boolean; hostKeyFingerprint: string; published: string[]; devices: number; pendingPairings: number } {
    return {
      hostId: this.state.hostId,
      hostName: this.options.hostName,
      origin: this.origin,
      listening: this.listeningPort !== undefined,
      hostKeyFingerprint: shortFingerprint(this.options.identity.fingerprint),
      published: this.state.publications().map((p) => p.sessionId),
      devices: this.state.devices().filter((d) => d.revokedAt === null).length,
      pendingPairings: this.pairing.pending().length,
    };
  }
}

function describePairing(request: PairingRequest): PendingPairing {
  return {
    pairingRequestId: request.pairingRequestId,
    accessEmail: request.accessEmail,
    deviceLabel: request.deviceLabel,
    platform: request.platform,
    hardwareBacked: request.hardwareBacked,
    fingerprint: request.fingerprint,
    shortFingerprint: shortFingerprint(request.fingerprint),
    expiresAt: request.expiresAt,
  };
}

function describeDevice(device: DeviceRecord): DeviceSummary {
  return {
    deviceId: device.deviceId,
    label: device.label,
    platform: device.platform,
    accessEmail: device.accessEmail,
    shortFingerprint: shortFingerprint(device.fingerprint),
    hardwareBacked: device.hardwareBacked,
    lastSeenAt: device.lastSeenAt,
    expiresAt: device.expiresAt,
    revoked: device.revokedAt !== null,
  };
}
