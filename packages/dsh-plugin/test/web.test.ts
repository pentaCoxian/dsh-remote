import { PeerStream } from '@dsh-remote/iroh-http';
import { isValid, WEB_ALPN } from '@dsh-remote/protocol';
import type { BiStream } from '@number0/iroh';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemClock } from '../src/core/clock.ts';
import { HostKey } from '../src/core/host-key.ts';
import type { HostState, HostStateDocument } from '../src/core/state.ts';
import { MemoryStore } from '../src/core/store.ts';
import { WebGateway } from '../src/web/gateway.ts';
import { startFakeDshWeb, type FakeDshWeb } from './helpers/fake-dsh-web.ts';
import { dialTicket, type IrohDialer } from './helpers/iroh.ts';
import { startLiveHost, type LiveHost } from './helpers/live.ts';
import { send, TestPhone } from './helpers/phone.ts';

const TOKEN = 'launch-token-0123456789abcdef';

describe('the DSH Web tunnel', () => {
  let live: LiveHost;
  let web: FakeDshWeb;
  const dialers: IrohDialer[] = [];

  beforeEach(async () => {
    web = await startFakeDshWeb(TOKEN);
    live = await startLiveHost({ iroh: true, web: { target: () => ({ host: '127.0.0.1', port: web.port }), launchTokenQuery: () => `token=${TOKEN}` } });
  });
  afterEach(async () => {
    for (const dialer of dialers.splice(0)) await dialer.close();
    await live.close();
    await web.close();
  });

  const dial = async (alpn?: string, secretKey?: number[]) => {
    const dialer = await dialTicket(live.host.endpoint!.ticket(), { ...(alpn === undefined ? {} : { alpn }), ...(secretKey === undefined ? {} : { secretKey }) });
    dialers.push(dialer);
    return dialer;
  };

  /** Pair over the API ALPN; returns the phone and its dialer's iroh key. */
  const pairPhone = async () => {
    const secretKey = Array.from(crypto.getRandomValues(new Uint8Array(32)));
    const api = await dial(undefined, secretKey);
    const phone = new TestPhone();
    const challenge = live.host.pairing.createChallenge();
    const body = { challengeId: challenge.challengeId, publicKey: phone.publicKey, deviceLabel: 'web phone', platform: 'android', hardwareBacked: true };
    const redeem = await live.signed(phone, { method: 'POST', target: '/v1/pair/redeem', body, port: api.port });
    await live.host.approvePairing(redeem.json.pairingRequestId);
    const status = await live.signed(phone, { method: 'GET', target: `/v1/pair/requests/${redeem.json.pairingRequestId}`, port: api.port });
    phone.deviceId = status.json.grant.deviceId;
    return { phone, api, secretKey };
  };

  /** A browser request through the phone-side port: Host and Origin name the phone's own loopback authority. */
  const browse = (port: number, target: string, cookie?: string) =>
    send(port, { method: 'GET', target, host: `127.0.0.1:${port}`, headers: { origin: `http://127.0.0.1:${port}`, ...(cookie === undefined ? {} : { cookie }) } });

  it('opens a window with a signed request, then serves DSH Web with DSH’s own login', async () => {
    const { phone, api, secretKey } = await pairPhone();
    const session = await live.signed(phone, { method: 'POST', target: '/v1/web/session', port: api.port });
    expect(session.status).toBe(200);
    expect(isValid('WebSession', session.json)).toBe(true);
    expect(session.json.tokenQuery).toBe(`token=${TOKEN}`);

    const tunnel = await dial(WEB_ALPN, secretKey);
    const login = await browse(tunnel.port, `/?${session.json.tokenQuery}`);
    expect(login.status).toBe(303);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const index = await browse(tunnel.port, '/', cookie);
    expect(index.status).toBe(200);
    expect(index.text).toContain('DeepSeek Harness');
    // No rewriting: DSH Web saw the phone's own loopback authority and let it through its fence.
    expect(web.hosts.at(-1)).toBe(`127.0.0.1:${tunnel.port}`);
    expect(live.host.status().web).toBe('ready');
  });

  it('refuses the tunnel before a window is opened', async () => {
    const { secretKey } = await pairPhone();
    await expect(dial(WEB_ALPN, secretKey).then((d) => d.connection.closed())).resolves.toContain('web window closed');
  });

  it('refuses a stranger and a phone whose window belongs to another key', async () => {
    const { phone, api } = await pairPhone();
    await live.signed(phone, { method: 'POST', target: '/v1/web/session', port: api.port });
    const stranger = await dial(WEB_ALPN);
    expect(await stranger.connection.closed()).toContain('web window closed');
  });

  it('cuts the tunnel when the phone is revoked', async () => {
    const { phone, api, secretKey } = await pairPhone();
    await live.signed(phone, { method: 'POST', target: '/v1/web/session', port: api.port });
    const tunnel = await dial(WEB_ALPN, secretKey);
    expect((await browse(tunnel.port, `/?token=${TOKEN}`)).status).toBe(303);
    await live.host.revokeDevice(phone.deviceId);
    expect(await tunnel.connection.closed()).toContain('revoked');
    await expect(dial(WEB_ALPN, secretKey).then((d) => d.connection.closed())).resolves.toContain('web window closed');
  });

  it('keeps the window across a host restart, so the phone’s open DSH Web reconnects on its own', async () => {
    await live.close();
    const options = {
      iroh: true,
      identity: { hostKey: HostKey.generate(), stateStore: new MemoryStore<HostStateDocument>() },
      web: { target: () => ({ host: '127.0.0.1', port: web.port }), launchTokenQuery: () => `token=${TOKEN}` },
    };
    live = await startLiveHost(options);
    const { phone, api, secretKey } = await pairPhone();
    await live.signed(phone, { method: 'POST', target: '/v1/web/session', port: api.port });
    const before = await dial(WEB_ALPN, secretKey);
    const cookie = String((await browse(before.port, `/?token=${TOKEN}`)).headers['set-cookie']).split(';')[0]!;

    await live.close();
    live = await startLiveHost(options);
    // No new POST /v1/web/session: the WebView just reconnects with the cookie it has.
    const after = await dial(WEB_ALPN, secretKey);
    expect((await browse(after.port, '/', cookie)).status).toBe(200);
  });

  it('reports DSH Web as unavailable when it is not serving plain HTTP', async () => {
    await live.close();
    live = await startLiveHost({ iroh: true, web: { target: () => undefined, launchTokenQuery: () => `token=${TOKEN}` } });
    expect(live.host.status().web).toBe('DSH Web is not listening on plain HTTP');
    const { phone, api } = await pairPhone();
    const session = await live.signed(phone, { method: 'POST', target: '/v1/web/session', port: api.port });
    expect(session.json.error.code).toBe('UNAVAILABLE');
  });
});

