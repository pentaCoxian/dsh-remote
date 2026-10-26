import { createServer, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { ERRORS, errorEnvelope, HEADERS, isValid, LIMITS, type ErrorCode, type SchemaName, type Scope } from '@dsh-remote/protocol';
import type { Audit } from '../core/audit.ts';
import type { Clock } from '../core/clock.ts';
import { randomId } from '../core/ids.ts';
import type { PeerIdentity } from '../core/peer.ts';
import type { ProofHeaders, ProofVerifier, SignedRequest } from '../core/proof.ts';
import type { DeviceRecord } from '../core/state.ts';
import { matchPattern, parseTarget, type ParsedTarget } from './target.ts';

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: 'Connect through the DSH Remote app',
  DEVICE_UNPAIRED: 'Pair this phone on the host',
  DEVICE_REVOKED: 'Access removed by the host',
  TIMESTAMP_SKEW: 'Request clock is out of range',
  PROTOCOL_UNSUPPORTED: 'Update DSH Remote to talk to this host',
  RATE_LIMITED: 'Too many attempts; wait a minute',
  UNAVAILABLE: 'The host cannot do that right now',
};

/** A refusal raised anywhere below the router; becomes the spec §6 error envelope. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly extra: { serverTime?: number };

  constructor(code: ErrorCode, message?: string, extra: { serverTime?: number } = {}) {
    super(message ?? MESSAGES[code] ?? code.toLowerCase().replaceAll('_', ' '));
    this.code = code;
    this.extra = extra;
  }
}

export interface RequestContext {
  readonly requestId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: ReadonlyMap<string, string>;
  readonly identity: PeerIdentity;
  readonly body: unknown;
  /** The request as signed, for routes that verify a pending key themselves. */
  readonly signed: SignedRequest;
}

export interface DeviceContext extends RequestContext {
  readonly device: DeviceRecord;
}

export interface Reply {
  readonly status: number;
  readonly body: unknown;
}

interface RouteBase {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Pattern such as `/v1/sessions/:sessionId`. */
  readonly path: string;
  /** Schema for the JSON body; routes without one take no body. */
  readonly body?: SchemaName;
}
export type Route =
  | (RouteBase & { readonly auth: 'device'; readonly scope: Scope; handle(ctx: DeviceContext): Promise<Reply> })
  /** Pairing routes: peer identity only; the handler proves the phone's new key itself. */
  | (RouteBase & { readonly auth: 'pending'; handle(ctx: RequestContext): Promise<Reply> });

export interface UpgradeRoute {
  readonly path: string;
  readonly scope: Scope;
  handle(ctx: DeviceContext, req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export interface NativeApiOptions {
  readonly proof: ProofVerifier;
  readonly routes: readonly Route[];
  readonly upgrade?: UpgradeRoute;
  readonly audit: Audit;
  readonly clock: Clock;
  /**
   * TESTS AND THE DEV HOST ONLY: the peer identity of a loopback TCP request,
   * which carries no QUIC key. Without it `listen` refuses to start, so
   * production serves authenticated iroh streams and nothing else.
   */
  readonly loopbackIdentity?: (req: IncomingMessage) => PeerIdentity | undefined;
}

/** Headers that must appear at most once; Node would otherwise join duplicates. */
const SINGLE_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'authorization',
  HEADERS.protocol,
  HEADERS.deviceId,
  HEADERS.timestamp,
  HEADERS.nonce,
  HEADERS.signature,
]);

