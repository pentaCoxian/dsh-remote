import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import iroh from '@number0/iroh';
import { AdminClient } from '../admin/socket.ts';
import { stateDir } from '../dsh/plugin.ts';
import type { HostStatus } from '../host.ts';
import { ALPN } from '../transport/iroh.ts';

const { Endpoint, EndpointAddr, EndpointId, RelayMode } = iroh;

type Level = 'pass' | 'warn' | 'fail';
const MARK: Record<Level, string> = { pass: '✓', warn: '!', fail: '✗' };
const DIAL_TIMEOUT_MS = 15_000;

/**
 * Non-destructive preflight (spec §2): it reads local state, asks the running
 * host for its status and dials the host through its home relay the way a
 * phone off the LAN would. It never provisions or changes anything.
 */
export async function runDoctor(_args: string[]): Promise<number> {
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
    for (const file of ['endpoint-key', 'state.json']) {
      const path = join(dir, file);
      report(mode(path) === 0o600 ? 'pass' : 'fail', `${file} is ${mode(path).toString(8)} (want 600)`);
    }
  } catch {
    report('fail', `no DSH Remote state in ${dir}: has the plugin started in the web profile?`);
  }

  let status: HostStatus | undefined;
  try {
    const client = await AdminClient.connect(join(dir, 'admin.sock'));
    status = await client.call<HostStatus>({ method: 'status' });
    client.close();
    report('pass', `DSH host is running the plugin (${status.hostName}, id ${status.hostId.slice(0, 10)})`);
  } catch {
    report('fail', 'cannot reach the running DSH host over the admin socket: start `dsh web` with the plugin (see deployment/)');
  }

  if (status !== undefined) {
    report(status.entry === 'production' ? 'pass' : 'fail', `plugin entry: ${status.entry}`);
    report(status.loopbackPort === null ? 'pass' : 'fail', status.loopbackPort === null ? 'no TCP listener: the API is reachable only over iroh' : `a test listener is open on 127.0.0.1:${status.loopbackPort}`);
    const transport = status.transport;
    if (transport === null) {
      report('fail', 'the iroh endpoint is not running (run /rc for the reason)');
    } else if (transport.relays.length === 0) {
      report('warn', 'relays are disabled: phones can reach this host only on its direct addresses, usually the same LAN');
    } else if (transport.homeRelay === null) {
      report('fail', `not connected to any relay (${transport.relays.join(', ')}): check outbound HTTPS from this machine`);
    } else {
      report('pass', `home relay ${transport.homeRelay}`);
      const dial = await dialThroughRelay(status.hostId, transport.homeRelay);
      report(dial.ok ? 'pass' : 'fail', dial.ok ? `a fresh endpoint reached the host through the relay in ${dial.ms} ms` : `dialing the host through ${transport.homeRelay} failed: ${dial.reason}`);
    }
  }

  report(serviceEnabled() ? 'pass' : 'warn', serviceEnabled() ? 'DSH host service is installed' : 'no supervised DSH host service found (deployment/install.mjs)');

  const failures = results.filter((r) => r.level === 'fail').length;
  process.stdout.write(failures === 0 ? '\nReady.\n' : `\n${failures} problem(s) to fix.\n`);
  return failures === 0 ? 0 : 1;
}

/** Dial `hostId` knowing only its relay, as a phone with a stale ticket would; then hang up. */
async function dialThroughRelay(hostId: string, relayUrl: string): Promise<{ ok: true; ms: number } | { ok: false; reason: string }> {
  const builder = Endpoint.builder();
  builder.applyMinimal();
  builder.relayMode(RelayMode.customFromUrls([relayUrl]));
  const endpoint = await builder.bind();
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const connection = await Promise.race([
      endpoint.connect(new EndpointAddr(EndpointId.fromString(hostId), relayUrl, []), Array.from(Buffer.from(ALPN, 'utf8'))),
      new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${DIAL_TIMEOUT_MS / 1000} s`)), DIAL_TIMEOUT_MS))),
    ]);
    const ms = Math.round(performance.now() - started);
    connection.close(0n, Array.from(Buffer.from('doctor', 'utf8')));
    return { ok: true, ms };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    await endpoint.close();
  }
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
