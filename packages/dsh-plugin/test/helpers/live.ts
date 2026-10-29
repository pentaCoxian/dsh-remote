import { parsePairingUrl } from '@dsh-remote/protocol';
import WebSocket from 'ws';
import { MemoryAudit } from '../../src/core/audit.ts';
import { systemClock } from '../../src/core/clock.ts';
import { HostKey } from '../../src/core/host-key.ts';
import type { HostStateDocument } from '../../src/core/state.ts';
import { MemoryStore } from '../../src/core/store.ts';
import { RemoteHost } from '../../src/host.ts';
import type { WebGatewayOptions } from '../../src/web/gateway.ts';
import { FakeAdapter } from '../../src/testing/fake-adapter.ts';
import { send, TEST_PEER_HEADER, testPeerIdentity, toBody, TestPhone, type Reply, type SendOptions } from './phone.ts';

export interface LiveHost {
  readonly host: RemoteHost;
  readonly adapter: FakeAdapter;
  readonly audit: MemoryAudit;
  /** Loopback port; requests name their peer in a test header. */
  readonly port: number;
  /** `port` sends through another loopback port, e.g. an iroh dialer's. */
  signed(phone: TestPhone, options: SendOptions & { peer?: string; port?: number }): Promise<Reply>;
  pair(label?: string): Promise<TestPhone>;
  socket(phone: TestPhone, port?: number): Promise<TestSocket>;
  close(): Promise<void>;
}

export interface TestSocket {
  readonly ws: WebSocket;
  readonly frames: any[];
  send(frame: unknown): void;
  /** Resolve with the first not-yet-consumed frame matching `predicate`. */
  next(predicate: (frame: any) => boolean, timeoutMs?: number): Promise<any>;
  closed(): Promise<{ code: number; reason: string }>;
}

/**
 * RemoteHost on FakeAdapter over loopback. With `iroh`, the host also runs a
 * real endpoint with relays off, bound to 127.0.0.1; with `relays`, one homed on
 * those relays and bound to every interface, for phones on other machines.
 */
export async function startLiveHost(
  options: {
    remoteApprovalTimeoutMs?: number;
    iroh?: boolean;
    relays?: readonly string[];
    web?: WebGatewayOptions;
    push?: { gateway: string | null };
    /** A fixed key and state store: a later host given the same ones is this host restarted. */
    identity?: { hostKey: HostKey; stateStore: MemoryStore<HostStateDocument> };
  } = {},
): Promise<LiveHost> {
  const adapter = new FakeAdapter();
  adapter.addSession('session-a', { cwd: '/home/me/secret-client/api', title: 'Refactor the API' });
  adapter.addSession('session-b', { cwd: '/home/me/other', title: 'Unpublished' });
  const audit = new MemoryAudit();
  const host = await RemoteHost.create({
    adapter,
    clock: systemClock,
    hostKey: options.identity?.hostKey ?? HostKey.generate(),
    stateStore: options.identity?.stateStore ?? new MemoryStore(),
    receiptsStore: new MemoryStore(),
    audit,
    loopback: { port: 0, identify: testPeerIdentity },
    ...(options.relays !== undefined ? { iroh: { relays: options.relays } } : options.iroh === true ? { iroh: { relays: [], bindAddr: '127.0.0.1:0' } } : {}),
    hostName: 'Home Lab',
    ...(options.web === undefined ? {} : { web: options.web }),
    ...(options.push === undefined ? {} : { push: options.push }),
    grantTtlMs: 90 * 24 * 3600_000,
    remoteApprovalTimeoutMs: options.remoteApprovalTimeoutMs ?? 2_000,
    heartbeatMs: 150,
    bootMs: Date.now() - 5_000,
  });
  await host.publish('session-a');
  await host.start();
  const port = host.port!;
  await waitFor(() => host.events.snapshot('session-a') !== undefined);

  const signed: LiveHost['signed'] = async (phone, { peer, port: via, ...rest }) =>
    send(via ?? port, { ...rest, headers: { [TEST_PEER_HEADER]: peer ?? phone.peerId, ...phone.proofHeaders(rest.method, rest.target, toBody(rest.body)), ...rest.headers } });

  const pair: LiveHost['pair'] = async (label = 'Test Phone') => {
    const phone = new TestPhone();
    const offer = host.offerPairing('session-a');
    const payload = parsePairingUrl(offer.url)!;
    const redeem = await signed(phone, { method: 'POST', target: '/v1/pair/redeem', body: { challengeId: payload.challengeId, publicKey: phone.publicKey, deviceLabel: label, platform: 'ios', hardwareBacked: true } });
    if (redeem.status !== 201) throw new Error(`redeem: ${redeem.text}`);
    await host.approvePairing(redeem.json.pairingRequestId);
    const status = await signed(phone, { method: 'GET', target: `/v1/pair/requests/${redeem.json.pairingRequestId}` });
    phone.deviceId = status.json.grant.deviceId;
    return phone;
  };

  const socket: LiveHost['socket'] = async (phone, via = port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${via}/v1/events`, {
      headers: { [TEST_PEER_HEADER]: phone.peerId, ...phone.proofHeaders('GET', '/v1/events', Buffer.alloc(0)) },
    });
    const frames: any[] = [];
    const consumed = new Set<any>();
    const waiters = new Set<() => void>();
    ws.on('message', (data) => {
      frames.push(JSON.parse(data.toString('utf8')));
      for (const waiter of waiters) waiter();
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
      ws.once('error', reject);
    });
    return {
      ws,
      frames,
      send: (frame) => ws.send(JSON.stringify(frame)),
      closed: () => closed,
      next: (predicate, timeoutMs = 2_000) =>
        new Promise((resolve, reject) => {
          const check = () => {
            const frame = frames.find((f) => !consumed.has(f) && predicate(f));
            if (frame === undefined) return false;
            consumed.add(frame);
            waiters.delete(check as () => void);
            clearTimeout(timer);
            resolve(frame);
            return true;
          };
          const timer = setTimeout(() => {
            waiters.delete(check as () => void);
            reject(new Error(`no matching frame; got ${JSON.stringify(frames.map((f) => f.kind))}`));
          }, timeoutMs);
          if (!check()) waiters.add(check as () => void);
        }),
    };
  };

  return { host, adapter, audit, port, signed, pair, socket, close: () => host.stop() };
}

export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
