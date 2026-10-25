// The relayed path, offline: a local `iroh-relay --dev`, a host homed on it,
// and a phone that knows only the host id and that relay (a stale ticket, off
// the LAN). Opt-in: IROH_RELAY_BIN=/path/to/iroh-relay pnpm test:relay
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import iroh from '@number0/iroh';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryAudit } from '../../src/core/audit.ts';
import { systemClock } from '../../src/core/clock.ts';
import { HostKey } from '../../src/core/host-key.ts';
import { MemoryStore } from '../../src/core/store.ts';
import { RemoteHost } from '../../src/host.ts';
import { FakeAdapter } from '../../src/testing/fake-adapter.ts';
import { dialTicket, type IrohDialer } from '../helpers/iroh.ts';
import { send } from '../helpers/phone.ts';

const relayBin = process.env.IROH_RELAY_BIN;
const { EndpointAddr, EndpointId, EndpointTicket } = iroh;

describe.skipIf(relayBin === undefined)('relayed path through a local iroh-relay', () => {
  let dir: string;
  let relay: ChildProcess;
  let relayUrl: string;
  let host: RemoteHost;
  let dialer: IrohDialer;
  let log = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-remote-relay-'));
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address() as { port: number };
        probe.close(() => resolve(free));
      });
    });
    writeFileSync(join(dir, 'relay.toml'), `http_bind_addr = "127.0.0.1:${port}"\nenable_metrics = false\n`);
    relay = spawn(relayBin!, ['--dev', '--config-path', join(dir, 'relay.toml')], { stdio: ['ignore', 'pipe', 'pipe'] });
    relay.stdout!.on('data', (chunk) => (log += chunk));
    relay.stderr!.on('data', (chunk) => (log += chunk));
    relayUrl = `http://127.0.0.1:${port}/`;
    for (let i = 0; ; i += 1) {
      if (await fetch(`${relayUrl}ping`).then((r) => r.ok, () => false)) break;
      if (i > 100) throw new Error(`iroh-relay did not start:\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const adapter = new FakeAdapter();
    adapter.addSession('session-a', { cwd: '/tmp', title: 'Relayed' });
    host = await RemoteHost.create({
      adapter,
      clock: systemClock,
      hostKey: HostKey.generate(),
      stateStore: new MemoryStore(),
      receiptsStore: new MemoryStore(),
      audit: new MemoryAudit(),
      iroh: { relays: [relayUrl] },
      hostName: 'Relayed host',
      grantTtlMs: 86_400_000,
      remoteApprovalTimeoutMs: 10_000,
    });
    await host.start();
  });

  afterAll(async () => {
    await dialer?.close();
    await host?.stop();
    relay?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('homes the host on the relay', async () => {
    expect(await host.endpoint!.online(10_000)).toBe(true);
    expect(host.endpoint!.homeRelay()).toBe(relayUrl);
    expect(host.address()?.relayUrl).toBe(relayUrl);
  });

  it('reaches the host knowing only its id and relay', async () => {
    const relayOnly = EndpointTicket.fromAddr(new EndpointAddr(EndpointId.fromString(host.hostId), relayUrl, [])).toString();
    const started = performance.now();
    dialer = await dialTicket(relayOnly, { relays: [relayUrl] });
    const connectMs = Math.round(performance.now() - started);
    expect(dialer.connection.remoteId().toString()).toBe(host.hostId);
    // Unpaired, so the API refuses — but it is the plugin answering, through the relay.
    const reply = await send(dialer.port, { method: 'GET', target: '/v1/meta' });
    expect(reply.status).toBe(426);
    expect(reply.headers['x-dsh-request-id']).toMatch(/^trace_/);
    console.log(`relay dial ${connectMs} ms; paths ${JSON.stringify(dialer.connection.paths().map((p) => ({ relay: p.isRelay, selected: p.isSelected })))}`);
  });
});
