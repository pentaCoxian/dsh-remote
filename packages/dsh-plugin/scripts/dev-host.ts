// DEV ONLY. A complete DSH Remote host with no DSH and no Cloudflare, for
// building the phone app: RemoteHost on FakeAdapter, behind a small proxy that
// plays Cloudflare Access by turning `Authorization: Bearer dev-<name>` into a
// locally signed Cf-Access-Jwt-Assertion. Never deploy this.
//
//   node scripts/dev-host.ts [--lan] [--port 4319]
//   then: stdin commands `pair`, `ask`, `stream`, `local <session>`, `quit`
//
// The app's dev build maps the QR origin https://dsh.dev.invalid to this proxy.
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import QRCode from 'qrcode';
import { HEADERS } from '@dsh-remote/protocol';
import { createAccessVerifier } from '../src/core/access.ts';
import { MemoryAudit } from '../src/core/audit.ts';
import { systemClock } from '../src/core/clock.ts';
import { HostIdentity } from '../src/core/host-identity.ts';
import { MemoryStore } from '../src/core/store.ts';
import { RemoteHost } from '../src/host.ts';
import { FakeAdapter } from '../src/testing/fake-adapter.ts';

const args = process.argv.slice(2);
const lan = args.includes('--lan');
const proxyPort = Number(args[args.indexOf('--port') + 1] ?? 4319) || 4319;
const PUBLIC_HOST = 'dsh.dev.invalid';
const ISSUER = 'https://dev.cloudflareaccess.invalid';
const AUD = 'd'.repeat(64);

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'dev', alg: 'RS256' };
const access = createAccessVerifier({ issuer: ISSUER, audiences: [AUD], keys: createLocalJWKSet({ keys: [jwk] }) });

const adapter = new FakeAdapter();
adapter.autoReply = false;
adapter.addSession('session-dev-1', { cwd: '/home/dev/api', title: 'Refactor the API' });
adapter.addSession('session-dev-2', { cwd: '/home/dev/web', title: 'Fix the flaky test' });
const host = await RemoteHost.create({
  adapter,
  access,
  clock: systemClock,
  identity: HostIdentity.generate(),
  stateStore: new MemoryStore(),
  receiptsStore: new MemoryStore(),
  audit: new MemoryAudit(),
  publicHost: PUBLIC_HOST,
  linkOrigin: 'https://link.dev.invalid',
  port: 0,
  hostName: 'Dev Host',
  grantTtlMs: 7 * 86_400_000,
  remoteApprovalTimeoutMs: 600_000,
});
await host.publish('session-dev-1');
await host.publish('session-dev-2');
const apiPort = await host.start();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Scripted turn: stream words as deltas, then commit the message. */
async function reply(sessionId: string, text: string, requestId?: string, principal?: unknown): Promise<void> {
  adapter.startTurn(sessionId, text, requestId, principal);
  const answer = `Here is what I found about “${text}”: 3 tests passed, 1 failed in api/auth.spec.ts.`;
  const attemptId = `att_${Date.now()}`;
  adapter.stream(sessionId, { type: 'start', attemptId, turn: 1, step: 1 });
  for (const [index, word] of answer.split(/(?<= )/).entries()) {
    adapter.stream(sessionId, { type: 'chunk', attemptId, index, time: Date.now(), chunk: { type: 'text-delta', delta: word } });
    await sleep(60);
  }
  adapter.stream(sessionId, { type: 'end', attemptId, committed: true });
  adapter.append(sessionId, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });
  adapter.endTurn(sessionId);
}

adapter.onPrompt = (deviceId, submission) => {
  void reply(submission.sessionId, submission.text, submission.requestId, { kind: 'dsh-remote-device', deviceId });
};

async function assertionFor(name: string): Promise<string> {
  return new SignJWT({ email: `${name}@dev.invalid`, type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: 'dev' })
    .setIssuer(ISSUER)
    .setAudience([AUD])
    .setSubject(`dev-${name}`)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(privateKey);
}

