import { readFileSync } from 'node:fs';
import { isValid, parsePairingUrl } from '@dsh-remote/protocol';
import iroh from '@number0/iroh';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostKey } from '../src/core/host-key.ts';
import { dialTicket, type IrohDialer } from './helpers/iroh.ts';
import { startLiveHost, type LiveHost } from './helpers/live.ts';
import { TEST_PEER_HEADER, TestPhone } from './helpers/phone.ts';

const pairingVector = JSON.parse(readFileSync(new URL('../../../protocol/vectors/pairing.json', import.meta.url), 'utf8')) as { ticket: { endpointId: string } };

describe('host key', () => {
  it('derives the EndpointId and signatures iroh does from the same seed', () => {
    const seed = Buffer.alloc(32, 0x42);
    const key = HostKey.fromSeed(seed);
    expect(key.endpointId).toBe(pairingVector.ticket.endpointId);
    const secret = iroh.SecretKey.fromBytes(Array.from(seed));
    expect(secret.public().toString()).toBe(key.endpointId);
    const message = Buffer.from('DSH-REMOTE', 'utf8');
    expect(Buffer.from(secret.sign(Array.from(message)).toBytes())).toEqual(key.sign(message));
  });
});

describe('the native API over iroh', () => {
  let live: LiveHost;
  const dialers: IrohDialer[] = [];
  beforeEach(async () => {
    live = await startLiveHost({ iroh: true });
  });
  afterEach(async () => {
    for (const dialer of dialers.splice(0)) await dialer.close();
    await live.close();
  });

  const dial = async (ticket: string, secretKey?: number[]) => {
    const dialer = await dialTicket(ticket, secretKey === undefined ? {} : { secretKey });
    dialers.push(dialer);
    return dialer;
  };

  /** Pair `phone` through `dialer`, claiming another peer in the test header: QUIC's answer must win. */
  const pairOver = async (dialer: IrohDialer, phone: TestPhone) => {
    const payload = parsePairingUrl(live.host.offerPairing('session-a').url)!;
    const spoof = { [TEST_PEER_HEADER]: phone.peerId };
    const body = { challengeId: payload.challengeId, publicKey: phone.publicKey, deviceLabel: 'iroh phone', platform: 'ios', hardwareBacked: true };
    const redeem = await live.signed(phone, { method: 'POST', target: '/v1/pair/redeem', body, port: dialer.port, headers: spoof });
    expect(redeem.status).toBe(201);
    await live.host.approvePairing(redeem.json.pairingRequestId);
    const status = await live.signed(phone, { method: 'GET', target: `/v1/pair/requests/${redeem.json.pairingRequestId}`, port: dialer.port, headers: spoof });
    phone.deviceId = status.json.grant.deviceId;
    return status.json.grant;
  };

  it('pairs from the QR ticket and binds the grant to the QUIC-authenticated peer', async () => {
    const payload = parsePairingUrl(live.host.offerPairing('session-a').url)!;
    expect(payload.hostName).toBe('Home Lab');
    const dialer = await dial(payload.ticket);
    expect(dialer.connection.remoteId().toString()).toBe(live.host.hostId);

    const phone = new TestPhone();
    const grant = await pairOver(dialer, phone);
    expect(grant.hostId).toBe(live.host.hostId);
    expect(live.host.state.device(grant.deviceId)?.peerId).toBe(dialer.peerId);
    expect(live.host.pendingPairings()).toEqual([]);

    const meta = await live.signed(phone, { method: 'GET', target: '/v1/meta', port: dialer.port });
    expect(meta.status).toBe(200);
    expect(meta.json.hostId).toBe(live.host.hostId);
    const address = await live.signed(phone, { method: 'GET', target: '/v1/host/address', port: dialer.port });
    expect(isValid('HostAddress', address.json)).toBe(true);
    expect(iroh.EndpointTicket.fromString(address.json.ticket).endpointAddr().id().toString()).toBe(live.host.hostId);
  });

  it('refuses a paired device key arriving from another peer', async () => {
    const ticket = live.host.endpoint!.ticket();
    const phone = new TestPhone();
    await pairOver(await dial(ticket), phone);
    const stranger = await dial(ticket);
    const reply = await live.signed(phone, { method: 'GET', target: '/v1/meta', port: stranger.port });
    expect(reply.status).toBe(403);
    expect(reply.json.error.code).toBe('ACCESS_DENIED');
  });

  it('streams events over a WebSocket inside the same connection', async () => {
    const dialer = await dial(live.host.endpoint!.ticket());
    const phone = new TestPhone();
    await pairOver(dialer, phone);
    const snapshot = await live.signed(phone, { method: 'GET', target: '/v1/sessions/session-a', port: dialer.port });
    const socket = await live.socket(phone, dialer.port);
    socket.send({ op: 'subscribe', sessionId: 'session-a', after: snapshot.json.cursor });
    await socket.next((f) => f.kind === 'subscribed');
    const prompt = await live.signed(phone, { method: 'POST', target: '/v1/sessions/session-a/prompts', body: { clientRequestId: 'req_iroh_01', text: 'over QUIC' }, port: dialer.port });
    expect(prompt.status).toBe(202);
    await socket.next((f) => f.kind === 'turn.finished');
    expect(socket.frames.filter((f) => f.type === 'session.event' && !f.ephemeral).map((f) => f.kind)).toEqual(['turn.started', 'user.message', 'assistant.message', 'turn.finished']);
    socket.ws.close();
  });

  it('hangs up on the peer when its device is revoked', async () => {
    const dialer = await dial(live.host.endpoint!.ticket());
    const phone = new TestPhone();
    await pairOver(dialer, phone);
    await live.host.revokeDevice(phone.deviceId);
    expect(await dialer.connection.closed()).toContain('revoked');
  });

  it('reports its relay-less status', () => {
    const status = live.host.status();
    expect(status.transport).toMatchObject({ relays: [], homeRelay: null });
    expect(status.transport!.directAddresses.some((a) => a.startsWith('127.0.0.1:'))).toBe(true);
  });
});