describe('a tunnel stream', () => {
  /**
   * A bi-stream whose writes take a while to land, as native ones do while QUIC
   * flow control waits on a slow phone. A reset discards whatever the phone has
   * not read yet, so a reply must end with finish, never reset.
   */
  const fakeBi = (request: string) => {
    const sent: Buffer[] = [];
    const log: string[] = [];
    let served = false;
    const bi = {
      send: {
        writeAll: (bytes: number[]) => new Promise<void>((resolve) => setTimeout(() => (sent.push(Buffer.from(bytes)), resolve()), 30)),
        finish: async () => void log.push('finish'),
        reset: async () => void log.push('reset'),
      },
      recv: {
        // The request, then the phone keeps its side open, as a browser does.
        read: () => (served ? new Promise<number[]>(() => {}) : ((served = true), Promise.resolve(Array.from(Buffer.from(request))))),
        stop: async () => {},
      },
    };
    return { stream: new PeerStream(bi as unknown as BiStream), sent, log };
  };

  it('delivers a reply in full when DSH Web closes the connection right after it', async () => {
    const web = await startFakeDshWeb(TOKEN);
    const device = { peerId: 'phone', webUntil: Infinity, revokedAt: null, expiresAt: Infinity, scopes: ['web:open'] };
    const gateway = new WebGateway({ devices: () => [device] } as unknown as HostState, systemClock, {
      target: () => ({ host: '127.0.0.1', port: web.port }),
      launchTokenQuery: () => `token=${TOKEN}`,
    });
    try {
      const { stream, sent, log } = fakeBi(`GET /?token=${TOKEN} HTTP/1.1\r\nhost: 127.0.0.1:20000\r\nconnection: close\r\n\r\n`);
      gateway.pipe(stream, { peerId: 'phone' });
      await new Promise((resolve) => stream.once('close', resolve));
      expect(log).toEqual(['finish']);
      expect(Buffer.concat(sent).toString()).toMatch(/^HTTP\/1\.1 303 /);
    } finally {
      await web.close();
    }
  });
});
