import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { AdminClient } from '../admin/socket.ts';
import { stateDir } from '../dsh/plugin.ts';

type Level = 'pass' | 'warn' | 'fail';
const MARK: Record<Level, string> = { pass: '✓', warn: '!', fail: '✗' };

interface Status {
  hostName: string;
  origin: string;
  listening: boolean;
  port: number | null;
  teamName: string | null;
  entry: string;
}

/**
 * Non-destructive preflight (spec §2): it reads local state and probes the
 * public hostname without credentials. It never provisions or changes anything.
 */
export async function runDoctor(args: string[]): Promise<number> {
  const metricsUrl = (args.includes('--metrics') ? args[args.indexOf('--metrics') + 1] : undefined) ?? 'http://127.0.0.1:20241/ready';
  const results: { level: Level; text: string }[] = [];
  const report = (level: Level, text: string) => {
    results.push({ level, text });
    process.stdout.write(`${MARK[level]} ${text}\n`);
  };

  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  report(major > 24 || (major === 24 && minor >= 9) ? 'pass' : 'fail', `Node ${process.versions.node} (DSH needs 24.9 or newer)`);

  const dir = stateDir();
  const mode = (path: string) => statSync(path).mode & 0o777;
  try {
    report(mode(dir) === 0o700 ? 'pass' : 'fail', `state directory ${dir} is ${mode(dir).toString(8)} (want 700)`);
    for (const file of ['host-key.pem', 'state.json']) {
      const path = join(dir, file);
      report(mode(path) === 0o600 ? 'pass' : 'fail', `${file} is ${mode(path).toString(8)} (want 600)`);
    }
  } catch {
    report('fail', `no DSH Remote state in ${dir}: has the plugin started in the web profile?`);
  }

  let status: Status | undefined;
  try {
    const client = await AdminClient.connect(join(dir, 'admin.sock'));
    status = await client.call<Status>({ method: 'status' });
    client.close();
    report('pass', `DSH host is running the plugin (${status.hostName})`);
  } catch {
    report('fail', 'cannot reach the running DSH host over the admin socket: start `dsh web` with the plugin (see deployment/)');
  }

  if (status !== undefined) {
    report(status.entry === 'production' ? 'pass' : 'fail', `plugin entry: ${status.entry}`);
    report(status.listening && status.port !== null ? 'pass' : 'fail', status.port === null ? 'native API is not listening (run /rc for the reason)' : `native API listening on 127.0.0.1:${status.port}`);
    if (status.port !== null) {
      const exposed = await nonLoopbackReachable(status.port);
      report(exposed.length === 0 ? 'pass' : 'fail', exposed.length === 0 ? 'native API is not reachable on any non-loopback address' : `native API answers on ${exposed.join(', ')}`);
    }
    if (status.teamName !== null) {
      const jwks = await fetchJson(`https://${status.teamName}.cloudflareaccess.com/cdn-cgi/access/certs`);
      const keys = Array.isArray((jwks as { keys?: unknown[] } | undefined)?.keys) ? (jwks as { keys: unknown[] }).keys.length : 0;
      report(keys > 0 ? 'pass' : 'fail', keys > 0 ? `Access signing keys reachable for team ${status.teamName} (${keys})` : `cannot read Access signing keys for team ${status.teamName}`);
    }
    const ready = await fetch(metricsUrl, { signal: AbortSignal.timeout(3_000) }).then((r) => r.status, () => 0);
    report(ready === 200 ? 'pass' : 'warn', ready === 200 ? 'cloudflared reports ready' : `cloudflared readiness not reachable at ${metricsUrl}`);

    const edge = await probe(`${status.origin}/v1/meta`);
    if (edge === undefined) report('fail', `${status.origin} is not reachable`);
    else if (edge.fromOrigin) report('fail', `${status.origin} reached the plugin without Cloudflare Access: check the Access application and Bypass rules`);
    else report(edge.status === 401 || edge.status === 403 || (edge.status >= 300 && edge.status < 400) ? 'pass' : 'warn', `unauthenticated request is refused at the edge (${edge.status})`);
    const upgrade = await probe(`${status.origin}/v1/events`, true);
    report(upgrade !== undefined && upgrade.status !== 101 && !upgrade.fromOrigin ? 'pass' : 'fail', `unauthenticated WebSocket upgrade is refused (${upgrade?.status ?? 'no answer'})`);
  }

  report(serviceEnabled() ? 'pass' : 'warn', serviceEnabled() ? 'DSH host service is installed' : 'no supervised DSH host service found (deployment/install.sh)');

  const failures = results.filter((r) => r.level === 'fail').length;
  process.stdout.write(failures === 0 ? '\nReady.\n' : `\n${failures} problem(s) to fix.\n`);
  return failures === 0 ? 0 : 1;
}

async function nonLoopbackReachable(port: number): Promise<string[]> {
  const addresses = Object.values(networkInterfaces()).flat().filter((i) => i !== undefined && !i.internal).map((i) => i!.address);
  const open = await Promise.all(
    addresses.map(
      (address) =>
        new Promise<string | undefined>((resolve) => {
          const socket = connect({ host: address, port, timeout: 1_000 });
          socket.once('connect', () => (socket.destroy(), resolve(address)));
          socket.once('error', () => resolve(undefined));
          socket.once('timeout', () => (socket.destroy(), resolve(undefined)));
        }),
    ),
  );
  return open.filter((a): a is string => a !== undefined);
}

async function fetchJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

/** One credential-less request; `fromOrigin` means the plugin itself answered. */
function probe(url: string, upgrade = false): Promise<{ status: number; fromOrigin: boolean } | undefined> {
  return new Promise((resolve) => {
    const req = httpsRequest(url, {
      method: 'GET',
      timeout: 8_000,
      headers: upgrade ? { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } : { accept: 'application/json' },
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, fromOrigin: res.headers['x-dsh-request-id'] !== undefined });
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: 101, fromOrigin: res.headers['x-dsh-request-id'] !== undefined });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(undefined));
    req.end();
  });
}

function serviceEnabled(): boolean {
  try {
    if (process.platform === 'darwin') {
      execFileSync('launchctl', ['print', `gui/${process.getuid?.()}/dev.dshremote.host`], { stdio: 'ignore' });
      return true;
    }
    execFileSync('systemctl', ['--user', 'is-enabled', '--quiet', 'dsh-remote-host.service'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
