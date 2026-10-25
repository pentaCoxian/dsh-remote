import { HEADERS, parsePairingUrl } from '@dsh-remote/protocol';
import WebSocket from 'ws';
import { MemoryAudit } from '../../src/core/audit.ts';
import { systemClock } from '../../src/core/clock.ts';
import { HostIdentity } from '../../src/core/host-identity.ts';
import { MemoryStore } from '../../src/core/store.ts';
import { RemoteHost } from '../../src/host.ts';
import { FakeAdapter } from '../../src/testing/fake-adapter.ts';
import { testIssuer, type TestIssuer } from './access.ts';
import { send, toBody, TestPhone, type Reply, type SendOptions } from './phone.ts';

export interface LiveHost {
  readonly host: RemoteHost;
  readonly adapter: FakeAdapter;
  readonly issuer: TestIssuer;
  readonly audit: MemoryAudit;
  readonly port: number;
  signed(phone: TestPhone, options: SendOptions & { sub?: string }): Promise<Reply>;
  pair(label?: string): Promise<TestPhone>;
  socket(phone: TestPhone): Promise<TestSocket>;
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

export async function startLiveHost(options: { remoteApprovalTimeoutMs?: number } = {}): Promise<LiveHost> {
  const issuer = await testIssuer();
  const adapter = new FakeAdapter();
  adapter.addSession('session-a', { cwd: '/home/me/secret-client/api', title: 'Refactor the API' });
  adapter.addSession('session-b', { cwd: '/home/me/other', title: 'Unpublished' });
  const audit = new MemoryAudit();
  const host = await RemoteHost.create({
    adapter,
    access: issuer.verifier,
    clock: systemClock,
    identity: HostIdentity.generate(),
    stateStore: new MemoryStore(),
    receiptsStore: new MemoryStore(),
    audit,
    publicHost: 'dsh.example.com',
    linkOrigin: 'https://link.example.com',
    port: 0,
    hostName: 'Home Lab',
    grantTtlMs: 90 * 24 * 3600_000,
    remoteApprovalTimeoutMs: options.remoteApprovalTimeoutMs ?? 2_000,
    heartbeatMs: 150,
    bootMs: Date.now() - 5_000,
  });
  await host.publish('session-a');
  const port = await host.start();
  await waitFor(() => host.events.snapshot('session-a') !== undefined);

  const signed: LiveHost['signed'] = async (phone, { sub, ...rest }) => {
    const assertion = await issuer.assertion(sub === undefined ? {} : { sub });
    return send(port, { ...rest, headers: { [HEADERS.accessAssertion]: assertion, ...phone.proofHeaders(rest.method, rest.target, toBody(rest.body)), ...rest.headers } });
  };

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

  const socket: LiveHost['socket'] = async (phone) => {
    const assertion = await issuer.assertion();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, {
      headers: { host: 'dsh.example.com', [HEADERS.accessAssertion]: assertion, ...phone.proofHeaders('GET', '/v1/events', Buffer.alloc(0)) },
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

  return { host, adapter, issuer, audit, port, signed, pair, socket, close: () => host.stop() };
}

export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
