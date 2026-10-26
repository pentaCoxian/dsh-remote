// Phone-side interop fixture: a RemoteHost on FakeAdapter over iroh, relays off.
// Used by the Rust pipe (apps/mobile/native/dshr_pipe tests/interop.rs) and the
// app's Dart transport test (apps/mobile/test/pipe_e2e_test.dart).
//   node --conditions=source test/fixtures/iroh-host.ts
// Prints one JSON line {hostId, url}, approves every pairing request, and plays
// the phone's keystore for tests that cannot do P-256 themselves: each stdin
// line {"op":"generate"|"sign", ...} gets one JSON reply line. Exits when stdin closes.
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createInterface } from 'node:readline';
import { startLiveHost } from '../helpers/live.ts';

const live = await startLiveHost({ iroh: true });
live.host.onPairingChange((request) => {
  if (request.state === 'pending') void live.host.approvePairing(request.pairingRequestId);
});
const offer = live.host.offerPairing('session-a');
process.stdout.write(`${JSON.stringify({ hostId: live.host.hostId, url: offer.url })}\n`);

const keys = new Map<string, KeyObject>();
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line) as { op: string; alias: string; data?: string };
  if (request.op === 'generate') {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    keys.set(request.alias, pair.privateKey);
    process.stdout.write(`${JSON.stringify({ publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') })}\n`);
  } else if (request.op === 'sign') {
    const signature = sign('sha256', Buffer.from(request.data!, 'base64'), { key: keys.get(request.alias)!, dsaEncoding: 'der' });
    process.stdout.write(`${JSON.stringify({ signature: signature.toString('base64') })}\n`);
  }
});
lines.on('close', async () => {
  await live.close();
  process.exit(0);
});
