// DEV ONLY. A complete DSH Remote host with no DSH, for building the phone app:
// RemoteHost on FakeAdapter behind a real iroh endpoint, so the app pairs with
// it exactly as with a real host. Key and paired devices persist in --state
// (default .dsh-home/dev-host) so a paired phone survives restarts.
//
//   node --conditions=source scripts/dev-host.ts [--relays default|none|<url>,<url>] [--state <dir>]
//   then: stdin commands `pair`, `y`/`n`, `ask`, `stream`, `local <session>`, `quit`
//
// `--relays none` serves direct addresses only (phone on the same LAN).
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import QRCode from 'qrcode';
import { MemoryAudit } from '../src/core/audit.ts';
import { systemClock } from '../src/core/clock.ts';
import { HostKey } from '../src/core/host-key.ts';
import { shortPeerId } from '../src/core/peer.ts';
import type { ReceiptsDocument } from '../src/core/receipts.ts';
import type { HostStateDocument } from '../src/core/state.ts';
import { ensurePrivateDir, JsonFileStore } from '../src/core/store.ts';
import { DEFAULT_RELAYS } from '../src/dsh/config.ts';
import { RemoteHost } from '../src/host.ts';
import { FakeAdapter } from '../src/testing/fake-adapter.ts';

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const relayOption = option('--relays') ?? 'default';
const relays = relayOption === 'none' ? [] : relayOption === 'default' ? DEFAULT_RELAYS : relayOption.split(',');
const dir = resolve(option('--state') ?? join(import.meta.dirname, '../../../.dsh-home/dev-host'));
ensurePrivateDir(dir);

const adapter = new FakeAdapter();
adapter.autoReply = false;
adapter.addSession('session-dev-1', { cwd: '/home/dev/api', title: 'Refactor the API' });
adapter.addSession('session-dev-2', { cwd: '/home/dev/web', title: 'Fix the flaky test' });
const host = await RemoteHost.create({
  adapter,
  clock: systemClock,
  hostKey: await HostKey.loadOrCreate(join(dir, 'endpoint-key')),
  stateStore: new JsonFileStore<HostStateDocument>(join(dir, 'state.json')),
  receiptsStore: new JsonFileStore<ReceiptsDocument>(join(dir, 'receipts.json')),
  audit: new MemoryAudit(),
  iroh: { relays },
  hostName: 'Dev Host',
  grantTtlMs: 7 * 86_400_000,
  remoteApprovalTimeoutMs: 600_000,
  entry: 'dev',
});
await host.publish('session-dev-1');
await host.publish('session-dev-2');
await host.start();
const online = await host.endpoint!.online(10_000);

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

const status = host.status().transport!;
console.log(`\nDSH Remote dev host (FAKE DSH — never expose this)`);
console.log(`  host id:  ${host.hostId}`);
console.log(`  relay:    ${status.homeRelay ?? (relays.length === 0 ? 'none (direct addresses only)' : online ? 'none yet' : 'not connected')}`);
console.log(`  direct:   ${status.directAddresses.join(', ')}`);
console.log(`  state:    ${dir}\n`);

async function showPairing(): Promise<void> {
  const offer = host.offerPairing('session-dev-1');
  console.log(await QRCode.toString(offer.url, { type: 'terminal', small: true }));
  console.log(offer.url);
}

host.onPairingChange((request) => {
  if (request.state !== 'pending') return;
  console.log(`\nPairing request from peer ${shortPeerId(request.peerId)}: ${request.deviceLabel} (${request.platform}), key ${request.fingerprint.slice(0, 16)}`);
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
process.exit(0);
