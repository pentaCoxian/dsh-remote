import type { IncomingMessage } from 'node:http';
import { buildPairingUrl, shortFingerprint } from '@dsh-remote/protocol';
import { EventsSocket } from './api/events.ts';
import { metaRoutes } from './api/meta.ts';
import { pairingRoutes } from './api/pairing.ts';
import { sessionRoutes } from './api/sessions.ts';
import type { SessionAdapter } from './core/adapter.ts';
import { Approvals } from './core/approvals.ts';
import type { Audit } from './core/audit.ts';
import type { Clock } from './core/clock.ts';
import { EventHub } from './core/events.ts';
import type { HostKey } from './core/host-key.ts';
import { Leases } from './core/leases.ts';
import { Pairing, type PairingRequest } from './core/pairing.ts';
import { shortPeerId, type PeerIdentity } from './core/peer.ts';
import { ProofVerifier } from './core/proof.ts';
import { Receipts, type ReceiptsDocument } from './core/receipts.ts';
import { HostState, type DeviceRecord, type HostStateDocument } from './core/state.ts';
import type { DocumentStore } from './core/store.ts';
import { NativeApi } from './http/server.ts';
import { bareTicket, IrohTransport, type TransportStatus } from './transport/iroh.ts';

export interface RemoteHostOptions {
  /** The DSH binding, or a factory for one that needs the opened host state. */
  readonly adapter: SessionAdapter | ((state: HostState) => SessionAdapter);
  readonly clock: Clock;
  /** The iroh secret key; its public key is the host id. */
  readonly hostKey: HostKey;
  readonly stateStore: DocumentStore<HostStateDocument>;
  readonly receiptsStore: DocumentStore<ReceiptsDocument>;
  readonly audit: Audit;
  /** The production transport. `relays: []` means direct and LAN addresses only. */
  readonly iroh?: { readonly relays: readonly string[]; readonly bindAddr?: string };
  /** TESTS AND THE DEV HOST ONLY: also serve 127.0.0.1:`port`, taking each request's peer from `identify`. */
  readonly loopback?: { readonly port: number; identify(req: IncomingMessage): PeerIdentity | undefined };
  readonly hostName: string;
  readonly grantTtlMs: number;
  readonly remoteApprovalTimeoutMs: number;
  readonly heartbeatMs?: number;
  /** Process start; signatures older than it are refused. */
  readonly bootMs?: number;
  /** Reported by `status` for `dsh-remote doctor`. */
  readonly entry?: 'production' | 'test-harness' | 'dev';
}

export interface PairingOffer {
  readonly challengeId: string;
  /** The QR text (`dshremote://pair?…`). */
  readonly url: string;
  readonly expiresAt: number;
  readonly hostId: string;
  readonly sessionId?: string;
}

/** What the local owner sees for one pending pairing request. */
export interface PendingPairing {
  readonly pairingRequestId: string;
  /** Lets a surface match the request to the QR it showed. */
  readonly challengeId: string;
  /** Short form of the phone's iroh key. */
  readonly peer: string;
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
  readonly peer: string;
  readonly shortFingerprint: string;
  readonly hardwareBacked: boolean;
  readonly lastSeenAt: number | null;
  readonly expiresAt: number;
  readonly revoked: boolean;
}

const CAPABILITIES = ['sessions', 'events', 'prompts', 'cancel', 'approvals', 'control-lease'];
const REVOKE_HANGUP_MS = 1_000;

export interface HostStatus {
  readonly hostId: string;
  readonly hostName: string;
  readonly entry: string;
  /** The iroh endpoint, or null while it is not running. */
  readonly transport: TransportStatus | null;
  /** A loopback TCP listener exists only in tests and the dev host. */
  readonly loopbackPort: number | null;
  readonly published: string[];
  readonly devices: number;
  readonly pendingPairings: number;
}

