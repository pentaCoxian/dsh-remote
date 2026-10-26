import { createPublicKey, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createH2Server, type Http2Server, type IncomingHttpHeaders } from 'node:http2';
import { afterEach, describe, expect, it } from 'vitest';
import { ApnsSender } from '../src/senders/apns.ts';
import { FcmSender } from '../src/senders/fcm.ts';
import type { OutboundPush } from '../src/senders/types.ts';

const push: OutboundPush = { token: 'device-token-abc', env: 'sandbox', handle: 'H'.repeat(22), host: 'h'.repeat(64), envelope: 'E'.repeat(60), urgency: 'high', collapseId: 'apr_1' };

function jwtParts(token: string) {
  const [header, claims, signature] = token.split('.') as [string, string, string];
  return { header: JSON.parse(Buffer.from(header, 'base64url').toString()), claims: JSON.parse(Buffer.from(claims, 'base64url').toString()), input: `${header}.${claims}`, signature: Buffer.from(signature, 'base64url') };
}

const listen = (server: Server | Http2Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));

describe('APNs sender', () => {
  let server: Http2Server | undefined;
  afterEach(() => server?.close());

  async function apns(respond: (headers: IncomingHttpHeaders, body: string, index: number) => { status: number; reason?: string }) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const seen: { headers: IncomingHttpHeaders; body: string }[] = [];
    server = createH2Server((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        seen.push({ headers: req.headers, body });
        const { status, reason } = respond(req.headers, body, seen.length - 1);
        res.writeHead(status, { 'content-type': 'application/json' });
        if (reason === undefined) res.end();
        else res.end(JSON.stringify({ reason }));
      });
    });
    const origin = `http://127.0.0.1:${await listen(server)}`;
    let now = 1_792_900_000_000;
    const sender = new ApnsSender({ key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), keyId: 'KEY123', teamId: 'TEAM45', topic: 'dev.dshremote.dshRemote', origins: { production: 'http://unused.invalid', sandbox: origin }, now: () => now });
    return { sender, seen, publicKey, advance: (ms: number) => (now += ms) };
  }

  const verifyEs256 = (token: string, key: KeyObject) => {
    const { input, signature } = jwtParts(token);
    return verify('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }, signature);
  };

  it('posts an alert with mutable-content and the envelope, signed with the provider token', async () => {
    const { sender, seen, publicKey } = await apns(() => ({ status: 200 }));
    expect(await sender.send(push)).toEqual({ ok: true });
    const [{ headers, body }] = seen as [{ headers: IncomingHttpHeaders; body: string }];
    expect(headers[':path']).toBe('/3/device/device-token-abc');
    expect(headers['apns-topic']).toBe('dev.dshremote.dshRemote');
    expect(headers['apns-push-type']).toBe('alert');
    expect(headers['apns-priority']).toBe('10');
    expect(headers['apns-collapse-id']).toBe('apr_1');
    const token = String(headers.authorization).replace(/^bearer /, '');
    expect(jwtParts(token).header).toEqual({ alg: 'ES256', kid: 'KEY123' });
    expect(jwtParts(token).claims).toEqual({ iss: 'TEAM45', iat: 1_792_900_000 });
    expect(verifyEs256(token, publicKey)).toBe(true);
    const payload = JSON.parse(body);
    expect(payload).toMatchObject({ aps: { alert: { title: 'DSH Remote', body: 'New activity' }, 'mutable-content': 1, sound: 'default' }, h: push.handle, e: push.envelope });
    sender.close();
  });

  it('reuses the provider token, and makes a new one after an ExpiredProviderToken', async () => {
    const { sender, seen } = await apns((_headers, _body, index) => (index === 1 ? { status: 403, reason: 'ExpiredProviderToken' } : { status: 200 }));
    expect(await sender.send(push)).toEqual({ ok: true });
    const { collapseId: _unused, ...normal } = push;
    expect(await sender.send({ ...normal, urgency: 'normal' })).toEqual({ ok: true });
    expect(seen).toHaveLength(3);
    expect(seen[1]!.headers.authorization).toBe(seen[0]!.headers.authorization);
    expect(seen[2]!.headers['apns-priority']).toBe('5');
    sender.close();
  });

  it('marks dead tokens gone and other failures retryable', async () => {
    const replies = [{ status: 410, reason: 'Unregistered' }, { status: 400, reason: 'BadDeviceToken' }, { status: 429, reason: 'TooManyRequests' }];
    const { sender } = await apns((_h, _b, index) => replies[index]!);
    expect(await sender.send(push)).toEqual({ ok: false, gone: true, reason: '410 Unregistered' });
    expect(await sender.send(push)).toEqual({ ok: false, gone: true, reason: '400 BadDeviceToken' });
    expect(await sender.send(push)).toEqual({ ok: false, gone: false, reason: '429 TooManyRequests' });
    sender.close();
  });
});

