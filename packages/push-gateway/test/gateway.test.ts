import { IrohHttpClient } from '@dsh-remote/iroh-http';
import { isValid, openPush, PUSH_ALPN, sealPush } from '@dsh-remote/protocol';
import iroh from '@number0/iroh';
import type { Endpoint } from '@number0/iroh';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Gateway } from '../src/gateway.ts';
import type { OutboundPush, Sender, SendOutcome } from '../src/senders/types.ts';
import { HandleStore } from '../src/store.ts';
import { GatewayTransport } from '../src/transport.ts';

const { Endpoint: EndpointClass, EndpointTicket, RelayMode, SecretKey } = iroh;

class RecordingSender implements Sender {
  readonly sent: OutboundPush[] = [];
  next: SendOutcome = { ok: true };
  async send(push: OutboundPush): Promise<SendOutcome> {
    this.sent.push(push);
    return this.next;
  }
  close(): void {}
}

async function peer(): Promise<Endpoint> {
  const builder = EndpointClass.builder();
  builder.applyMinimal();
  builder.relayMode(RelayMode.disabled());
  return builder.bind();
}

describe('push gateway over iroh', () => {
  let transport: GatewayTransport;
  let store: HandleStore;
  let fcm: RecordingSender;
  const endpoints: Endpoint[] = [];
  const clients: IrohHttpClient[] = [];

  const client = async () => {
    const endpoint = await peer();
    endpoints.push(endpoint);
    const http = new IrohHttpClient(endpoint, () => EndpointTicket.fromString(transport.ticket()).endpointAddr(), PUSH_ALPN);
    clients.push(http);
    return { id: endpoint.id().toString(), http };
  };

  beforeEach(async () => {
    store = HandleStore.open(':memory:');
    fcm = new RecordingSender();
    const gateway = new Gateway({ store, senders: { fcm }, limits: { pushesPerHandlePerMinute: 3 } });
    transport = await GatewayTransport.start({ secretKey: SecretKey.generate().toBytes(), relays: [], onStream: (stream, peerId) => gateway.accept(stream, peerId) });
  });

  afterEach(async () => {
    for (const http of clients.splice(0)) http.close();
    for (const endpoint of endpoints.splice(0)) await endpoint.close();
    await transport.close();
    store.close();
  });

  it('routes a sealed envelope from the bound host to the phone token, unread', async () => {
    const phone = await client();
    const host = await client();
    const registered = await phone.http.request('POST', '/v1/handles', { platform: 'fcm', token: 'fcm-token-123', host: host.id });
    expect(registered.status).toBe(201);
    expect(isValid('GatewayHandleResponse', registered.body)).toBe(true);
    const { handle } = registered.body as { handle: string };
    expect(store.get(handle)).toMatchObject({ phone: phone.id, host: host.id });

    const key = Buffer.alloc(32, 9);
    const envelope = sealPush(key, handle, { v: 1, id: 'n1', kind: 'approval', hostId: host.id, hostName: 'Lab', title: 'Session', body: 'Approval needed: shell', ts: 1 });
    const pushed = await host.http.request('POST', '/v1/push', { handle, envelope, urgency: 'high', collapseId: 'apr_1' });
    expect(pushed).toEqual({ status: 202, body: { v: 1 } });
    expect(fcm.sent).toEqual([{ token: 'fcm-token-123', env: null, handle, host: host.id, envelope, urgency: 'high', collapseId: 'apr_1' }]);
    expect(openPush(key, host.id, handle, fcm.sent[0]!.envelope)?.body).toBe('Approval needed: shell');
  });

  it('lets only the bound host push, and only the registering phone delete', async () => {
    const phone = await client();
    const host = await client();
    const stranger = await client();
    const { handle } = (await phone.http.request('POST', '/v1/handles', { platform: 'fcm', token: 'fcm-token-123', host: host.id })).body as { handle: string };
    const envelope = 'E'.repeat(60);

    const foreign = await stranger.http.request('POST', '/v1/push', { handle, envelope, urgency: 'high' });
    expect(foreign.status).toBe(410);
    expect((foreign.body as { error: { code: string } }).error.code).toBe('HANDLE_GONE');
    expect(fcm.sent).toHaveLength(0);

    expect((await stranger.http.request('DELETE', `/v1/handles/${handle}`)).status).toBe(204);
    expect(store.get(handle)).toBeDefined();
    expect((await phone.http.request('DELETE', `/v1/handles/${handle}`)).status).toBe(204);
    expect(store.get(handle)).toBeUndefined();
    expect((await host.http.request('POST', '/v1/push', { handle, envelope, urgency: 'high' })).status).toBe(410);
  });

  it('forgets a handle whose token the platform dropped, and tells the host', async () => {
    const phone = await client();
    const host = await client();
    const { handle } = (await phone.http.request('POST', '/v1/handles', { platform: 'fcm', token: 'fcm-token-123', host: host.id })).body as { handle: string };
    fcm.next = { ok: false, gone: true, reason: '404 UNREGISTERED' };
    expect((await host.http.request('POST', '/v1/push', { handle, envelope: 'E'.repeat(60), urgency: 'normal' })).status).toBe(410);
    expect(store.get(handle)).toBeUndefined();
  });

  it('reports a temporary platform failure as retryable and keeps the handle', async () => {
    const phone = await client();
    const host = await client();
    const { handle } = (await phone.http.request('POST', '/v1/handles', { platform: 'fcm', token: 'fcm-token-123', host: host.id })).body as { handle: string };
    fcm.next = { ok: false, gone: false, reason: '503 UNAVAILABLE' };
    const reply = await host.http.request('POST', '/v1/push', { handle, envelope: 'E'.repeat(60), urgency: 'normal' });
    expect(reply.status).toBe(503);
    expect((reply.body as { error: { retryable: boolean } }).error.retryable).toBe(true);
    expect(store.get(handle)).toBeDefined();
  });

  it('refuses platforms it has no credentials for, bad bodies, and floods', async () => {
    const phone = await client();
    const host = await client();
    expect((await phone.http.request('POST', '/v1/handles', { platform: 'apns', token: 'a1b2c3d4e5f6', apnsEnvironment: 'sandbox', host: host.id })).status).toBe(503);
    expect((await phone.http.request('POST', '/v1/handles', { platform: 'fcm', token: 'bad token', host: host.id })).status).toBe(400);
    const { handle } = (await phone.http.request('POST', '/v1/handles', { platform: 'fcm', token: 'fcm-token-123', host: host.id })).body as { handle: string };
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await host.http.request('POST', '/v1/push', { handle, envelope: 'E'.repeat(60), urgency: 'normal' })).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
    expect((await host.http.request('GET', '/v1/push')).status).toBe(405);
    expect((await host.http.request('GET', '/nope')).status).toBe(404);
  });
});
