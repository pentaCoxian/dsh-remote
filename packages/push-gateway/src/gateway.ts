import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { ERRORS, errorEnvelope, type ErrorCode } from '@dsh-remote/protocol/errors';
import type { PushPlatform } from '@dsh-remote/protocol/push';
import { RateLimiter } from './limits.ts';
import type { Sender } from './senders/types.ts';
import type { HandleStore } from './store.ts';
import { isHandle, parseHandleRequest, parsePushRequest } from './validate.ts';

export interface GatewayLimits {
  readonly pushesPerHostPerMinute: number;
  readonly pushesPerHandlePerMinute: number;
  readonly registrationsPerPhonePerHour: number;
  readonly handlesPerPhone: number;
  readonly maxBodyBytes: number;
}

const DEFAULT_LIMITS: GatewayLimits = {
  pushesPerHostPerMinute: 120,
  pushesPerHandlePerMinute: 30,
  registrationsPerPhonePerHour: 20,
  handlesPerPhone: 50,
  maxBodyBytes: 8 * 1024,
};

export interface GatewayOptions {
  readonly store: HandleStore;
  /** A platform without a sender refuses registrations. */
  readonly senders: Partial<Record<PushPlatform, Sender>>;
  readonly now?: () => number;
  readonly limits?: Partial<GatewayLimits>;
}

export interface GatewayStats {
  delivered: number;
  gone: number;
  failed: number;
  registered: number;
}

class Refusal extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  BAD_REQUEST: 'The request is not valid.',
  NOT_FOUND: 'No such route.',
  METHOD_NOT_ALLOWED: 'Method not allowed.',
  HANDLE_GONE: 'This handle no longer delivers; register again.',
  RATE_LIMITED: 'Too many requests; try again later.',
  PAYLOAD_TOO_LARGE: 'The request body is too large.',
  UNAVAILABLE: 'Delivery is unavailable right now.',
  INTERNAL: 'Internal error.',
};

/**
 * The gateway's HTTP API, served over iroh: every connection is tagged with
 * the peer's EndpointId, which QUIC authenticated. Phones register device
 * tokens and get opaque handles bound to one host; that host alone may push
 * to them. Envelopes pass through unread.
 */
export class Gateway {
  readonly server: Server;
  readonly stats: GatewayStats = { delivered: 0, gone: 0, failed: 0, registered: 0 };
  private readonly peers = new WeakMap<object, string>();
  private readonly options: GatewayOptions;
  private readonly limits: GatewayLimits;
  private readonly perHost: RateLimiter;
  private readonly perHandle: RateLimiter;
  private readonly perPhone: RateLimiter;

  constructor(options: GatewayOptions) {
    this.options = options;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.perHost = new RateLimiter(this.limits.pushesPerHostPerMinute, 60_000);
    this.perHandle = new RateLimiter(this.limits.pushesPerHandlePerMinute, 60_000);
    this.perPhone = new RateLimiter(this.limits.registrationsPerPhonePerHour, 3_600_000);
    this.server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, (req, res) => {
      void this.handle(req, res);
    });
  }

  /** Serve one bi-stream from `peerId`. */
  accept(stream: Duplex, peerId: string): void {
    this.peers.set(stream, peerId);
    this.server.emit('connection', stream);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomBytes(8).toString('base64url');
    try {
      const peer = this.peers.get(req.socket);
      if (peer === undefined) throw new Refusal('UNAUTHENTICATED');
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (path === '/v1/handles') {
        if (req.method !== 'POST') throw new Refusal('METHOD_NOT_ALLOWED');
        return reply(res, 201, await this.register(peer, await readJson(req, this.limits.maxBodyBytes)));
      }
      if (path.startsWith('/v1/handles/')) {
        if (req.method !== 'DELETE') throw new Refusal('METHOD_NOT_ALLOWED');
        this.unregister(peer, path.slice('/v1/handles/'.length));
        return reply(res, 204, undefined);
      }
      if (path === '/v1/push') {
        if (req.method !== 'POST') throw new Refusal('METHOD_NOT_ALLOWED');
        return reply(res, 202, await this.push(peer, await readJson(req, this.limits.maxBodyBytes)));
      }
      throw new Refusal('NOT_FOUND');
    } catch (error) {
      const code = error instanceof Refusal ? error.code : 'INTERNAL';
      if (code === 'INTERNAL') console.error(`push-gateway: request ${requestId} failed: ${error instanceof Error ? error.message : String(error)}`);
      reply(res, ERRORS[code].status, errorEnvelope(code, MESSAGES[code] ?? 'Request refused.', requestId));
    }
  }

  private async register(phone: string, body: unknown): Promise<{ v: 1; handle: string }> {
    const request = parseHandleRequest(body);
    if (request === undefined || (request.platform === 'apns' && request.apnsEnvironment === undefined)) throw new Refusal('BAD_REQUEST');
    if (this.options.senders[request.platform] === undefined) throw new Refusal('UNAVAILABLE');
    const now = this.now();
    if (!this.perPhone.take(phone, now)) throw new Refusal('RATE_LIMITED');
    const { store } = this.options;
    const { handle, created } = store.upsert({ phone, host: request.host, platform: request.platform, token: request.token, env: request.apnsEnvironment ?? null }, now);
    if (created && store.countForPhone(phone) > this.limits.handlesPerPhone) {
      store.delete(handle);
      throw new Refusal('RATE_LIMITED');
    }
    this.stats.registered += 1;
    return { v: 1, handle };
  }

  private unregister(phone: string, handle: string): void {
    if (!isHandle(handle)) throw new Refusal('BAD_REQUEST');
    // Idempotent, and silent about handles that belong to someone else.
    if (this.options.store.get(handle)?.phone === phone) this.options.store.delete(handle);
  }

  private async push(host: string, body: unknown): Promise<{ v: 1 }> {
    const request = parsePushRequest(body);
    if (request === undefined) throw new Refusal('BAD_REQUEST');
    const { store } = this.options;
    const record = store.get(request.handle);
    // An unknown handle and someone else's look the same: the host should forget it.
    if (record === undefined || record.host !== host) throw new Refusal('HANDLE_GONE');
    const sender = this.options.senders[record.platform];
    if (sender === undefined) throw new Refusal('UNAVAILABLE');
    const now = this.now();
    if (!this.perHost.take(host, now) || !this.perHandle.take(record.handle, now)) throw new Refusal('RATE_LIMITED');
    const outcome = await sender.send({
      token: record.token,
      env: record.env,
      handle: record.handle,
      host,
      envelope: request.envelope,
      urgency: request.urgency,
      ...(request.collapseId === undefined ? {} : { collapseId: request.collapseId }),
    });
    if (outcome.ok) {
      store.touch(record.handle, now);
      this.stats.delivered += 1;
      return { v: 1 };
    }
    if (outcome.gone) {
      store.delete(record.handle);
      this.stats.gone += 1;
      throw new Refusal('HANDLE_GONE');
    }
    this.stats.failed += 1;
    console.warn(`push-gateway: ${record.platform} refused a push: ${outcome.reason}`);
    throw new Refusal('UNAVAILABLE');
  }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }).end(text);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new Refusal('BAD_REQUEST');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new Refusal('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Refusal('BAD_REQUEST');
  }
}