/** Resolve the dev identity from `Authorization: Bearer dev-<name>`; anything else gets no assertion. */
async function accessHeaders(authorization: string | undefined): Promise<Record<string, string>> {
  const match = /^Bearer dev-([a-z0-9]{1,32})$/.exec(authorization ?? '');
  return match === null ? {} : { [HEADERS.accessAssertion]: await assertionFor(match[1]!) };
}

function rewrite(headers: NodeJS.Dict<string | string[]>, extra: Record<string, string>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) if (value !== undefined && key !== 'authorization' && key !== HEADERS.accessAssertion) out[key] = value;
  return { ...out, host: PUBLIC_HOST, ...extra };
}

const proxy = createServer(async (req, res) => {
  if (req.headers.authorization === undefined) {
    // Shape of a Managed OAuth refusal for clients exploring discovery.
    res.writeHead(401, { 'www-authenticate': 'Bearer realm="dev"', 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
    return;
  }
  const upstream = httpRequest({ host: '127.0.0.1', port: apiPort, method: req.method, path: req.url, headers: rewrite(req.headers, await accessHeaders(req.headers.authorization)) }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on('error', () => res.writeHead(502).end());
  req.pipe(upstream);
});
proxy.on('upgrade', async (req, socket, head) => {
  const headers = rewrite(req.headers, await accessHeaders(req.headers.authorization));
  const upstream = connect(apiPort, '127.0.0.1', () => {
    const lines = Object.entries(headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((v) => `${key}: ${v}`));
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});
const bind = lan ? '0.0.0.0' : '127.0.0.1';
await new Promise<void>((resolve) => proxy.listen(proxyPort, bind, resolve));

const addresses = lan ? Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address) : ['127.0.0.1'];
console.log(`\nDSH Remote dev host (FAKE DSH, FAKE ACCESS — never expose this)`);
console.log(`  proxy:    ${addresses.map((a) => `http://${a}:${proxyPort}`).join(', ')}  (Android emulator: http://10.0.2.2:${proxyPort})`);
console.log(`  identity: send "Authorization: Bearer dev-owner"`);
console.log(`  map https://${PUBLIC_HOST} → the proxy in the app's dev build\n`);

async function showPairing(): Promise<void> {
  const offer = host.offerPairing('session-dev-1');
  console.log(await QRCode.toString(offer.url, { type: 'terminal', small: true }));
  console.log(offer.url);
}

host.onPairingChange((request) => {
  if (request.state !== 'pending') return;
  console.log(`\nPairing request from ${request.accessEmail}: ${request.deviceLabel} (${request.platform}), key ${request.fingerprint.slice(0, 16)}`);
  console.log('Type `y` to approve or `n` to deny.');
  pendingDecision = request.pairingRequestId;
});
let pendingDecision: string | undefined;

await showPairing();
const input = createInterface({ input: process.stdin, output: process.stdout });
for await (const line of input) {
  const [command, argument] = line.trim().split(/\s+/);
  if ((command === 'y' || command === 'n') && pendingDecision !== undefined) {
    if (command === 'y') console.log(`approved: ${(await host.approvePairing(pendingDecision))?.deviceId ?? 'expired'}`);
    else host.denyPairing(pendingDecision);
    pendingDecision = undefined;
  } else if (command === 'pair') {
    await showPairing();
  } else if (command === 'ask') {
    const sessionId = argument ?? 'session-dev-1';
    adapter.startTurn(sessionId, 'run the test suite');
    const outcome = await adapter.askApproval(sessionId, 'bash', JSON.stringify({ command: 'pnpm test --filter api' }));
    console.log(`approval outcome: ${outcome}`);
    adapter.endTurn(sessionId);
  } else if (command === 'stream') {
    await reply(argument ?? 'session-dev-1', 'what changed?');
  } else if (command === 'local') {
    await reply(argument ?? 'session-dev-1', 'typed at the host');
  } else if (command === 'quit') {
    break;
  } else if (command !== '') {
    console.log('commands: pair | y | n | ask [session] | stream [session] | local [session] | quit');
  }
}
input.close();
await host.stop();
proxy.close();
process.exit(0);
