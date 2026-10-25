// Regenerate protocol/vectors/*.json (shared by Node and Dart tests).
// Keys are generated per run and stored in the vectors: they are test-only.
//   pnpm --filter @dsh-remote/protocol vectors
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { canonicalRequestString, sha256Hex } from '../src/signing.ts';
import { encodeCursor } from '../src/cursor.ts';
import { buildPairingUrl, grantSigningString } from '../src/pairing.ts';
import { spkiFingerprint } from '../src/keys.ts';

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

const host = keyPair();
const grant = {
  hostId: 'host_TESTtestTESTtest01',
  pairingRequestId: `pair_${randomBytes(18).toString('base64url')}`,
  deviceId: 'dev_TESTtestTESTtest01',
  deviceKeyFingerprint: device.json.fingerprint,
  scopes: ['session:write', 'host:read', 'approval:respond', 'session:read', 'approval:read', 'workspace:read'] as const,
  expiresAt: 1_800_676_000_000,
};
const grantString = grantSigningString(grant);
writeFileSync(new URL('grant.json', out), `${JSON.stringify({
  description: 'Host-signed device grant. signingString sorts scopes; verify signature with hostKey.spki.',
  hostKey: host.json,
  grant,
  signingString: grantString,
  signature: signText(host.privateKey, grantString),
}, null, 2)}\n`);

writeFileSync(new URL('cursor.json', out), `${JSON.stringify({
  description: 'Opaque cursor encoding: c1. + base64url(JSON {s, q}).',
  valid: [
    { sessionId: 'session-f438ec89-39f9-42dd-9ccb-8383a74ccce3', seq: 25 },
    { sessionId: 'ses_8f21', seq: -1 },
  ].map((value) => ({ ...value, cursor: encodeCursor(value) })),
  invalid: ['', 'c1.', 'c2.eyJzIjoieCIsInEiOjF9', 'c1.eyJzIjoieCIsInEiOi0yfQ', 'c1.eyJzIjoieCIsInEiOjEuNX0', 'c1.eyJzIjoieCIsInEiOjEsIngiOjF9', 'c1.!!'],
}, null, 2)}\n`);

const payload = {
  origin: 'https://dsh.example.com',
  hostId: grant.hostId,
  challengeId: `chl_${randomBytes(18).toString('base64url')}`,
  hostKeyFingerprint: host.json.fingerprint,
  sessionId: 'session-8f21',
};
writeFileSync(new URL('pairing.json', out), `${JSON.stringify({
  description: 'Pairing QR URLs on the public link host; the payload is in the fragment.',
  valid: [{ url: buildPairingUrl('https://link.example.com', payload), payload }],
  invalid: [
    'http://link.example.com/p#v=1',
    `https://link.example.com/p?x=1#v=1&o=${encodeURIComponent(payload.origin)}`,
    `https://link.example.com/p#v=2&o=${encodeURIComponent(payload.origin)}&h=${payload.hostId}&c=${payload.challengeId}&f=${payload.hostKeyFingerprint}`,
    `https://link.example.com/p#v=1&o=${encodeURIComponent('https://dsh.example.com/path')}&h=${payload.hostId}&c=${payload.challengeId}&f=${payload.hostKeyFingerprint}`,
    `https://link.example.com/p#v=1&o=${encodeURIComponent(payload.origin)}&h=${payload.hostId}&h=${payload.hostId}&c=${payload.challengeId}&f=${payload.hostKeyFingerprint}`,
  ],
}, null, 2)}\n`);

console.log('wrote protocol/vectors/{signing,grant,cursor,pairing}.json');
