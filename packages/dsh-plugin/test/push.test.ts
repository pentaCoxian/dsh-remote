import { randomBytes } from 'node:crypto';
import { IrohHttpClient } from '@dsh-remote/iroh-http';
import { isValid, openPush, PUSH_ALPN, WEB_ALPN, type PushEvents, type PushMessage } from '@dsh-remote/protocol';
import { Gateway, GatewayTransport, HandleStore, type OutboundPush, type Sender, type SendOutcome } from '@dsh-remote/push-gateway';
import iroh from '@number0/iroh';
import type { Endpoint } from '@number0/iroh';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemClock } from '../src/core/clock.ts';
import { HostState, type HostStateDocument } from '../src/core/state.ts';
import { MemoryStore } from '../src/core/store.ts';
import { startFakeDshWeb, type FakeDshWeb } from './helpers/fake-dsh-web.ts';
import { dialTicket, type IrohDialer } from './helpers/iroh.ts';
import { startLiveHost, waitFor, type LiveHost } from './helpers/live.ts';
import { TestPhone } from './helpers/phone.ts';

const { Endpoint: EndpointClass, EndpointTicket, RelayMode, SecretKey } = iroh;
const TOKEN = 'launch-token-0123456789abcdef';
const APPROVALS_ONLY: PushEvents = { approval: true, turnFinished: false, turnFailed: false };

class RecordingSender implements Sender {
  readonly sent: OutboundPush[] = [];
  next: SendOutcome = { ok: true };
  async send(push: OutboundPush): Promise<SendOutcome> {
    this.sent.push(push);
    return this.next;
  }
  close(): void {}
}

interface Phone {
  readonly phone: TestPhone;
  readonly api: IrohDialer;
  readonly secretKey: number[];
  readonly key: Buffer;
  handle: string;
}

