// Install a release tarball the way users do and check the plugin really runs:
// a throwaway DSH home, `dsh plugin --profile web add <tgz>` (with a stand-in for
// dsh-mobile-maxxing), `dsh web`, then the plugin's admin socket and its own CLI.
//   node --conditions=source scripts/smoke-release.ts release/dsh-remote-dsh-plugin-<version>.tgz
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AdminClient } from '../src/admin/socket.ts';
import type { HostStatus, PairingOffer } from '../src/host.ts';

const tarball = resolve(process.argv[2] ?? '');
if (!existsSync(tarball)) throw new Error(`no tarball at ${tarball}`);
const pluginDir = new URL('..', import.meta.url).pathname;
const dshBin = join(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js');
const home = mkdtempSync(join(tmpdir(), 'dsh-remote-smoke-'));
chmodSync(home, 0o700);
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) process.exitCode = 1;
};

const add = spawnSync(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', tarball, join(pluginDir, 'test/fixtures/fake-mobile-ui')], { env, encoding: 'utf8' });
check(add.status === 0, 'dsh plugin --profile web add <tarball>');
if (add.status !== 0) throw new Error(`${add.stdout}\n${add.stderr}`);

const port = await new Promise<number>((done) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = server.address() as { port: number };
    server.close(() => done(free));
  });
});
const overlay = join(home, 'smoke.patch.yml');
writeFileSync(overlay, '- id: dsh-remote\n  config:\n    hostName: Smoke\n    relays: []\n    pushGateway: null\n');
let log = '';
const dsh = spawn(process.execPath, [dshBin, 'web', '--patch', overlay, '--host', '127.0.0.1', '--port', String(port), '--no-open'], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
dsh.stdout!.on('data', (chunk) => (log += chunk));
dsh.stderr!.on('data', (chunk) => (log += chunk));

try {
  let admin: AdminClient | undefined;
  for (let i = 0; i < 300 && admin === undefined; i += 1) {
    admin = await AdminClient.connect(join(home, 'remote', 'admin.sock')).catch(() => undefined);
    if (admin === undefined) await new Promise((done) => setTimeout(done, 200));
  }
  check(admin !== undefined, 'the plugin started inside dsh web (admin socket)');
  if (admin === undefined) throw new Error(`dsh web log:\n${log.slice(-3000)}`);
  const status = await admin.call<HostStatus>({ method: 'status' });
  check(status.entry === 'production', `production entry (${status.entry})`);
  check(status.transport !== null, 'iroh endpoint running');
  check(status.loopbackPort === null, 'no TCP listener');
  check(status.web === 'ready', `DSH Web tunnel ready (${status.web})`);
  check(status.mobileUi?.ok === true, `phone layout found (${JSON.stringify(status.mobileUi)})`);
  check(status.push.gateway === null, 'notifications off as configured');
  const offer = await admin.call<PairingOffer>({ method: 'offerPairing' });
  check(offer.url.startsWith('dshremote://pair?v=2&'), 'pairing code offered');
  admin.close();
  const cli = join(home, 'profiles', 'web', 'node_modules', '@dsh-remote', 'dsh-plugin', 'dist', 'cli.js');
  const devices = spawnSync(process.execPath, [cli, 'devices'], { env, encoding: 'utf8' });
  check(devices.status === 0, `bundled dsh-remote CLI answers (${devices.stdout.trim().split('\n')[0] ?? ''})`);
} finally {
  dsh.kill('SIGTERM');
  await new Promise((done) => setTimeout(done, 500));
  rmSync(home, { recursive: true, force: true });
}
