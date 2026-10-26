// Install a release the way users do and check the plugin really runs: a throwaway
// DSH home, the release's install.mjs (with `dsh` on the PATH, dsh-mobile-maxxing
// fetched and checked by the installer), the same again over a profile broken by
// the 0.1.0 URL instructions, `dsh web`, then the plugin's admin socket, its CLI
// and its DSH Web client module.
//   node --conditions=source scripts/smoke-release.ts release/dsh-remote-dsh-plugin-<version>.tgz
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AdminClient } from '../src/admin/socket.ts';
import { MOBILE_UI } from '../src/dsh/mobile-ui.ts';
import type { HostStatus, PairingOffer } from '../src/host.ts';

const tarball = resolve(process.argv[2] ?? '');
if (!existsSync(tarball)) throw new Error(`no tarball at ${tarball}`);
const releaseDir = dirname(tarball);
const installer = join(releaseDir, 'install.mjs');
if (!existsSync(installer)) throw new Error(`no install.mjs next to ${tarball}`);
const dshBin = join(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js');
const home = mkdtempSync(join(tmpdir(), 'dsh-remote-smoke-'));
chmodSync(home, 0o700);
// The installer runs `dsh` from the PATH, as on a user's machine.
const bin = join(home, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'dsh'), `#!/bin/sh\nexec "${process.execPath}" "${dshBin}" "$@"\n`, { mode: 0o755 });
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', PATH: `${bin}:${process.env.PATH ?? ''}` };
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) process.exitCode = 1;
};

const profile = join(home, 'profiles', 'web');
const dependencies = () => (JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies;
const runInstaller = (what: string) => {
  const run = spawnSync(process.execPath, [installer, '--from', releaseDir], { env, encoding: 'utf8' });
  check(run.status === 0, what);
  if (run.status !== 0) throw new Error(`${run.stdout}\n${run.stderr}`);
  return run.stdout;
};

runInstaller('install.mjs installs into a fresh DSH home');
const local = dependencies();
check(local['@dsh-remote/dsh-plugin']?.startsWith('file:') === true && local[MOBILE_UI.name]?.startsWith('file:') === true, 'both plugins come from checked local files');
// What `dsh plugin add <URL>` left behind under the 0.1.0 instructions: pnpm refuses every later install.
const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
manifest.dependencies['@dsh-remote/dsh-plugin'] = 'https://github.com/pentaCoxian/dsh-remote/releases/download/v0.1.0/dsh-remote-dsh-plugin-0.1.0.tgz';
manifest.dependencies[MOBILE_UI.name] = MOBILE_UI.tarball;
writeFileSync(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const repair = runInstaller('install.mjs over a profile set up from URLs');
check(repair.includes('repaired the profile') && !Object.values(dependencies()).some((spec) => spec.startsWith('http')), 'the URL entries were replaced');
runInstaller('install.mjs again (dsh-remote upgrade) over its own install');

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
  const cli = join(profile, 'node_modules', '@dsh-remote', 'dsh-plugin', 'dist', 'cli.js');
  const devices = spawnSync(process.execPath, [cli, 'devices'], { env, encoding: 'utf8' });
  check(devices.status === 0, `bundled dsh-remote CLI answers (${devices.stdout.trim().split('\n')[0] ?? ''})`);

  // DSH Web, logged in as its owner, loads the plugin's client module (the /rc pairing dialog).
  const login = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(log)?.[0];
  const cookie = login === undefined ? undefined : (await fetch(login, { redirect: 'manual' })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const page = cookie === undefined ? '' : await (await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } })).text();
  // The page's module table: {"id":"@dsh-remote/dsh-plugin","url":"plugins/??@dsh-remote/dsh-plugin/client.js&rev=…",…}
  const module = /"id":"@dsh-remote\/dsh-plugin","url":"([^"]+)"/.exec(page)?.[1];
  const client = module === undefined || cookie === undefined ? '' : await (await fetch(`http://127.0.0.1:${port}/${module}`, { headers: { cookie } })).text();
  check(client.includes('dsh-remote-dialog'), `DSH Web serves the /rc pairing dialog module (${module === undefined ? `not in the ${page.length} B page` : `${client.length} B`})`);
} finally {
  dsh.kill('SIGTERM');
  await new Promise((done) => setTimeout(done, 500));
  rmSync(home, { recursive: true, force: true });
}
