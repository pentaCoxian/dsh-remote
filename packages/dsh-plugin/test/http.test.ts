import { connect } from 'node:net';
import { HEADERS, isValid } from '@dsh-remote/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestHost, type TestHost } from './helpers/host.ts';
import { TestPhone } from './helpers/phone.ts';

let host: TestHost;
let phone: TestPhone;
beforeEach(async () => {
  host = await startTestHost();
  phone = new TestPhone();
  await host.pair(phone);
});
afterEach(() => host.close());

/** Raw bytes on the wire, for requests no HTTP client would build; keeps the socket open until the host answers. */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(text));
    let out = '';
    socket.on('data', (chunk) => (out += chunk.toString('utf8')));
    socket.on('close', () => resolve(out));
    socket.on('error', reject);
    setTimeout(() => socket.destroy(), 2_000);
  });
}

describe('listener', () => {
  it('binds loopback only', () => {
    const address = (host.api as unknown as { server: { address(): { address: string } } }).server.address();
    expect(address.address).toBe('127.0.0.1');
  });

  it('answers only the configured public hostname', async () => {
    for (const hostname of ['127.0.0.1:4318', 'localhost', 'evil.example', 'dsh.example.com.evil.example', 'DSH.EXAMPLE.COM']) {
      const reply = await host.signed(phone, { method: 'GET', target: '/v1/meta', host: hostname });
      expect(reply.status, hostname).toBe(404);
    }
  });

  it('refuses duplicated security headers', async () => {
    const headers = phone.proofHeaders('GET', '/v1/meta', Buffer.alloc(0));
    for (const name of [HEADERS.signature, HEADERS.deviceId, HEADERS.accessAssertion]) {
      const value = name === HEADERS.accessAssertion ? await host.issuer.assertion() : headers[name]!;
      const reply = await host.signed(phone, { method: 'GET', target: '/v1/meta', headers: { [name]: [value, value] } });
      expect(reply.status, name).toBe(400);
    }
  });
});

describe('target grammar', () => {
  it.each([
    '/v1/me%74a',
    '/v1/./meta',
    '/v1/../v1/meta',
    '/v1//meta',
    '/v1/meta/',
    '/v1/sessions/a%2Fb',
    '/v1/meta;x=1',
    '/',
    '/api',
    '/api/remote.mux',
    '/index.html',
  ])('does not route %s', async (target) => {
    const reply = await host.signed(phone, { method: 'GET', target });
    expect(reply.status).toBe(404);
    expect(isValid('ErrorEnvelope', reply.json)).toBe(true);
  });

  it.each(['/v1/meta?a=1&a=2', '/v1/meta?', '/v1/meta?a', '/v1/meta?a=%41', '/v1/meta?a=b=c'])('refuses query %s', async (target) => {
    expect((await host.signed(phone, { method: 'GET', target })).status).toBe(400);
  });

  it('answers 405 for a known path with another method', async () => {
    const reply = await host.signed(phone, { method: 'DELETE', target: '/v1/meta' });
    expect(reply.status).toBe(405);
  });
});

describe('bodies', () => {
  const redeem = (body: object | string) => ({ method: 'POST', target: '/v1/pair/redeem', body });
  const valid = () => ({ challengeId: `chl_${'a'.repeat(24)}`, publicKey: phone.publicKey, deviceLabel: 'P', platform: 'ios', hardwareBacked: false });

  it('refuses a body on a route that takes none', async () => {
    const reply = await host.signed(phone, { method: 'GET', target: '/v1/meta', body: '{}' });
    expect(reply.status).toBe(400);
  });

  it('refuses an oversized declared body without reading it', async () => {
    const assertion = await host.issuer.assertion();
    const response = await raw(
      host.port,
      `POST /v1/pair/redeem HTTP/1.1\r\nhost: dsh.example.com\r\n${HEADERS.accessAssertion}: ${assertion}\r\ncontent-type: application/json\r\ncontent-length: 70000\r\n\r\n{`,
    );
    expect(response.startsWith('HTTP/1.1 413')).toBe(true);
  });

  it('refuses an oversized streamed body', async () => {
    const reply = await host.signed(phone, { ...redeem({ ...valid(), deviceLabel: 'x'.repeat(70_000) }) });
    expect(reply.status).toBe(413);
  });

  it('requires JSON content', async () => {
    const reply = await host.signed(phone, { ...redeem(valid()), headers: { 'content-type': 'text/plain' } });
    expect(reply.status).toBe(415);
  });

  it('refuses malformed JSON and schema violations without echoing input', async () => {
    const marker = 'SECRET-PROMPT-TEXT';
    for (const body of [`{"challengeId":"${marker}"`, { ...valid(), extra: marker }, { ...valid(), deviceLabel: `a\n${marker}` }]) {
      const reply = await host.signed(phone, redeem(body));
      expect(reply.status).toBe(400);
      expect(reply.text).not.toContain(marker);
    }
  });

  it('signs the exact body: a different body digest fails', async () => {
    const body = { ...valid(), challengeId: host.pairing.createChallenge().challengeId };
    const reply = await host.signed(phone, { ...redeem(body), sign: { bodySha256Hex: '0'.repeat(64), deviceId: 'pending' } });
    expect(reply.status).toBe(401);
    expect(reply.json.error.code).toBe('SIGNATURE_INVALID');
  });
});

describe('responses', () => {
  it('are no-store, nosniff, carry a request id and never include the assertion', async () => {
    const assertion = await host.issuer.assertion();
    const reply = await host.signed(phone, { method: 'GET', target: '/v1/meta', headers: { [HEADERS.accessAssertion]: assertion } });
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(reply.headers['x-dsh-request-id']).toMatch(/^trace_/);
    expect(reply.text).not.toContain(assertion);
    expect(isValid('Meta', reply.json)).toBe(true);
  });

  it('audit entries carry ids and codes, never tokens', async () => {
    const assertion = await host.issuer.assertion();
    await host.signed(phone, { method: 'GET', target: '/v1/meta', headers: { [HEADERS.accessAssertion]: assertion } });
    await host.call({ method: 'GET', target: '/v1/meta', assertion: 'garbage' });
    const text = JSON.stringify(host.audit.entries);
    expect(text).not.toContain(assertion);
    expect(text).not.toContain(phone.publicKey);
    expect(host.audit.entries.some((e) => e.code === 'UNAUTHENTICATED')).toBe(true);
  });
});
