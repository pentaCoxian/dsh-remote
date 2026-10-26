// Install a release the way users do and check the plugin really runs: a throwaway
// DSH home, the release's install.mjs (with `dsh` on the PATH, dsh-mobile-maxxing
// fetched and checked by the installer) putting in an older build and upgrading it
// to this release, again with nothing to do, again over a profile broken by the 0.1.0
// URL instructions, then `dsh web`, the plugin's admin socket, its CLI and its DSH
// Web client module.
//   node --conditions=source scripts/smoke-release.ts release/dsh-remote-dsh-plugin-<version>.tgz
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const started = Date.now();
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what} [${((Date.now() - started) / 1000).toFixed(1)}s]`);
  if (!ok) process.exitCode = 1;
};
// Nothing here may wait forever: each child process and request has its own limit,
// and this catches whatever else hangs, with the tail of dsh web's log.
let log = '';
const watchdog = setTimeout(() => {
  console.log(`FAIL still running after 8 minutes; dsh web log:\n${log.slice(-3000)}`);
  process.exit(1);
}, 8 * 60_000);

const profile = join(home, 'profiles', 'web');
const dependencies = () => (JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies;
let runs = 0;
/** This process's descendants of `pid`, as `ps` lists them: what a hung run is waiting on. */
const tree = (pid: number) => {
  const rows = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,etime=,stat=,command='], { encoding: 'utf8' }).stdout.trim().split('\n').map((line) => line.trim().split(/\s+/));
  const wanted = new Set([String(pid)]);
  for (let size = 0; size !== wanted.size; ) {
    size = wanted.size;
    for (const [child, parent] of rows) if (wanted.has(parent!)) wanted.add(child!);
  }
  return rows.filter(([child]) => wanted.has(child!)).map((row) => row.join(' ').slice(0, 300)).join('\n');
};
const runInstaller = async (what: string, from = releaseDir) => {
  // Output to a file, not a pipe: a stray child holding a pipe would outlive the run.
  const output = join(home, `install-${(runs += 1)}.log`);
  const fd = openSync(output, 'w');
  const child = spawn(process.execPath, [installer, '--from', from], { env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  let hung = '';
  const timer = setTimeout(() => {
    hung = tree(child.pid!);
    child.kill('SIGKILL');
  }, 180_000);
  const status = await new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  clearTimeout(timer);
  const text = readFileSync(output, 'utf8');
  check(status === 0, `${what}${hung === '' ? '' : ' (still running after 3 minutes)'}`);
  if (status !== 0) throw new Error(`install.mjs output:\n${text.slice(-4000)}${hung === '' ? '' : `\nprocesses at the time:\n${hung}`}`);
  return text;
};

const version = /dsh-remote-dsh-plugin-(.+)\.tgz$/.exec(tarball)![1]!;
const installed = () => (JSON.parse(readFileSync(join(profile, 'node_modules', '@dsh-remote', 'dsh-plugin', 'package.json'), 'utf8')) as { version: string }).version;
// The same plugin numbered 0.0.1, so the upgrade below is a real version bump.
const older = join(home, 'older');
mkdirSync(join(older, 'unpacked'), { recursive: true });
spawnSync('tar', ['-xzf', tarball, '-C', join(older, 'unpacked')]);
const olderManifest = join(older, 'unpacked', 'package', 'package.json');
writeFileSync(olderManifest, JSON.stringify({ ...JSON.parse(readFileSync(olderManifest, 'utf8')), version: '0.0.1' }, null, 2));
spawnSync('tar', ['-czf', join(older, 'dsh-remote-dsh-plugin-0.0.1.tgz'), '-C', join(older, 'unpacked'), 'package']);

await runInstaller('install.mjs installs an older build into a fresh DSH home', older);
const local = dependencies();
check(local['@dsh-remote/dsh-plugin']?.startsWith('file:') === true && local[MOBILE_UI.name]?.startsWith('file:') === true && installed() === '0.0.1', 'both plugins come from checked local files');
const upgrade = await runInstaller('install.mjs upgrades it to this release (dsh-remote upgrade)');
check(installed() === version && !upgrade.includes(`${MOBILE_UI.name}-`), `the plugin is now ${installed()}, and dsh-mobile-maxxing was left alone`);
const again = await runInstaller('install.mjs again, with nothing to upgrade');
check(again.includes('already installed'), 'an up-to-date profile is left alone');
// What `dsh plugin add <URL>` left behind under the 0.1.0 instructions: pnpm refuses every later install.
const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
manifest.dependencies['@dsh-remote/dsh-plugin'] = 'https://github.com/pentaCoxian/dsh-remote/releases/download/v0.1.0/dsh-remote-dsh-plugin-0.1.0.tgz';
manifest.dependencies[MOBILE_UI.name] = MOBILE_UI.tarball;
writeFileSync(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const repair = await runInstaller('install.mjs over a profile set up from URLs');
check(repair.includes('repaired the profile') && !Object.values(dependencies()).some((spec) => spec.startsWith('http')) && installed() === version, 'the URL entries were replaced');

const port = await new Promise<number>((done) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = server.address() as { port: number };
    server.close(() => done(free));
  });
});
const overlay = join(home, 'smoke.patch.yml');
writeFileSync(overlay, '- id: dsh-remote\n  config:\n    hostName: Smoke\n    relays: []\n    pushGateway: null\n');
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
  const devices = spawnSync(process.execPath, [cli, 'devices'], { env, encoding: 'utf8', timeout: 30_000 });
  check(devices.status === 0, `bundled dsh-remote CLI answers (${devices.stdout.trim().split('\n')[0] ?? ''})`);

  // DSH Web, logged in as its owner, loads the plugin's client module (the /rc pairing dialog).
  const login = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(log)?.[0];
  const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const cookie = login === undefined ? undefined : (await get(login)).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const page = cookie === undefined ? '' : await (await get(`http://127.0.0.1:${port}/`, { cookie })).text();
  // The page's module table: {"id":"@dsh-remote/dsh-plugin","url":"plugins/??@dsh-remote/dsh-plugin/client.js&rev=…",…}
  const module = /"id":"@dsh-remote\/dsh-plugin","url":"([^"]+)"/.exec(page)?.[1];
  const client = module === undefined || cookie === undefined ? '' : await (await get(`http://127.0.0.1:${port}/${module}`, { cookie })).text();
  check(client.includes('dsh-remote-dialog'), `DSH Web serves the /rc pairing dialog module (${module === undefined ? `not in the ${page.length} B page` : `${client.length} B`})`);
} catch (error) {
  console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  // DSH gets a moment to shut down cleanly; its open pipes must not keep this script alive.
  const exited = dsh.exitCode !== null || dsh.signalCode !== null ? Promise.resolve() : new Promise((done) => dsh.once('exit', done));
  dsh.kill('SIGTERM');
  await Promise.race([exited, new Promise((done) => setTimeout(done, 10_000))]);
  dsh.kill('SIGKILL');
  rmSync(home, { recursive: true, force: true });
  clearTimeout(watchdog);
  process.exit();
}
