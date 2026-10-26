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

/**
 * The DSH Web tunnel's host end. A phone opens a window with a request signed
 * by its hardware key; while it is open, every bi-stream on that peer's
 * `dsh-remote/web/1` connection is piped to DSH Web's loopback listener. DSH's
 * own gate still applies on the other side: its Host/Origin fence accepts
 * loopback authorities on any port, and its owner cookie comes from DSH's launch
 * token, so the phone runs DSH Web exactly as a local browser would.
 */
export class WebGateway {
  private readonly windows = new Map<string, { deviceId: string; until: number }>();
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
  open(device: DeviceRecord): { tokenQuery: string; expiresAt: number } | undefined {
    const tokenQuery = this.options.launchTokenQuery();
    if (tokenQuery === undefined || this.unavailable() !== undefined) return undefined;
    const expiresAt = Math.min(this.clock.now() + this.windowMs, device.expiresAt);
    this.windows.set(device.peerId, { deviceId: device.deviceId, until: expiresAt });
    return { tokenQuery, expiresAt };
  }

  /** Whether `peer` may use the tunnel now: an open window and a device grant still live. */
  allows(peer: PeerIdentity): boolean {
    const window = this.windows.get(peer.peerId);
    if (window === undefined) return false;
    const device = this.state.device(window.deviceId);
    const now = this.clock.now();
    if (window.until <= now || device === undefined || device.revokedAt !== null || device.expiresAt <= now || device.peerId !== peer.peerId || !device.scopes.includes('web:open')) {
      this.windows.delete(peer.peerId);
      return false;
    }
    return true;
  }

  /** Close the window of a revoked device. */
  forget(peerId: string): void {
    this.windows.delete(peerId);
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
    socket.once('close', () => stream.destroy());
    stream.once('close', () => socket.destroy());
  }
}
