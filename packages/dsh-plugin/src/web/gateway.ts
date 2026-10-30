import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Clock } from '../core/clock.ts';
import type { PeerIdentity } from '../core/peer.ts';
import type { DeviceRecord, HostState } from '../core/state.ts';

/** Where DSH Web listens on this machine (plain HTTP; its configured bind address). */
export interface WebTarget {
  readonly host: string;
  readonly port: number;
}

export interface WebGatewayOptions {
  /** DSH Web's listener, or undefined while it is not serving. */
  readonly target: () => WebTarget | undefined;
  /** `token=<launch token>` for DSH's own owner login (`ctx.connection.authenticatedUrl`). */
  readonly launchTokenQuery: () => string | undefined;
  /** How long one signed `POST /v1/web/session` keeps a device's web window open. */
  readonly windowMs?: number;
}

const DEFAULT_WINDOW_MS = 12 * 3600_000;
/** How long a reply may take to reach the phone after DSH Web closed its side (the phone pipe's drain timeout). */
const DRAIN_MS = 30_000;

/**
 * The DSH Web tunnel's host end. A phone opens a window with a request signed
 * by its hardware key; while it is open, every bi-stream on that peer's
 * `dsh-remote/web/1` connection is piped to DSH Web's loopback listener. DSH's
 * own gate still applies on the other side: its Host/Origin fence accepts
 * loopback authorities on any port, and its owner cookie comes from DSH's launch
 * token, so the phone runs DSH Web exactly as a local browser would.
 *
 * Windows are stored with the device: DSH's cookie outlives a restart, so the
 * phone's open DSH Web reconnects to the restarted host on its own.
 */
export class WebGateway {
  private readonly windowMs: number;
  private readonly state: HostState;
  private readonly clock: Clock;
  private readonly options: WebGatewayOptions;

  constructor(state: HostState, clock: Clock, options: WebGatewayOptions) {
    this.state = state;
    this.clock = clock;
    this.options = options;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  }

  /** Why the tunnel cannot serve right now, or undefined when it can. */
  unavailable(): string | undefined {
    const target = this.options.target();
    if (target === undefined) return 'DSH Web is not listening on plain HTTP';
    if (this.options.launchTokenQuery() === undefined) return 'DSH Web has no browser login';
    return undefined;
  }

  /** Open (or extend) `device`'s window; the caller has verified its signature and `web:open` scope. */
  async open(device: DeviceRecord): Promise<{ tokenQuery: string; expiresAt: number } | undefined> {
    const tokenQuery = this.options.launchTokenQuery();
    if (tokenQuery === undefined || this.unavailable() !== undefined) return undefined;
    const expiresAt = Math.min(this.clock.now() + this.windowMs, device.expiresAt);
    await this.state.setWebWindow(device.deviceId, expiresAt);
    return { tokenQuery, expiresAt };
  }

  /** Whether `peer` may use the tunnel now: a device of that peer with an open window and a live grant. */
  allows(peer: PeerIdentity): boolean {
    const now = this.clock.now();
    return this.state
      .devices()
      .some((device) => device.peerId === peer.peerId && (device.webUntil ?? 0) > now && device.revokedAt === null && device.expiresAt > now && device.scopes.includes('web:open'));
  }

  /** Pipe one tunnel stream to DSH Web; refused streams are reset. */
  pipe(stream: Duplex, peer: PeerIdentity): void {
    const target = this.options.target();
    if (!this.allows(peer) || target === undefined) {
      stream.destroy();
      return;
    }
    const socket = connect(target.port, target.host);
    socket.setNoDelay(true);
    const end = () => {
      stream.destroy();
      socket.destroy();
    };
    socket.on('error', end);
    stream.on('error', end);
    stream.pipe(socket);
    socket.pipe(stream);
    socket.once('close', (hadError) => {
      if (hadError || stream.writableFinished) return void stream.destroy();
      // DSH Web hung up after its reply (a `connection: close` answer, its keep-alive
      // timeout): let the reply reach the phone first. Hanging up now would reset the
      // stream, and a reset discards whatever the phone has not read yet.
      const timer = setTimeout(() => stream.destroy(), DRAIN_MS);
      timer.unref();
      stream.once('finish', () => {
        clearTimeout(timer);
        stream.destroy();
      });
      if (!stream.writableEnded) stream.end();
    });
    stream.once('close', () => socket.destroy());
  }
}
