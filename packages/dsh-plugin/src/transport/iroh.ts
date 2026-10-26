import type { Duplex } from 'node:stream';
import { PeerStream } from '@dsh-remote/iroh-http';
import { WEB_ALPN } from '@dsh-remote/protocol';
import iroh from '@number0/iroh';
import type { Connection, Endpoint as IrohEndpoint, Incoming } from '@number0/iroh';
import type { PeerIdentity } from '../core/peer.ts';

const { Endpoint, EndpointAddr, EndpointId, EndpointTicket, RelayMode } = iroh;

/** ALPN of the DSH Remote API over iroh: one HTTP/1.1 connection per bi-stream. */
export const ALPN = 'dsh-remote/1';
const ALPN_BYTES = Array.from(Buffer.from(ALPN, 'utf8'));
const WEB_ALPN_BYTES = Array.from(Buffer.from(WEB_ALPN, 'utf8'));
const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface TransportLimits {
  /** Live QUIC connections across all peers. */
  readonly maxConnections: number;
  /** Live connections from one peer key (a phone keeps one, briefly two while reconnecting). */
  readonly maxConnectionsPerPeer: number;
  /** Concurrent bi-streams, i.e. HTTP connections, inside one QUIC connection. */
  readonly maxStreamsPerConnection: number;
}

const DEFAULT_LIMITS: TransportLimits = { maxConnections: 32, maxConnectionsPerPeer: 4, maxStreamsPerConnection: 16 };

export interface IrohTransportOptions {
  /** The 32-byte Ed25519 seed (`HostKey.secretKeyBytes()`). */
  readonly secretKey: number[];
  /** Relay URLs. Empty disables relays: direct and LAN addresses only. */
  readonly relays: readonly string[];
  /** `host:port` to bind; tests use `127.0.0.1:0`. */
  readonly bindAddr?: string;
  readonly limits?: Partial<TransportLimits>;
  /** Called with every accepted API bi-stream and the peer QUIC authenticated. */
  onStream(stream: Duplex, peer: PeerIdentity): void;
  /**
   * The DSH Web tunnel (`dsh-remote/web/1`): `allowWeb` gates each connection
   * and stream, `onWebStream` serves the streams it allows. Absent: web
   * connections are refused.
   */
  readonly web?: { allowWeb(peer: PeerIdentity): boolean; onWebStream(stream: Duplex, peer: PeerIdentity): void };
}

export interface TransportStatus {
  readonly relays: readonly string[];
  readonly homeRelay: string | null;
  readonly directAddresses: readonly string[];
  readonly connections: number;
}

interface Live {
  readonly peerId: string;
  readonly connection: Connection;
  readonly streams: Set<PeerStream>;
}

/**
 * The host's iroh endpoint. It never publishes to any address-lookup service:
 * phones dial the ticket from the pairing QR and refresh it over the API. Peers
 * need no prior permission to connect, because pairing starts from an unknown
 * key; every HTTP route then checks the peer against its grant.
 */
export class IrohTransport {
  private readonly live = new Set<Live>();
  private readonly limits: TransportLimits;
  private readonly endpoint: IrohEndpoint;
  private readonly options: IrohTransportOptions;

  private constructor(endpoint: IrohEndpoint, options: IrohTransportOptions) {
    this.endpoint = endpoint;
    this.options = options;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  static async start(options: IrohTransportOptions): Promise<IrohTransport> {
    const builder = Endpoint.builder();
    builder.applyMinimal();
    builder.secretKey(options.secretKey);
    builder.alpns(options.web === undefined ? [ALPN_BYTES] : [ALPN_BYTES, WEB_ALPN_BYTES]);
    builder.relayMode(options.relays.length === 0 ? RelayMode.disabled() : RelayMode.customFromUrls([...options.relays]));
    if (options.bindAddr !== undefined) builder.bindAddr(options.bindAddr);
    const transport = new IrohTransport(await builder.bind(), options);
    void transport.acceptLoop();
    return transport;
  }

  get endpointId(): string {
    return this.endpoint.id().toString();
  }

  /** The current EndpointTicket: id, home relay and direct addresses. */
  ticket(): string {
    return EndpointTicket.fromAddr(this.endpoint.addr()).toString();
  }

  homeRelay(): string | null {
    return this.endpoint.addr().relayUrl();
  }

  /** Wait for a home relay connection; true at once when relays are disabled. */
  async online(timeoutMs: number): Promise<boolean> {
    if (this.options.relays.length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)));
    try {
      return await Promise.race([this.endpoint.online().then(() => true), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Drop every connection from `peerId`, e.g. after its last grant was revoked. */
  closePeer(peerId: string, reason = 'revoked'): void {
    for (const live of this.live) if (live.peerId === peerId) live.connection.close(1n, Array.from(Buffer.from(reason, 'utf8')));
  }

  status(): TransportStatus {
    const addr = this.endpoint.addr();
    return { relays: this.options.relays, homeRelay: addr.relayUrl(), directAddresses: addr.directAddresses(), connections: this.live.size };
  }

  async close(): Promise<void> {
    for (const live of this.live) live.connection.close(0n, Array.from(Buffer.from('host stopping', 'utf8')));
    await this.endpoint.close();
  }

  private async acceptLoop(): Promise<void> {
    for (;;) {
      const incoming = await this.endpoint.acceptNext().catch(() => null);
      if (incoming === null) return;
      if (this.live.size >= this.limits.maxConnections) {
        void incoming.refuse().catch(() => {});
        continue;
      }
      void this.serve(incoming).catch(() => {});
    }
  }

  private async serve(incoming: Incoming): Promise<void> {
    // Only our ALPNs are advertised, so a handshake for anything else fails here.
    const connection = await withTimeout((await incoming.accept()).connect(), HANDSHAKE_TIMEOUT_MS);
    const peerId = connection.remoteId().toString();
    const web = Buffer.from(connection.alpn()).toString('utf8') === WEB_ALPN ? this.options.web : undefined;
    if (web !== undefined && !web.allowWeb({ peerId })) {
      connection.close(3n, Array.from(Buffer.from('web window closed', 'utf8')));
      return;
    }
    if ([...this.live].filter((live) => live.peerId === peerId).length >= this.limits.maxConnectionsPerPeer) {
      connection.close(2n, Array.from(Buffer.from('too many connections', 'utf8')));
      return;
    }
    connection.setMaxConcurrentBiStreams(BigInt(this.limits.maxStreamsPerConnection));
    const live: Live = { peerId, connection, streams: new Set() };
    this.live.add(live);
    const peer: PeerIdentity = { peerId };
    try {
      for (;;) {
        const stream = new PeerStream(await connection.acceptBi());
        live.streams.add(stream);
        stream.once('close', () => live.streams.delete(stream));
        if (web !== undefined) web.onWebStream(stream, peer);
        else this.options.onStream(stream, peer);
      }
    } catch {
      // The connection closed or was lost.
    } finally {
      this.live.delete(live);
      for (const stream of live.streams) stream.destroy();
    }
  }
}

/** A ticket naming only `endpointId`, for hosts with no endpoint running (tests). */
export function bareTicket(endpointId: string): string {
  return EndpointTicket.fromAddr(new EndpointAddr(EndpointId.fromString(endpointId))).toString();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error('handshake timed out')), ms))),
  ]);
}
