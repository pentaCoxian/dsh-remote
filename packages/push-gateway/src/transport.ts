import type { Duplex } from 'node:stream';
import { PeerStream } from '@dsh-remote/iroh-http';
import { PUSH_ALPN } from '@dsh-remote/protocol/push';
import iroh from '@number0/iroh';
import type { Connection, Endpoint, Incoming } from '@number0/iroh';

const { Endpoint: EndpointClass, EndpointTicket, RelayMode } = iroh;

const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 4096;
const MAX_CONNECTIONS_PER_PEER = 4;
const MAX_STREAMS_PER_CONNECTION = 8;

export interface TransportOptions {
  readonly secretKey: number[];
  /** Relay URLs; empty for direct addresses only (tests). */
  readonly relays: readonly string[];
  readonly bindAddr?: string;
  onStream(stream: Duplex, peerId: string): void;
}

/** The gateway's iroh endpoint: `dsh-remote/push/1` only, one HTTP connection per bi-stream. */
export class GatewayTransport {
  private readonly endpoint: Endpoint;
  private readonly options: TransportOptions;
  private readonly live = new Map<Connection, string>();

  private constructor(endpoint: Endpoint, options: TransportOptions) {
    this.endpoint = endpoint;
    this.options = options;
  }

  static async start(options: TransportOptions): Promise<GatewayTransport> {
    const builder = EndpointClass.builder();
    builder.applyMinimal();
    builder.secretKey(options.secretKey);
    builder.alpns([Array.from(Buffer.from(PUSH_ALPN, 'utf8'))]);
    builder.relayMode(options.relays.length === 0 ? RelayMode.disabled() : RelayMode.customFromUrls([...options.relays]));
    if (options.bindAddr !== undefined) builder.bindAddr(options.bindAddr);
    const transport = new GatewayTransport(await builder.bind(), options);
    void transport.acceptLoop();
    return transport;
  }

  get endpointId(): string {
    return this.endpoint.id().toString();
  }

  ticket(): string {
    return EndpointTicket.fromAddr(this.endpoint.addr()).toString();
  }

  /** Wait for the home relay; true at once without relays. */
  async online(timeoutMs: number): Promise<boolean> {
    if (this.options.relays.length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.endpoint.online().then(() => true), new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)))]);
    } finally {
      clearTimeout(timer);
    }
  }

  get connections(): number {
    return this.live.size;
  }

  async close(): Promise<void> {
    for (const connection of this.live.keys()) connection.close(0n, Array.from(Buffer.from('gateway stopping', 'utf8')));
    await this.endpoint.close();
  }

  private async acceptLoop(): Promise<void> {
    for (;;) {
      const incoming = await this.endpoint.acceptNext().catch(() => null);
      if (incoming === null) return;
      if (this.live.size >= MAX_CONNECTIONS) {
        void incoming.refuse().catch(() => {});
        continue;
      }
      void this.serve(incoming).catch(() => {});
    }
  }

  private async serve(incoming: Incoming): Promise<void> {
    const connection = await withTimeout((await incoming.accept()).connect(), HANDSHAKE_TIMEOUT_MS);
    const peerId = connection.remoteId().toString();
    if ([...this.live.values()].filter((peer) => peer === peerId).length >= MAX_CONNECTIONS_PER_PEER) {
      connection.close(2n, Array.from(Buffer.from('too many connections', 'utf8')));
      return;
    }
    connection.setMaxConcurrentBiStreams(BigInt(MAX_STREAMS_PER_CONNECTION));
    this.live.set(connection, peerId);
    const streams = new Set<PeerStream>();
    try {
      for (;;) {
        const stream = new PeerStream(await connection.acceptBi());
        streams.add(stream);
        stream.once('close', () => streams.delete(stream));
        this.options.onStream(stream, peerId);
      }
    } catch {
      // The connection closed or was lost.
    } finally {
      this.live.delete(connection);
      for (const stream of streams) stream.destroy();
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error('handshake timed out')), ms))),
  ]);
}
