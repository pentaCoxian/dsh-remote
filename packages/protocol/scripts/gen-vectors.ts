// Regenerate protocol/vectors/*.json (shared by Node and Dart tests).
// Keys are generated per run and stored in the vectors: they are test-only.
//   pnpm --filter @dsh-remote/protocol vectors
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { canonicalRequestString, sha256Hex } from '../src/signing.ts';
import { encodeCursor } from '../src/cursor.ts';
import { buildPairingUrl } from '../src/pairing.ts';
import { spkiFingerprint } from '../src/keys.ts';
import { openPush, sealPush, type PushMessage } from '../src/push.ts';

const out = new URL('../../../protocol/vectors/', import.meta.url);

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKey,
    json: {
      spki: spki.toString('base64url'),
      pkcs8TestOnly: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      fingerprint: spkiFingerprint(spki),
    },
  };
}

const signText = (privateKey: Parameters<typeof sign>[2], text: string) =>
  sign('sha256', Buffer.from(text, 'utf8'), { key: privateKey as never, dsaEncoding: 'der' }).toString('base64url');

const device = keyPair();
const requests = [
  { method: 'GET', target: '/v1/meta', body: '' },
  { method: 'GET', target: '/v1/sessions?workspaceId=ws_1', body: '' },
  { method: 'POST', target: '/v1/sessions/session-8f21/prompts', body: '{"clientRequestId":"req_d0af36","text":"Check the latest test failures."}' },
  { method: 'POST', target: '/v1/sessions/session-8f21/prompts', body: '{"clientRequestId":"req_unicode1","text":"テストの失敗を確認して 🚀"}' },
  { method: 'GET', target: '/v1/events', body: '' },
].map((request, index) => {
  const bodySha256Hex = sha256Hex(Buffer.from(request.body, 'utf8'));
  const timestampMs = 1_792_900_000_000 + index;
  const nonce = randomBytes(16).toString('base64url');
  const canonical = canonicalRequestString({ method: request.method, target: request.target, bodySha256Hex, timestampMs, nonce });
  return { ...request, bodySha256Hex, timestampMs, nonce, canonical, signature: signText(device.privateKey, canonical) };
});
writeFileSync(new URL('signing.json', out), `${JSON.stringify({
  description: 'Canonical request strings (spec §5). Verify each signature with key.spki over canonical; body is UTF-8.',
  key: device.json,
  requests,
}, null, 2)}\n`);

writeFileSync(new URL('cursor.json', out), `${JSON.stringify({
  description: 'Opaque cursor encoding: c1. + base64url(JSON {s, q}).',
  valid: [
    { sessionId: 'session-f438ec89-39f9-42dd-9ccb-8383a74ccce3', seq: 25 },
    { sessionId: 'ses_8f21', seq: -1 },
  ].map((value) => ({ ...value, cursor: encodeCursor(value) })),
  invalid: ['', 'c1.', 'c2.eyJzIjoieCIsInEiOjF9', 'c1.eyJzIjoieCIsInEiOi0yfQ', 'c1.eyJzIjoieCIsInEiOjEuNX0', 'c1.eyJzIjoieCIsInEiOjEsIngiOjF9', 'c1.!!'],
}, null, 2)}\n`);