describe('FCM sender', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function fcm(respond: (path: string, body: string, index: number) => { status: number; body: unknown }) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const seen: { path: string; auth: string | undefined; body: string }[] = [];
    server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        seen.push({ path: req.url ?? '', auth: req.headers.authorization, body });
        const reply = respond(req.url ?? '', body, seen.length - 1);
        res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
      });
    });
    const origin = `http://127.0.0.1:${await listen(server)}`;
    const sender = new FcmSender({
      serviceAccount: { project_id: 'dsh-remote-test', client_email: 'push@dsh-remote-test.iam.gserviceaccount.com', private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), token_uri: `${origin}/token` },
      endpoint: origin,
      now: () => 1_792_900_000_000,
    });
    return { sender, seen, publicKey: createPublicKey(publicKey.export({ format: 'pem', type: 'spki' })) };
  }

  let tokens = 0;
  const tokenReply = () => ({ status: 200, body: { access_token: `access-${++tokens}`, expires_in: 3600 } });

  it('mints an access token from the service account and sends a data-only message', async () => {
    const { sender, seen, publicKey } = await fcm((path) => (path === '/token' ? tokenReply() : { status: 200, body: { name: 'projects/x/messages/1' } }));
    expect(await sender.send(push)).toEqual({ ok: true });
    expect(await sender.send(push)).toEqual({ ok: true });
    expect(seen.map((request) => request.path)).toEqual(['/token', '/v1/projects/dsh-remote-test/messages:send', '/v1/projects/dsh-remote-test/messages:send']);
    const assertion = new URLSearchParams(seen[0]!.body).get('assertion')!;
    const { header, claims, input, signature } = jwtParts(assertion);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(claims).toMatchObject({ iss: 'push@dsh-remote-test.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/firebase.messaging', iat: 1_792_900_000, exp: 1_792_903_600 });
    expect(verify('sha256', Buffer.from(input), publicKey, signature)).toBe(true);
    expect(seen[1]!.auth).toBe(seen[2]!.auth);
    expect(JSON.parse(seen[1]!.body)).toEqual({ message: { token: 'device-token-abc', data: { h: push.handle, e: push.envelope }, android: { priority: 'HIGH', ttl: '3600s', collapse_key: 'apr_1' } } });
  });

  it('refreshes the access token once on 401, and marks UNREGISTERED gone', async () => {
    const unregistered = { status: 404, body: { error: { status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } } };
    const { sender, seen } = await fcm((path, _body, index) => (path === '/token' ? tokenReply() : index === 1 ? { status: 401, body: {} } : unregistered));
    expect(await sender.send(push)).toEqual({ ok: false, gone: true, reason: '404 UNREGISTERED' });
    expect(seen.map((request) => request.path.split('/').pop())).toEqual(['token', 'messages:send', 'token', 'messages:send']);
  });

  it('keeps the token on a quota error', async () => {
    const { sender } = await fcm((path) => (path === '/token' ? tokenReply() : { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'QUOTA_EXCEEDED' }] } } }));
    expect(await sender.send(push)).toEqual({ ok: false, gone: false, reason: '429 QUOTA_EXCEEDED' });
  });
});
