// The relayed path: a host homed on one relay, and a phone that knows only the
// host id and that relay (a stale ticket, off the LAN). Opt-in:
//   IROH_RELAY_BIN=/path/to/iroh-relay pnpm test:relay      local `iroh-relay --dev`, offline
//   IROH_RELAY_URL=https://nrt1.relay…/ pnpm test:relay     a deployed relay
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
const remoteRelay = process.env.IROH_RELAY_URL;
/** Private, loopback, CGNAT/Tailscale, ULA and link-local ranges: anything else was learned from outside. */
const PRIVATE_ADDRESS = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[f[cd]|\[fe80)/;
const isPublic = (address: string) => !PRIVATE_ADDRESS.test(address);
const { EndpointAddr, EndpointId, EndpointTicket } = iroh;

describe.skipIf(relayBin === undefined && remoteRelay === undefined)(`relayed path through ${remoteRelay ?? 'a local iroh-relay'}`, () => {
  let dir: string;
  let relay: ChildProcess;
  let relayUrl: string;
  let host: RemoteHost;
  let dialer: IrohDialer;
  let log = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-remote-relay-'));
    if (remoteRelay !== undefined) {
      relayUrl = remoteRelay;
    } else {
      await startLocalRelay();
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

  async function startLocalRelay(): Promise<void> {
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
  }

  afterAll(async () => {
    await dialer?.close();
    await host?.stop();
    relay?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('homes the host on the relay', async () => {
    expect(await host.endpoint!.online(10_000)).toBe(true);
    expect(host.endpoint!.homeRelay()).toBe(new URL(relayUrl).href);
    expect(host.address()?.relayUrl).toBe(new URL(relayUrl).href);
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
    console.log(`relay dial ${connectMs} ms; paths ${JSON.stringify(dialer.connection.paths().map((p) => ({ relay: p.isRelay, selected: p.isSelected, rttMs: p.rttMs })))}`);
  });

  it.skipIf(remoteRelay === undefined)('learns its public address through QUIC address discovery on the relay', async () => {
    // Only the relay's QUIC endpoint (udp/7842) can tell the host its NAT-mapped address.
    const deadline = Date.now() + 10_000;
    let addresses: readonly string[] = [];
    while (Date.now() < deadline) {
      addresses = host.endpoint!.status().directAddresses;
      if (addresses.some(isPublic)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    console.log(`direct addresses: ${addresses.join(', ')}`);
    expect(addresses.some(isPublic)).toBe(true);
  });
});
