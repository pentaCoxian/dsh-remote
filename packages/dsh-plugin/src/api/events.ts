import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { CLOSE_CODES, decodeCursor, isValid, LIMITS, PROTOCOL_VERSION } from '@dsh-remote/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Approvals, RemoteApproval } from '../core/approvals.ts';
import type { Clock } from '../core/clock.ts';
import type { EventHub, FeedSink } from '../core/events.ts';
import type { LeaseChange, Leases } from '../core/leases.ts';
import type { DeviceRecord, HostState } from '../core/state.ts';
import type { TimelineItem } from '../core/translate.ts';
import type { DeviceContext, UpgradeRoute } from '../http/server.ts';

export interface EventsDeps {
  readonly events: EventHub;
  readonly state: HostState;
  readonly leases: Leases;
  readonly approvals: Approvals;
  readonly clock: Clock;
  readonly heartbeatMs?: number;
}

/** Above this much unsent data a client is closed; it resumes from its cursor. */
const MAX_BUFFERED = 1024 * 1024;
const TRY_AGAIN_LATER = 1013;

class Client implements FeedSink {
  readonly device: DeviceRecord;
  readonly subscriptions = new Map<string, () => void>();
  private readonly ws: WebSocket;
  private readonly owner: EventsSocket;
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private alive = true;
  private ephemeralCounter = 0;

  constructor(ws: WebSocket, device: DeviceRecord, owner: EventsSocket) {
    this.ws = ws;
    this.device = device;
    this.owner = owner;
    const now = owner.deps.clock.now();
    // The grant was checked at the upgrade; close when it lapses.
    this.timers.push(setTimeout(() => this.close(CLOSE_CODES.deviceRevoked, 'grant expired'), Math.max(0, Math.min(device.expiresAt - now, 2 ** 31 - 1))));
    const heartbeat = setInterval(() => {
      if (!this.alive) {
        this.ws.terminate();
        return;
      }
      this.alive = false;
      this.ws.ping();
      this.notify('heartbeat', undefined, { serverTime: owner.deps.clock.now() });
    }, owner.deps.heartbeatMs ?? LIMITS.heartbeatMs);
    this.timers.push(heartbeat);
    ws.on('pong', () => (this.alive = true));
    ws.on('message', (data, isBinary) => this.receive(data.toString('utf8'), isBinary));
    ws.on('close', () => this.dispose());
    ws.on('error', () => this.ws.terminate());
    this.notify('hello', undefined, { serverTime: now, heartbeatMs: owner.deps.heartbeatMs ?? LIMITS.heartbeatMs, deviceId: device.deviceId });
  }

  item(sessionId: string, item: TimelineItem, cursor: string): void {
    this.send({ v: PROTOCOL_VERSION, type: 'session.event', sessionId, eventId: item.eventId, seq: item.seq, cursor, kind: item.kind, at: item.at, payload: item.payload });
  }

  ephemeral(sessionId: string, kind: string, payload: Record<string, unknown>): void {
    this.ephemeralCounter += 1;
    this.send({ v: PROTOCOL_VERSION, type: 'session.event', sessionId, eventId: `x${this.ephemeralCounter}`, ephemeral: true, kind, at: this.owner.deps.clock.now(), payload });
  }

  /** FeedSink: the hub ended this subscription (resync or unpublish). */
  control(sessionId: string, kind: 'resync.required' | 'session.unpublished', payload: Record<string, unknown>): void {
    this.subscriptions.delete(sessionId);
    this.notify(kind, sessionId, payload);
  }

  notify(kind: string, sessionId: string | undefined, payload: Record<string, unknown>): void {
    if (kind === 'resync.required' || kind === 'session.unpublished') {
      if (sessionId !== undefined) this.subscriptions.delete(sessionId);
    }
    this.send({ v: PROTOCOL_VERSION, type: 'control', kind, ...(sessionId === undefined ? {} : { sessionId }), payload });
  }

