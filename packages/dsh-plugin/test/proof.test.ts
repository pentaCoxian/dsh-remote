import { HEADERS, LIMITS } from '@dsh-remote/protocol';
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

const meta = { method: 'GET', target: '/v1/meta' } as const;

describe('request proof on a paired device', () => {
  it('serves /v1/meta to a paired device', async () => {
    const reply = await host.signed(phone, meta);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ v: 1, hostId: host.state.hostId, device: { deviceId: phone.deviceId } });
  });

  it('requires Access identity even with a valid device signature', async () => {
    const headers = phone.proofHeaders('GET', '/v1/meta', Buffer.alloc(0));
    const reply = await host.call({ ...meta, assertion: null, headers });
    expect(reply.status).toBe(401);
    expect(reply.json.error.code).toBe('UNAUTHENTICATED');
  });

  it('requires a device signature even with valid Access identity', async () => {
    const reply = await host.call(meta);
    expect(reply.status).toBe(426);
    expect(reply.json.error.code).toBe('PROTOCOL_UNSUPPORTED');
    const noSignature = await host.call({ ...meta, headers: { [HEADERS.protocol]: '1', [HEADERS.deviceId]: phone.deviceId } });
    expect(noSignature.json.error.code).toBe('SIGNATURE_INVALID');
  });

  it('refuses an unsupported protocol major version', async () => {
    const reply = await host.signed(phone, { ...meta, headers: { [HEADERS.protocol]: '2' } });
    expect(reply.status).toBe(426);
  });

  it('refuses an unknown device id', async () => {
    const reply = await host.signed(phone, { ...meta, sign: { deviceId: 'dev_unknownunknownunknown' } });
    expect(reply.status).toBe(403);
    expect(reply.json.error.code).toBe('DEVICE_UNPAIRED');
  });

  it('refuses a signature from a different key', async () => {
    const other = new TestPhone();
    other.deviceId = phone.deviceId;
    const reply = await host.signed(other, meta);
    expect(reply.status).toBe(401);
    expect(reply.json.error.code).toBe('SIGNATURE_INVALID');
  });

  it('binds the grant to the Access principal that paired it', async () => {
    const reply = await host.signed(phone, { ...meta, sub: 'someone-else' });
    expect(reply.status).toBe(403);
    expect(reply.json.error.code).toBe('ACCESS_DENIED');
  });

  it('refuses a revoked device', async () => {
    await host.state.revokeDevice(phone.deviceId);
    const reply = await host.signed(phone, meta);
    expect(reply.status).toBe(403);
    expect(reply.json.error.code).toBe('DEVICE_REVOKED');
  });

  it('refuses a replayed nonce', async () => {
    const nonce = 'BBBBBBBBBBBBBBBBBBBBBB';
    expect((await host.signed(phone, { ...meta, sign: { nonce } })).status).toBe(200);
    const replay = await host.signed(phone, { ...meta, sign: { nonce } });
    expect(replay.status).toBe(401);
    expect(replay.json.error.code).toBe('NONCE_REPLAYED');
  });

  it('accepts the edge of the timestamp window and refuses past it, reporting server time', async () => {
    const longRunning = await startTestHost({ bootAgeMs: 10 * 60_000 });
    try {
      const device = new TestPhone();
      await longRunning.pair(device);
      for (const timestampMs of [Date.now() - LIMITS.timestampWindowMs + 2_000, Date.now() + LIMITS.timestampWindowMs - 2_000]) {
        expect((await longRunning.signed(device, { ...meta, sign: { timestampMs } })).status).toBe(200);
      }
      for (const timestampMs of [Date.now() - LIMITS.timestampWindowMs - 2_000, Date.now() + LIMITS.timestampWindowMs + 2_000]) {
        const outside = await longRunning.signed(device, { ...meta, sign: { timestampMs } });
        expect(outside.status).toBe(401);
        expect(outside.json.error).toMatchObject({ code: 'TIMESTAMP_SKEW', retryable: true });
        expect(typeof outside.json.error.serverTime).toBe('number');
      }
    } finally {
      await longRunning.close();
    }
  });

  it('refuses a signature made before the host process started', async () => {
    const restarted = await startTestHost();
    try {
      const fresh = new TestPhone();
      await restarted.pair(fresh);
      const beforeBoot = await restarted.signed(fresh, { ...meta, sign: { timestampMs: restarted.clock.now() - 6_000 } });
      expect(beforeBoot.json.error.code).toBe('TIMESTAMP_SKEW');
    } finally {
      await restarted.close();
    }
  });

  it('refuses non-canonical timestamps', async () => {
    const headers = phone.proofHeaders('GET', '/v1/meta', Buffer.alloc(0));
    const reply = await host.call({ ...meta, headers: { ...headers, [HEADERS.timestamp]: `0${headers[HEADERS.timestamp]}` } });
    expect(reply.json.error.code).toBe('SIGNATURE_INVALID');
  });

  it('refuses a signature over a different target', async () => {
    const headers = phone.proofHeaders('GET', '/v1/meta?x=1', Buffer.alloc(0));
    const reply = await host.call({ ...meta, headers });
    expect(reply.json.error.code).toBe('SIGNATURE_INVALID');
  });

  it('refuses a device whose grant lacks the route scope', async () => {
    const device = host.state.device(phone.deviceId)!;
    (device as unknown as { scopes: string[] }).scopes = ['session:read'];
    const reply = await host.signed(phone, meta);
    expect(reply.status).toBe(403);
    expect(reply.json.error.code).toBe('SCOPE_DENIED');
  });
});
