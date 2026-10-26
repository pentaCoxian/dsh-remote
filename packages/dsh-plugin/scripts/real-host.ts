// DEV ONLY. A real `dsh web` (the pinned DSH 0.2.1-rc.3) running this plugin's
// production entry, for trying the app against the real DSH Web. A scripted
// model (test/integration/fake-llm.mjs) answers turns, so no API key is needed.
//
//   pnpm --filter @dsh-remote/dsh-plugin build
//   node --conditions=source scripts/real-host.ts [--home DIR] [--relays default|none|<url>,<url>] [--approve] [--offers PORT] [--push-gateway TICKET]
//
// Prints the pairing code as a QR and as text. --approve approves every pairing
// request at once (never on a real host). --offers serves a fresh code at
// http://127.0.0.1:PORT/offer, e.g. for `adb reverse` + `adb shell am start -d <code>`.
// State persists in --home (default .dsh-home/real-host), so a paired phone stays paired.
// dsh-mobile-maxxing (DSH Web's phone layout, which DSH Remote requires) is installed next to
// the plugin; --no-mobile-ui leaves it out, to see what the app says without it.
// Notifications go through the DSH Remote gateway on nrt1; --push-gateway TICKET picks another
// (e.g. push-gateway's scripts/dev-gateway.ts), --push-gateway none turns them off.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import QRCode from 'qrcode';
import { AdminClient } from '../src/admin/socket.ts';
import { DEFAULT_RELAYS } from '../src/dsh/config.ts';
import { MOBILE_UI } from '../src/dsh/mobile-ui.ts';
import type { PairingOffer, PendingPairing } from '../src/host.ts';

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const pluginDir = resolve(import.meta.dirname, '..');
const home = resolve(option('--home') ?? join(pluginDir, '../../.dsh-home/real-host'));
const relaysOption = option('--relays') ?? 'default';
const relays = relaysOption === 'none' ? [] : relaysOption === 'default' ? DEFAULT_RELAYS : relaysOption.split(',');
const approve = args.includes('--approve');
const offersPort = option('--offers') === undefined ? undefined : Number(option('--offers'));
const pushGateway = option('--push-gateway');
const dshBin = join(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js');

if (!existsSync(join(pluginDir, 'dist/index.js'))) throw new Error('build the plugin first: pnpm --filter @dsh-remote/dsh-plugin build');
mkdirSync(home, { recursive: true });
chmodSync(home, 0o700);

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}

const children: ChildProcess[] = [];
const stop = () => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const modelPort = await freePort();
children.push(spawn(process.execPath, [join(pluginDir, 'test/integration/fake-llm.mjs'), String(modelPort)], { stdio: 'ignore' }));

const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', FAKE_LLM_KEY: 'dev' };
const withMobileUi = !args.includes('--no-mobile-ui');
const add = spawnSync(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', pluginDir, ...(withMobileUi ? [MOBILE_UI.tarball] : [])], { env, encoding: 'utf8' });
if (!withMobileUi) spawnSync(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'remove', MOBILE_UI.name], { env, encoding: 'utf8' });
if (add.status !== 0) throw new Error(`dsh plugin add failed:\n${add.stdout}\n${add.stderr}`);

const overlay = join(home, 'real-host.patch.yml');
writeFileSync(
  overlay,
  `- id: dsh-remote
  config:
    hostName: Real DSH (dev)
    relays: ${JSON.stringify(relays)}
${pushGateway === undefined ? '' : `    pushGateway: ${pushGateway === 'none' ? 'null' : JSON.stringify(pushGateway)}\n`}- id: llm-pi-ai
  config:
    providers:
      fake:
        displayName: DSH Remote fake model
        apiKeyEnv: FAKE_LLM_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:${modelPort}/v1
        models:
          - id: fake-model
            name: Fake model
            contextWindow: 128000
            maxTokens: 4096
- id: agent-default-model
  config:
    provider: fake
    model: fake-model
`,
);
const webPort = Number(option('--port') ?? 3090);
const dsh = spawn(process.execPath, [dshBin, 'web', '--patch', overlay, '--host', '127.0.0.1', '--port', String(webPort), '--no-open'], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
children.push(dsh);
dsh.stdout!.on('data', (chunk) => process.stdout.write(`[dsh] ${chunk}`));
dsh.stderr!.on('data', (chunk) => process.stderr.write(`[dsh] ${chunk}`));
dsh.on('exit', (code) => {
  console.error(`dsh web exited (${code})`);
  stop();
});

let admin: AdminClient | undefined;
for (let i = 0; i < 300 && admin === undefined; i += 1) {
  admin = await AdminClient.connect(join(home, 'remote', 'admin.sock')).catch(() => undefined);
  if (admin === undefined) await new Promise((done) => setTimeout(done, 200));
}
if (admin === undefined) throw new Error('the plugin did not start; see the [dsh] output');
const client = admin;

const offer = async () => client.call<PairingOffer>({ method: 'offerPairing' });
const first = await offer();
console.log(`\nReal DSH host ${first.hostId.slice(0, 10)} · DSH Web on 127.0.0.1:${webPort} · relays ${relays.length === 0 ? 'none' : relays.join(', ')}`);
console.log(await QRCode.toString(first.url, { type: 'terminal', small: true }));
console.log(first.url);
console.log(approve ? '\nApproving every pairing request (dev only).' : '\nApprove pairing with: dsh-remote pair (DSH_HOME set to this home).');

if (offersPort !== undefined) {
  createServer(async (req, res) => {
    if (req.url !== '/offer') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await offer()));
  }).listen(offersPort, '127.0.0.1');
  console.log(`Fresh codes: http://127.0.0.1:${offersPort}/offer`);
}

if (approve) {
  setInterval(async () => {
    for (const request of await client.call<PendingPairing[]>({ method: 'pendingPairings' }).catch(() => [])) {
      await client.call({ method: 'decidePairing', pairingRequestId: request.pairingRequestId, decision: 'approve' });
      console.log(`approved ${request.deviceLabel} (${request.platform}), key ${request.shortFingerprint}`);
    }
  }, 1_000);
}