describe('notifications through the push gateway', () => {
  let gateway: GatewayTransport;
  let store: HandleStore;
  let fcm: RecordingSender;
  let web: FakeDshWeb;
  let live: LiveHost;
  const dialers: IrohDialer[] = [];
  const endpoints: Endpoint[] = [];
  const clients: IrohHttpClient[] = [];

  beforeEach(async () => {
    store = HandleStore.open(':memory:');
    fcm = new RecordingSender();
    const app = new Gateway({ store, senders: { fcm } });
    // Loopback, like the test host: an endpoint bound to 127.0.0.1 cannot reach LAN addresses.
    gateway = await GatewayTransport.start({ secretKey: SecretKey.generate().toBytes(), relays: [], bindAddr: '127.0.0.1:0', onStream: (stream, peerId) => app.accept(stream, peerId) });
    web = await startFakeDshWeb(TOKEN);
    live = await startLiveHost({
      iroh: true,
      web: { target: () => ({ host: '127.0.0.1', port: web.port }), launchTokenQuery: () => `token=${TOKEN}` },
      push: { gateway: gateway.ticket() },
    });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const dialer of dialers.splice(0)) await dialer.close();
    for (const endpoint of endpoints.splice(0)) await endpoint.close();
    await live.close();
    await web.close();
    await gateway.close();
    store.close();
  });

  const dial = async (alpn: string | undefined, secretKey: number[]) => {
    const dialer = await dialTicket(live.host.endpoint!.ticket(), { secretKey, ...(alpn === undefined ? {} : { alpn }) });
    dialers.push(dialer);
    return dialer;
  };

  /** Pair over iroh, register the phone's token at the gateway, and give the host the handle and a fresh key. */
  const registeredPhone = async (events: PushEvents = APPROVALS_ONLY): Promise<Phone> => {
    const secretKey = SecretKey.generate().toBytes();
    const api = await dial(undefined, secretKey);
    const phone = new TestPhone();
    const challenge = live.host.pairing.createChallenge();
    const redeem = await live.signed(phone, { method: 'POST', target: '/v1/pair/redeem', body: { challengeId: challenge.challengeId, publicKey: phone.publicKey, deviceLabel: 'Pixel', platform: 'android', hardwareBacked: true }, port: api.port });
    await live.host.approvePairing(redeem.json.pairingRequestId);
    phone.deviceId = (await live.signed(phone, { method: 'GET', target: `/v1/pair/requests/${redeem.json.pairingRequestId}`, port: api.port })).json.grant.deviceId;

    const status = await live.signed(phone, { method: 'GET', target: '/v1/push', port: api.port });
    expect(status.json).toEqual({ v: 1, gateway: gateway.ticket(), registered: false, events: APPROVALS_ONLY });
    const builder = EndpointClass.builder();
    builder.applyMinimal();
    builder.relayMode(RelayMode.disabled());
    builder.secretKey(secretKey);
    const endpoint = await builder.bind();
    endpoints.push(endpoint);
    const toGateway = new IrohHttpClient(endpoint, () => EndpointTicket.fromString(status.json.gateway).endpointAddr(), PUSH_ALPN);
    clients.push(toGateway);
    const handle = (await toGateway.request('POST', '/v1/handles', { platform: 'fcm', token: 'fcm-token-pixel', host: live.host.hostId })).body as { handle: string };

    const key = randomBytes(32);
    const result: Phone = { phone, api, secretKey, key, handle: handle.handle };
    await register(result, events);
    return result;
  };

  const register = async (phone: Phone, events: PushEvents) => {
    const reply = await live.signed(phone.phone, { method: 'PUT', target: '/v1/push', body: { gateway: gateway.endpointId, handle: phone.handle, key: phone.key.toString('base64url'), platform: 'fcm', events }, port: phone.api.port });
    expect(reply.status).toBe(200);
    expect(isValid('PushStatus', reply.json)).toBe(true);
    expect(reply.json.registered).toBe(true);
  };

  const opened = (phone: Phone, index: number): PushMessage => openPush(phone.key, live.host.hostId, phone.handle, fcm.sent[index]!.envelope)!;

  const turnWithReply = (sessionId: string, reply: string) => {
    live.adapter.startTurn(sessionId, 'go');
    live.adapter.append(sessionId, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
  };

  it('seals an approval for a phone that is away; only that phone can read it', async () => {
    const phone = await registeredPhone();
    live.adapter.startTurn('session-a', 'deploy it');
    void live.adapter.askApproval('session-a', 'shell', '{"command":"make deploy"}');
    await waitFor(() => fcm.sent.length === 1);
    const push = fcm.sent[0]!;
    expect(push).toMatchObject({ token: 'fcm-token-pixel', handle: phone.handle, host: live.host.hostId, urgency: 'high' });
    expect(push.collapseId).toMatch(/^apr_[A-Za-z0-9_-]{22}$/);
    expect(push.envelope).not.toContain('shell');
    const message = opened(phone, 0);
    expect(isValid('PushMessage', message)).toBe(true);
    expect(message).toMatchObject({ v: 1, kind: 'approval', hostId: live.host.hostId, hostName: 'Home Lab', sessionId: 'session-a', title: 'Refactor the API', body: 'Approval needed: shell\nshell needs approval' });
    expect(openPush(randomBytes(32), live.host.hostId, phone.handle, push.envelope)).toBeUndefined();
    live.adapter.answerLocally('rejected');
  });

  it('stays quiet while the phone has DSH Web open', async () => {
    const phone = await registeredPhone();
    expect((await live.signed(phone.phone, { method: 'POST', target: '/v1/web/session', port: phone.api.port })).status).toBe(200);
    await dial(WEB_ALPN, phone.secretKey);
    await waitFor(() => live.host.endpoint!.webPresent(live.host.state.device(phone.phone.deviceId)!.peerId, 0));
    live.adapter.startTurn('session-b', 'hi');
    void live.adapter.askApproval('session-b', 'shell', '{}');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fcm.sent).toHaveLength(0);
    live.adapter.answerLocally('rejected');
  });

  it('sends finished and failed turns only to phones that opted in, one per burst', async () => {
    const phone = await registeredPhone();
    turnWithReply('session-a', '\n  All 42 tests pass.\nDetails follow.');
    live.adapter.endTurn('session-a');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fcm.sent).toHaveLength(0);

    await register(phone, { approval: true, turnFinished: true, turnFailed: true });
    turnWithReply('session-a', 'Deployed to staging.');
    live.adapter.endTurn('session-a');
    await waitFor(() => fcm.sent.length === 1);
    expect(opened(phone, 0)).toMatchObject({ kind: 'turn.finished', title: 'Refactor the API', body: 'Deployed to staging.' });
    expect(fcm.sent[0]!.urgency).toBe('normal');

    // A queued turn right after: coalesced.
    turnWithReply('session-a', 'And production.');
    live.adapter.endTurn('session-a');
    live.adapter.startTurn('session-b', 'x');
    live.adapter.append('session-b', 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'model overloaded\nretry later' } } });
    await waitFor(() => fcm.sent.length === 2);
    expect(opened(phone, 1)).toMatchObject({ kind: 'turn.failed', sessionId: 'session-b', title: 'Unpublished', body: 'Turn failed: model overloaded' });

    // Within the burst window for session-b: coalesced. A session of its own: sent.
    live.adapter.failSession('session-b', 'agent crashed');
    live.adapter.addSession('session-c', { cwd: '/home/me/nightly', title: '' });
    live.adapter.failSession('session-c', 'agent crashed\nat loop.ts:12');
    await waitFor(() => fcm.sent.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fcm.sent).toHaveLength(3);
    expect(opened(phone, 2)).toMatchObject({ kind: 'turn.failed', sessionId: 'session-c', title: 'nightly', body: 'The agent stopped: agent crashed' });

    live.adapter.startTurn('session-b', 'stop');
    live.adapter.endTurn('session-b', 'aborted');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fcm.sent).toHaveLength(3);
  });

  it('forgets a registration whose token the platform dropped', async () => {
    const phone = await registeredPhone();
    fcm.next = { ok: false, gone: true, reason: '404 UNREGISTERED' };
    live.adapter.startTurn('session-a', 'go');
    void live.adapter.askApproval('session-a', 'shell', '{}');
    await waitFor(() => live.host.state.device(phone.phone.deviceId)?.push === undefined);
    expect(store.get(phone.handle)).toBeUndefined();
    expect((await live.signed(phone.phone, { method: 'GET', target: '/v1/push', port: phone.api.port })).json.registered).toBe(false);
    live.adapter.answerLocally('rejected');
  });

  it('sends a test notification on request, and refuses bad registrations', async () => {
    const phone = await registeredPhone();
    const test = await live.signed(phone.phone, { method: 'POST', target: '/v1/push/test', port: phone.api.port });
    expect(test.status).toBe(202);
    expect(opened(phone, 0)).toMatchObject({ kind: 'test', title: 'Test notification', hostName: 'Home Lab', body: 'Notifications from this host work.' });

    const put = (body: Record<string, unknown>) => live.signed(phone.phone, { method: 'PUT', target: '/v1/push', body: { gateway: gateway.endpointId, handle: phone.handle, key: phone.key.toString('base64url'), platform: 'fcm', events: APPROVALS_ONLY, ...body }, port: phone.api.port });
    expect((await put({ gateway: 'f'.repeat(64) })).status).toBe(400);
    expect((await put({ key: 'A'.repeat(42) })).status).toBe(400);
    expect((await put({ events: { approval: true } })).status).toBe(400);

    expect((await live.signed(phone.phone, { method: 'DELETE', target: '/v1/push', port: phone.api.port })).json.registered).toBe(false);
    expect((await live.signed(phone.phone, { method: 'POST', target: '/v1/push/test', port: phone.api.port })).status).toBe(404);
  });

  it('drops the push route when the device is revoked', async () => {
    const phone = await registeredPhone();
    expect(live.host.status().push).toEqual({ gateway: gateway.endpointId, devices: 1 });
    await live.host.revokeDevice(phone.phone.deviceId);
    expect(live.host.state.device(phone.phone.deviceId)?.push).toBeUndefined();
    expect(live.host.status().push.devices).toBe(0);
  });
});

