#!/usr/bin/env node
// dsh-remote: owner CLI for DSH Remote. Talks to the running DSH host over the
// 0600 admin socket in $DSH_HOME/remote; only `upgrade` contacts the network (GitHub).
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import QRCode from 'qrcode';
import { AdminClient } from '../admin/socket.ts';
import type { DeviceSummary, PairingOffer, PendingPairing } from '../host.ts';
import { stateDir } from '../dsh/plugin.ts';
import { install } from '../install/installer.ts';
import { runDoctor } from './doctor.ts';

const HELP = `Usage: dsh-remote <command>

  status                      host, published sessions, paired phones
  sessions                    DSH sessions and whether each is published
  pair [--session <id>]       show a pairing QR, then approve the phone that scans it
  devices                     paired phones
  revoke <deviceId>           revoke a phone and close its connections
  publish <sessionId>         allow phones to see and control a session
  unpublish <sessionId>       stop remote access to a session (local work continues)
  doctor                      check the host, its state and its reachability without changing anything
  upgrade [version] [--profile web]
                              install the latest (or that) DSH Remote release and dsh-mobile-maxxing,
                              then restart DSH to load it
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(HELP);
    return command === undefined ? 2 : 0;
  }
  if (command === 'doctor') return runDoctor(args);
  if (command === 'upgrade') return upgrade(args);
  const client = await connect();
  try {
    switch (command) {
      case 'status':
        print(await client.call({ method: 'status' }));
        return 0;
      case 'sessions':
        for (const s of await client.call<{ sessionId: string; title: string | null; running: boolean; published: boolean }[]>({ method: 'sessions' })) {
          process.stdout.write(`${s.published ? '●' : '○'} ${s.sessionId}  ${s.running ? '[running] ' : ''}${s.title ?? ''}\n`);
        }
        return 0;
      case 'devices':
        for (const d of await client.call<DeviceSummary[]>({ method: 'devices' })) {
          process.stdout.write(`${d.revoked ? '[revoked] ' : ''}${d.label}  ${d.deviceId}  ${d.platform}  key ${d.shortFingerprint}  peer ${d.peer}\n`);
        }
        return 0;
      case 'revoke': {
        const deviceId = required(args[0], 'deviceId');
        const { revoked } = await client.call<{ revoked: boolean }>({ method: 'revokeDevice', deviceId });
        process.stdout.write(revoked ? `Revoked ${deviceId}.\n` : `No active device ${deviceId}.\n`);
        return revoked ? 0 : 1;
      }
      case 'publish':
      case 'unpublish':
        await client.call({ method: command, sessionId: required(args[0], 'sessionId') });
        process.stdout.write(`${command === 'publish' ? 'Published' : 'Unpublished'} ${args[0]}.\n`);
        return 0;
      case 'pair':
        return await pair(client, flag(args, '--session'));
      default:
        process.stderr.write(`dsh-remote: unknown command ${command}\n\n${HELP}`);
        return 2;
    }
  } finally {
    client.close();
  }
}

async function upgrade(args: string[]): Promise<number> {
  const profile = flag(args, '--profile');
  const version = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--profile');
  try {
    const result = await install({
      ...(version === undefined ? {} : { version: version.replace(/^v/, '') }),
      ...(profile === undefined ? {} : { profile }),
      log: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(`\nDSH Remote ${result.version} is installed. Restart DSH (dsh web) to load it.\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`dsh-remote: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function pair(client: AdminClient, sessionId: string | undefined): Promise<number> {
  const offer = await client.call<PairingOffer>(sessionId === undefined ? { method: 'offerPairing' } : { method: 'offerPairing', sessionId });
  process.stdout.write(`\n${await QRCode.toString(offer.url, { type: 'terminal', small: true })}\n`);
  process.stdout.write(`Scan with DSH Remote → Connect Host. Host ${offer.hostId.slice(0, 10)}\n`);
  process.stdout.write(`Waiting for a phone (code expires at ${new Date(offer.expiresAt).toLocaleTimeString()})…\n`);
  const deadline = offer.expiresAt + 5 * 60_000;
  let request: PendingPairing | undefined;
  while (request === undefined) {
    if (Date.now() > deadline) {
      process.stdout.write('No phone redeemed the code. Run `dsh-remote pair` again.\n');
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    request = (await client.call<PendingPairing[]>({ method: 'pendingPairings' })).find((r) => r.challengeId === offer.challengeId);
  }
  process.stdout.write(
    `\nPairing request\n  Phone            ${request.deviceLabel} (${request.platform}${request.hardwareBacked ? ', hardware key' : ', software key'})\n` +
      `  Key fingerprint  ${request.shortFingerprint}\n  Phone peer id    ${request.peer}\nCompare the fingerprint with the one the phone shows.\n`,
  );
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question('Approve this device? [y/N] ')).trim().toLowerCase();
  prompt.close();
  const approve = answer === 'y' || answer === 'yes';
  const result = await client.call<{ device?: DeviceSummary | null; denied?: boolean }>({ method: 'decidePairing', pairingRequestId: request.pairingRequestId, decision: approve ? 'approve' : 'deny' });
  if (!approve) {
    process.stdout.write('Denied.\n');
    return 1;
  }
  if (result.device === null || result.device === undefined) {
    process.stdout.write('The request expired before it was approved. Run `dsh-remote pair` again.\n');
    return 1;
  }
  process.stdout.write(`Approved ${result.device.label} (${result.device.deviceId}).\n`);
  return 0;
}

async function connect(): Promise<AdminClient> {
  const path = join(stateDir(), 'admin.sock');
  try {
    return await AdminClient.connect(path);
  } catch {
    process.stderr.write(`dsh-remote: cannot reach the DSH host at ${path}\nIs \`dsh web\` running with the DSH Remote plugin? Try \`dsh-remote doctor\`.\n`);
    process.exit(3);
  }
}

function required(value: string | undefined, name: string): string {
  if (value === undefined) {
    process.stderr.write(`dsh-remote: missing ${name}\n`);
    process.exit(2);
  }
  return value;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`dsh-remote: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