// Real iroh tickets for the test-only seed 0x42 * 32 (EndpointId below), made with
// @number0/iroh 1.2.0: EndpointTicket.fromAddr(new EndpointAddr(id, relayUrl, addrs)).
const ticket = {
  endpointId: '2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12',
  relayUrl: 'https://nrt1.relay.dshremote.pentacoxian.dev/',
  directAddresses: ['192.168.1.20:51820'],
  full: 'endpointaaqvf6grtn4r2jcfgjbocxzovnwlpt72pnvf5uyas6la4buyqhnreaqafvuhi5dqom5c6l3ooj2dcltsmvwgc6jomrzwq4tfnvxxizjoobsw45dbmnxxq2lbnyxgizlwf4aqbqfiaekozfad',
  bare: 'endpointaaqvf6grtn4r2jcfgjbocxzovnwlpt72pnvf5uyas6la4buyqhnreaa',
};
const challengeId = `chl_${randomBytes(18).toString('base64url')}`;
const payloads = [
  { ticket: ticket.full, challengeId, sessionId: 'session-8f21', hostName: 'Home Lab 研究室' },
  { ticket: ticket.bare, challengeId },
];
const query = (entries: Record<string, string>) => new URLSearchParams(entries).toString();
writeFileSync(new URL('pairing.json', out), `${JSON.stringify({
  description: 'Pairing QR text v2. The ticket decodes to ticket.endpointId (+ relayUrl, directAddresses for the full one).',
  ticket,
  valid: payloads.map((payload) => ({ url: buildPairingUrl(payload), payload })),
  invalid: [
    `dshremote://pair?${query({ v: '1', t: ticket.full, c: challengeId })}`,
    `dshremote://pair?${query({ t: ticket.full, c: challengeId })}`,
    `dshremote://other?${query({ v: '2', t: ticket.full, c: challengeId })}`,
    `dshremote://pair/x?${query({ v: '2', t: ticket.full, c: challengeId })}`,
    `dshremote://pair?${query({ v: '2', t: ticket.full, c: challengeId })}#frag`,
    `https://pair?${query({ v: '2', t: ticket.full, c: challengeId })}`,
    `dshremote://pair?${query({ v: '2', t: ticket.full.toUpperCase(), c: challengeId })}`,
    `dshremote://pair?${query({ v: '2', t: 'node' + ticket.full.slice(8), c: challengeId })}`,
    `dshremote://pair?${query({ v: '2', t: ticket.full, c: 'chl_short' })}`,
    `dshremote://pair?${query({ v: '2', t: ticket.full, c: challengeId, x: '1' })}`,
    `dshremote://pair?${query({ v: '2', t: ticket.full, c: challengeId })}&c=${challengeId}`,
    `dshremote://pair?${query({ v: '2', t: ticket.full, c: challengeId, n: 'tab\there' })}`,
    `dshremote://pair?${query({ v: '2', t: ticket.full, c: challengeId, n: 'x'.repeat(65) })}`,
  ],
}, null, 2)}\n`);

const pushKey = randomBytes(32);
const pushHostId = ticket.endpointId;
const handle = randomBytes(16).toString('base64url');
const pushMessages: PushMessage[] = [
  { v: 1, id: 'n_approval1', kind: 'approval', hostId: pushHostId, hostName: 'Home Lab 研究室', sessionId: 'session-8f21', title: 'Fix the flaky upload test', body: 'Approval needed: shell', ts: 1_792_900_000_000 },
  { v: 1, id: 'n_finished1', kind: 'turn.finished', hostId: pushHostId, hostName: 'Home Lab 研究室', sessionId: 'session-8f21', title: 'テストの失敗を確認', body: `Done 🚀 ${'all green, '.repeat(120)}`, ts: 1_792_900_000_001 },
  { v: 1, id: 'n_test1', kind: 'test', hostId: pushHostId, hostName: 'Home Lab 研究室', title: 'DSH Remote', body: 'Notifications from this host work.', ts: 1_792_900_000_002 },
];
const pushCases = pushMessages.map((message) => {
  const nonce = randomBytes(12);
  const envelope = sealPush(pushKey, handle, message, nonce);
  return { envelope, opened: openPush(pushKey, pushHostId, handle, envelope) };
});
const flip = (envelope: string, index: number) => {
  const bytes = Buffer.from(envelope, 'base64url');
  bytes[index] = bytes[index]! ^ 0x01;
  return bytes.toString('base64url');
};
const first = pushCases[0]!.envelope;
writeFileSync(new URL('push.json', out), `${JSON.stringify({
  description: 'Push envelopes: base64url(nonce[12] ‖ AES-256-GCM ciphertext ‖ tag[16]) with key, AAD "dsh-remote/push/1\\n" + hostId + "\\n" + handle. The plaintext is UTF-8 JSON padded with spaces to a multiple of 256 bytes; opened is the parsed message (title and body are already clipped by the sender). Every reject must fail to open.',
  key: pushKey.toString('base64url'),
  hostId: pushHostId,
  handle,
  valid: pushCases,
  reject: [
    { why: 'other handle', hostId: pushHostId, handle: randomBytes(16).toString('base64url'), envelope: first },
    { why: 'other host', hostId: 'f'.repeat(64), handle, envelope: first },
    { why: 'flipped nonce bit', hostId: pushHostId, handle, envelope: flip(first, 0) },
    { why: 'flipped ciphertext bit', hostId: pushHostId, handle, envelope: flip(first, 20) },
    { why: 'flipped tag bit', hostId: pushHostId, handle, envelope: flip(first, Buffer.from(first, 'base64url').length - 1) },
    { why: 'truncated', hostId: pushHostId, handle, envelope: first.slice(0, 30) },
  ],
}, null, 2)}\n`);

console.log('wrote protocol/vectors/{signing,cursor,pairing,push}.json');