  close(code: number, reason: string): void {
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) this.ws.close(code, reason);
    this.dispose();
  }

  private receive(text: string, isBinary: boolean): void {
    this.alive = true;
    let frame: unknown;
    try {
      frame = isBinary ? undefined : JSON.parse(text);
    } catch {
      frame = undefined;
    }
    if (!isValid('ClientFrame', frame)) {
      this.close(1008, 'invalid frame');
      return;
    }
    const message = frame as { op: 'subscribe' | 'unsubscribe' | 'ping'; sessionId?: string; after?: string };
    if (message.op === 'ping') {
      for (const sessionId of this.subscriptions.keys()) this.owner.deps.leases.touch(sessionId, this.device.deviceId);
      this.notify('pong', undefined, { serverTime: this.owner.deps.clock.now() });
      return;
    }
    const sessionId = message.sessionId!;
    this.subscriptions.get(sessionId)?.();
    this.subscriptions.delete(sessionId);
    if (message.op === 'unsubscribe') return;
    if (!this.owner.deps.state.isPublished(sessionId)) {
      this.notify('error', sessionId, { code: 'SESSION_NOT_PUBLISHED' });
      return;
    }
    let afterSeq: number | undefined;
    if (message.after !== undefined) {
      const cursor = decodeCursor(message.after);
      if (cursor === undefined || cursor.sessionId !== sessionId) {
        this.notify('resync.required', sessionId, { reason: 'CURSOR_INVALID' });
        return;
      }
      afterSeq = cursor.seq;
    }
    const result = this.owner.deps.events.subscribe(sessionId, afterSeq, this);
    if (result.kind === 'resync') {
      this.notify('resync.required', sessionId, { reason: 'CURSOR_EXPIRED' });
      return;
    }
    if (result.kind === 'unavailable') {
      this.notify('error', sessionId, { code: 'UNAVAILABLE', retryable: true });
      return;
    }
    this.subscriptions.set(sessionId, result.unsubscribe);
    const holder = this.owner.deps.leases.holder(sessionId);
    this.notify('subscribed', sessionId, { cursor: result.cursor, replayed: result.replay.length, controller: holder === null ? null : { deviceId: holder.deviceId, label: holder.label } });
    for (const item of result.replay) this.item(sessionId, item, result.cursor);
  }

  private send(frame: unknown): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED) {
      this.close(TRY_AGAIN_LATER, 'client too slow');
      return;
    }
    this.ws.send(JSON.stringify(frame));
  }

  private dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.owner.forget(this);
  }
}

/**
 * `GET /v1/events` after an authenticated, device-signed upgrade. Read-only:
 * every mutation goes through signed REST. Clients subscribe per session with
 * the cursor of the snapshot they hold.
 */
export class EventsSocket {
  readonly deps: EventsDeps;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  private readonly clients = new Set<Client>();
  private readonly disposers: (() => void)[] = [];

  constructor(deps: EventsDeps) {
    this.deps = deps;
    this.disposers.push(
      deps.state.onDeviceRevoked((device) => {
        for (const client of [...this.clients]) if (client.device.deviceId === device.deviceId) client.close(CLOSE_CODES.deviceRevoked, 'device revoked');
      }),
      deps.leases.onChange((change) => this.leaseChanged(change)),
      deps.approvals.onChange((approval) => this.approvalChanged(approval)),
    );
  }

  readonly route: UpgradeRoute = {
    path: '/v1/events',
    scope: 'session:read',
    handle: (ctx: DeviceContext, req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.clients.add(new Client(ws, ctx.device, this));
      });
    },
  };

  forget(client: Client): void {
    this.clients.delete(client);
  }

  /** Close every socket (host shutting down or reloading). */
  close(): void {
    for (const dispose of this.disposers) dispose();
    for (const client of [...this.clients]) client.close(CLOSE_CODES.hostRestarting, 'host restarting');
    this.wss.close();
  }

  private leaseChanged(change: LeaseChange): void {
    const holder = change.holder === null ? null : { deviceId: change.holder.deviceId, label: change.holder.label };
    for (const client of this.clients) {
      if (!client.subscriptions.has(change.sessionId) && change.lost !== client.device.deviceId) continue;
      client.notify('lease.changed', change.sessionId, { controller: holder });
      if (change.lost === client.device.deviceId) client.notify('lease.lost', change.sessionId, { controller: holder });
    }
  }

  private approvalChanged(approval: RemoteApproval): void {
    for (const client of this.clients) {
      if (client.device.scopes.includes('approval:read')) client.notify('approvals.changed', approval.sessionId, { approval });
    }
  }
}
