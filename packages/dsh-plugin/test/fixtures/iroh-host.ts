// Phone-side interop fixture: a RemoteHost on FakeAdapter over iroh, relays off.
// Used by the Rust pipe (apps/mobile/native/dshr_pipe tests/interop.rs) and the
// app's Dart transport test (apps/mobile/test/pipe_e2e_test.dart).
//   node --conditions=source test/fixtures/iroh-host.ts
// Prints one JSON line {hostId, url}, approves every pairing request, and plays
// the phone's keystore for tests that cannot do P-256 themselves: each stdin
// line {"op":"generate"|"sign", ...} gets one JSON reply line. Exits when stdin closes.
// With --offers <port>, GET http://127.0.0.1:<port>/offer returns a fresh {hostId, url}
// (pairing codes live 120 s; a device test fetches its own once the app is installed).
// With --relays <url>[,<url>] the host homes on those relays and binds every
// interface, so a physical phone can reach it (direct on the LAN, else relayed).
// A fake DSH Web (test/helpers/fake-dsh-web.ts) sits behind the web tunnel.
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { startFakeDshWeb } from '../helpers/fake-dsh-web.ts';
import { startLiveHost } from '../helpers/live.ts';

const relays = process.argv.includes('--relays') ? process.argv[process.argv.indexOf('--relays') + 1]!.split(',') : undefined;
const dshWeb = await startFakeDshWeb();
const web = { target: () => ({ host: '127.0.0.1', port: dshWeb.port }), launchTokenQuery: () => `token=${dshWeb.token}` };
const live = await startLiveHost(relays === undefined ? { iroh: true, web } : { relays, web });
if (relays !== undefined) await live.host.endpoint!.online(10_000);
live.host.onPairingChange((request) => {
  if (request.state === 'pending') void live.host.approvePairing(request.pairingRequestId);
});
const offer = () => ({ hostId: live.host.hostId, url: live.host.offerPairing('session-a').url });
process.stdout.write(`${JSON.stringify(offer())}\n`);
const offersPort = process.argv.includes('--offers') ? Number(process.argv[process.argv.indexOf('--offers') + 1]) : undefined;
if (offersPort !== undefined) {
  createServer((req, res) => {
    if (req.url !== '/offer') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(offer()));
  }).listen(offersPort, '127.0.0.1');
}

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
  await dshWeb.close();
  process.exit(0);
});