/**
 * DSH Remote assembled: native API + events socket behind an iroh endpoint,
 * plus the owner operations the local surfaces (`/rc` card, `dsh-remote` CLI)
 * call. Owner operations are methods here, never native-api routes.
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
  readonly adapter: SessionAdapter;
  private readonly options: RemoteHostOptions;
  private readonly disposers: (() => void)[] = [];
  private transport: IrohTransport | undefined;
  private listeningPort: number | undefined;

  private constructor(options: RemoteHostOptions, state: HostState, receipts: Receipts) {
    this.options = options;
    this.state = state;
    this.receipts = receipts;
    this.adapter = typeof options.adapter === 'function' ? options.adapter(state) : options.adapter;
    const { clock } = options;
    const hostId = options.hostKey.endpointId;
    this.pairing = new Pairing(state, hostId, clock, { grantTtlMs: options.grantTtlMs });
    this.events = new EventHub(this.adapter, state);
    this.leases = new Leases(clock);
    this.approvals = new Approvals(state, this.events, clock, { remoteTimeoutMs: options.remoteApprovalTimeoutMs });
    this.socket = new EventsSocket({ events: this.events, state, leases: this.leases, approvals: this.approvals, clock, ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }) });
    const proof = new ProofVerifier(state, clock, options.bootMs ?? clock.now());
    this.api = new NativeApi({
      proof,
      routes: [
        ...metaRoutes({ hostId, clock, hostName: options.hostName, capabilities: CAPABILITIES, address: () => this.address() }),
        ...pairingRoutes({ pairing: this.pairing, proof }),
        ...sessionRoutes({ adapter: this.adapter, state, events: this.events, receipts, leases: this.leases, approvals: this.approvals, clock }),
      ],
      upgrade: this.socket.route,
      audit: options.audit,
      clock,
      ...(options.loopback === undefined ? {} : { loopbackIdentity: options.loopback.identify }),
    });
  }

  static async create(options: RemoteHostOptions): Promise<RemoteHost> {
    const state = await HostState.open(options.stateStore, options.clock);
    const receipts = await Receipts.open(options.receiptsStore, options.clock);
    return new RemoteHost(options, state, receipts);
  }

  get hostId(): string {
    return this.options.hostKey.endpointId;
  }

  /** The loopback port, in tests and the dev host. */
  get port(): number | undefined {
    return this.listeningPort;
  }

  /** The running iroh endpoint, if any. */
  get endpoint(): IrohTransport | undefined {
    return this.transport;
  }

  async start(): Promise<void> {
    const { adapter } = this;
    this.disposers.push(
      adapter.answerApprovals(this.approvals.answerer),
      this.events.onPrompt((progress) => this.receipts.observe(progress)),
      this.state.onDeviceRevoked((device) => {
        this.leases.releaseDevice(device.deviceId);
        adapter.accessChanged();
        // Hang up after a grace period, so the 4403 close frame and in-flight replies reach the
        // phone first; keep the connection if another live grant uses the same phone key.
        const timer = setTimeout(() => {
          if (!this.state.devices().some((other) => other.peerId === device.peerId && other.revokedAt === null)) this.transport?.closePeer(device.peerId);
        }, REVOKE_HANGUP_MS);
        timer.unref();
      }),
      this.state.onPublicationChanged(() => adapter.accessChanged()),
    );
    this.events.start();
    if (this.options.iroh !== undefined) {
      this.transport = await IrohTransport.start({
        secretKey: this.options.hostKey.secretKeyBytes(),
        relays: this.options.iroh.relays,
        ...(this.options.iroh.bindAddr === undefined ? {} : { bindAddr: this.options.iroh.bindAddr }),
        onStream: (stream, peer) => this.api.accept(stream, peer),
      });
    }
    if (this.options.loopback !== undefined) this.listeningPort = await this.api.listen(this.options.loopback.port);
  }

  async stop(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.events.stop();
    this.socket.close();
    await this.transport?.close();
    this.transport = undefined;
    await this.api.close();
  }

  /** Current ticket and home relay, or undefined without an endpoint. */
  address(): { ticket: string; relayUrl: string | null } | undefined {
    return this.transport === undefined ? undefined : { ticket: this.transport.ticket(), relayUrl: this.transport.homeRelay() };
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

  /**
   * A fresh 120 s QR challenge. The text is not a credential, but it carries
   * the host's addresses, so never write it to the session log.
   */
  offerPairing(sessionId?: string): PairingOffer {
    const challenge = this.pairing.createChallenge(sessionId);
    const url = buildPairingUrl({
      ticket: this.transport?.ticket() ?? bareTicket(this.hostId),
      challengeId: challenge.challengeId,
      hostName: this.options.hostName,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    return { challengeId: challenge.challengeId, url, expiresAt: challenge.expiresAt, hostId: this.hostId, ...(sessionId === undefined ? {} : { sessionId }) };
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

  status(): HostStatus {
    return {
      hostId: this.hostId,
      hostName: this.options.hostName,
      entry: this.options.entry ?? 'unknown',
      transport: this.transport?.status() ?? null,
      loopbackPort: this.listeningPort ?? null,
      published: this.state.publications().map((p) => p.sessionId),
      devices: this.state.devices().filter((d) => d.revokedAt === null).length,
      pendingPairings: this.pairing.pending().length,
    };
  }
}

function describePairing(request: PairingRequest): PendingPairing {
  return {
    pairingRequestId: request.pairingRequestId,
    challengeId: request.challengeId,
    peer: shortPeerId(request.peerId),
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
    peer: shortPeerId(device.peerId),
    shortFingerprint: shortFingerprint(device.fingerprint),
    hardwareBacked: device.hardwareBacked,
    lastSeenAt: device.lastSeenAt,
    expiresAt: device.expiresAt,
    revoked: device.revokedAt !== null,
  };
}