function hasDuplicateHeaders(req: IncomingMessage): boolean {
  const seen = new Set<string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase();
    if (!SINGLE_HEADERS.has(name)) continue;
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function proofHeaders(req: IncomingMessage): ProofHeaders {
  return {
    protocol: header(req, HEADERS.protocol),
    deviceId: header(req, HEADERS.deviceId),
    timestamp: header(req, HEADERS.timestamp),
    nonce: header(req, HEADERS.nonce),
    signature: header(req, HEADERS.signature),
  };
}

/** Open HTTP connections (iroh streams plus any loopback sockets). */
const MAX_CONNECTIONS = 64;

const JSON_TYPE = /^application\/json(\s*;\s*charset=utf-8)?$/i;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = header(req, 'content-length');
  if (declared !== undefined && (!/^\d{1,10}$/.test(declared) || Number(declared) > LIMITS.maxBodyBytes)) {
    throw new ApiError('PAYLOAD_TOO_LARGE');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > LIMITS.maxBodyBytes) throw new ApiError('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function hasBody(req: IncomingMessage): boolean {
  const length = header(req, 'content-length');
  return header(req, 'transfer-encoding') !== undefined || (length !== undefined && length !== '0');
}

/**
 * The native API over iroh streams. Each stream arrives already tagged with
 * the peer key QUIC authenticated; every route except pairing also needs a
 * paired device's signature. It serves only its route table: no proxy, no files.
 */
export class NativeApi {
  private readonly server: Server;
  private readonly sockets = new Set<Duplex>();
  private readonly peers = new WeakMap<Duplex, PeerIdentity>();
  private readonly compiled: { route: Route; pattern: string[] }[];

  private readonly options: NativeApiOptions;

  constructor(options: NativeApiOptions) {
    this.options = options;
    this.compiled = options.routes.map((route) => ({ route, pattern: route.path.slice(1).split('/') }));
    this.server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 10_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, (req, res) => {
      void this.handle(req, res);
    });
    this.server.maxConnections = MAX_CONNECTIONS;
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    });
    this.server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      else socket.destroy();
    });
  }

  /** Serve one iroh bi-stream as an HTTP connection from `peer`. */
  accept(stream: Duplex, peer: PeerIdentity): void {
    if (this.sockets.size >= MAX_CONNECTIONS) {
      stream.destroy();
      return;
    }
    this.peers.set(stream, peer);
    this.server.emit('connection', stream);
  }

  /**
   * TESTS AND THE DEV HOST ONLY: also listen on 127.0.0.1 (never another
   * address). Retries briefly so a hot reload can reclaim the port.
   */
  async listen(port: number): Promise<number> {
    if (this.options.loopbackIdentity === undefined) throw new Error('native api: loopback listening needs a test identity source');
    for (let attempt = 0; ; attempt += 1) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          this.server.once('error', onError);
          this.server.listen(port, '127.0.0.1', () => {
            this.server.off('error', onError);
            resolve();
          });
        });
        const address = this.server.address();
        return typeof address === 'object' && address !== null ? address.port : port;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= 10) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }

  /** Stop listening and drop every connection, including upgraded WebSockets. */
  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    for (const socket of this.sockets) socket.destroy();
    await closed;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomId('trace', 9);
    const started = this.options.clock.now();
    let routeName = 'unmatched';
    let deviceId: string | undefined;
    try {
      const { route, params, query } = this.findRoute(req);
      routeName = `${route.method} ${route.path}`;
      const identity = this.authenticate(req);
      if (route.body === undefined && hasBody(req)) throw new ApiError('BAD_REQUEST');
      const rawBody = route.body === undefined ? Buffer.alloc(0) : await readBody(req);
      const signed: SignedRequest = { method: req.method!, target: req.url!, body: rawBody, headers: proofHeaders(req), identity };
      let device: DeviceRecord | undefined;
      if (route.auth === 'device') {
        const proof = this.options.proof.verifyDevice(signed, route.scope);
        if (!proof.ok) throw new ApiError(proof.code, undefined, proof.serverTime === undefined ? {} : { serverTime: proof.serverTime });
        device = proof.device;
        deviceId = device.deviceId;
      }
      const body = route.body === undefined ? undefined : parseJsonBody(req, rawBody, route.body);
      const base: RequestContext = { requestId, params, query, identity, body, signed };
      const reply = route.auth === 'device' ? await route.handle({ ...base, device: device! }) : await route.handle(base);
      this.send(res, reply.status, reply.body, requestId);
      this.audit('http', requestId, routeName, reply.status, started, deviceId);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('INTERNAL', 'Internal error');
      const status = ERRORS[apiError.code].status;
      this.send(res, status, errorEnvelope(apiError.code, apiError.message, requestId, apiError.extra), requestId, true);
      // Unexpected errors are logged by name only: messages can carry paths or prompt text.
      this.audit('http', requestId, routeName, status, started, deviceId, apiError.code, error instanceof ApiError ? undefined : errorName(error));
    }
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const requestId = randomId('trace', 9);
    const started = this.options.clock.now();
    const upgrade = this.options.upgrade;
    try {
      this.checkRequest(req);
      if (upgrade === undefined || req.url !== upgrade.path || req.method !== 'GET' || hasBody(req)) throw new ApiError('NOT_FOUND');
      const identity = this.authenticate(req);
      const signed: SignedRequest = { method: 'GET', target: req.url, body: Buffer.alloc(0), headers: proofHeaders(req), identity };
      const proof = this.options.proof.verifyDevice(signed, upgrade.scope);
      if (!proof.ok) throw new ApiError(proof.code, undefined, proof.serverTime === undefined ? {} : { serverTime: proof.serverTime });
      this.audit('upgrade', requestId, upgrade.path, 101, started, proof.device.deviceId);
      upgrade.handle({ requestId, params: {}, query: new Map(), identity, body: undefined, signed, device: proof.device }, req, socket, head);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('INTERNAL', 'Internal error');
      const status = ERRORS[apiError.code].status;
      const text = JSON.stringify(errorEnvelope(apiError.code, apiError.message, requestId, apiError.extra));
      socket.end(
        `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(text)}\r\n` +
          `cache-control: no-store\r\nx-dsh-request-id: ${requestId}\r\nconnection: close\r\n\r\n${text}`,
      );
      this.audit('upgrade', requestId, upgrade?.path ?? 'unmatched', status, started, undefined, apiError.code);
    }
  }

  /** Duplicate headers and the target grammar. `Host` means nothing over a key-dialed stream. */
  private checkRequest(req: IncomingMessage): ParsedTarget {
    if (hasDuplicateHeaders(req)) throw new ApiError('BAD_REQUEST');
    const parsed = parseTarget(req.url ?? '');
    if (!parsed.ok) throw new ApiError(parsed.reason === 'query' ? 'BAD_REQUEST' : 'NOT_FOUND');
    return parsed.target;
  }

  private findRoute(req: IncomingMessage): { route: Route; params: Record<string, string>; query: ReadonlyMap<string, string> } {
    const target = this.checkRequest(req);
    let pathMatched = false;
    for (const { route, pattern } of this.compiled) {
      const params = matchPattern(pattern, target.segments);
      if (params === undefined) continue;
      pathMatched = true;
      if (route.method === req.method) return { route, params, query: target.query };
    }
    throw new ApiError(pathMatched ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND');
  }

  private authenticate(req: IncomingMessage): PeerIdentity {
    const peer = this.peers.get(req.socket) ?? this.options.loopbackIdentity?.(req);
    if (peer === undefined) throw new ApiError('UNAUTHENTICATED');
    return peer;
  }

  private send(res: ServerResponse, status: number, body: unknown, requestId: string, close = false): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-dsh-request-id': requestId,
      ...(close ? { connection: 'close' } : {}),
    });
    res.end(text);
  }

  private audit(event: string, requestId: string, route: string, status: number, started: number, deviceId?: string, code?: string, detail?: string): void {
    this.options.audit.record({
      event,
      requestId,
      route,
      status,
      latencyMs: this.options.clock.now() - started,
      ...(deviceId === undefined ? {} : { deviceId }),
      ...(code === undefined ? {} : { code }),
      ...(detail === undefined ? {} : { detail }),
    });
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function parseJsonBody(req: IncomingMessage, raw: Buffer, schema: SchemaName): unknown {
  if (!JSON_TYPE.test(header(req, 'content-type') ?? '')) throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new ApiError('BAD_REQUEST');
  }
  if (!isValid(schema, value)) throw new ApiError('BAD_REQUEST');
  return value;
}