describe('a host with notifications off', () => {
  it('says so and refuses registrations', async () => {
    const live = await startLiveHost({ push: { gateway: null } });
    try {
      const phone = await live.pair();
      expect((await live.signed(phone, { method: 'GET', target: '/v1/push' })).json).toEqual({ v: 1, gateway: null, registered: false, events: APPROVALS_ONLY });
      const reply = await live.signed(phone, { method: 'PUT', target: '/v1/push', body: { gateway: 'a'.repeat(64), handle: 'A'.repeat(22), key: 'B'.repeat(43), platform: 'fcm', events: APPROVALS_ONLY } });
      expect(reply.status).toBe(503);
    } finally {
      await live.close();
    }
  });
});

describe('state', () => {
  it('gives grants made before push the push scope when they hold web:open', async () => {
    const device = { deviceId: 'dev_1', label: 'Pixel', platform: 'android' as const, hardwareBacked: true, publicKey: 'k', fingerprint: 'f', peerId: 'p', createdAt: 1, expiresAt: Date.now() + 1e9, lastSeenAt: null, revokedAt: null };
    const doc: HostStateDocument = { version: 2, devices: [{ ...device, scopes: ['host:read', 'web:open'] }, { ...device, deviceId: 'dev_2', scopes: ['host:read'] }], published: [] };
    const store = new MemoryStore<HostStateDocument>();
    await store.write(doc);
    const state = await HostState.open(store, systemClock);
    expect(state.device('dev_1')!.scopes).toEqual(['host:read', 'web:open', 'push:register']);
    expect(state.device('dev_2')!.scopes).toEqual(['host:read']);
    expect((await store.read())!.devices[0]!.scopes).toContain('push:register');
  });
});
