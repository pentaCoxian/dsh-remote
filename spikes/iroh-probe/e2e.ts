// Spike: the full DSH Remote flow (pair, list, stream, prompt) through iroh.
//   node --conditions=source spikes/iroh-probe/e2e.ts [--no-relay]
// Host: RemoteHost on FakeAdapter (the same stack the plugin tests use) behind
// an iroh endpoint. Client: a TestPhone whose TCP goes through an iroh
// connection dialed by the host's EndpointId only.
import { HEADERS, parsePairingUrl } from '@dsh-remote/protocol';
import WebSocket from 'ws';
import { startLiveHost } from '../../packages/dsh-plugin/test/helpers/live.ts';
import { send, toBody, TestPhone } from '../../packages/dsh-plugin/test/helpers/phone.ts';
import { newSecretKey, startClient, startHost } from './bridge.mjs';

const relay = !process.argv.includes('--no-relay');
const report: Record<string, unknown> = { relay };
const ms = (start: number) => Math.round(performance.now() - start);

const live = await startLiveHost();
let t = performance.now();
const host = await startHost({ targetPort: live.port, secretKey: newSecretKey(), relay });
if (relay) await host.online();
const hostId = host.id().toString();
report.hostOnlineMs = ms(t);
report.hostId = `${hostId.slice(0, 12)}…`;

// Relays on: dial by key alone (address lookup). Relays off: nothing is published, so pass the full address.
const client = await startClient(relay ? { hostId, relay } : { hostId, addr: host.addr(), relay });
report.dialByIdMs = client.connectMs;
report.remoteIdVerified = client.connection.remoteId().toString() === hostId;

const phone = new TestPhone();
const signed = async (options: { method: string; target: string; body?: object }) =>
  send(client.port, { ...options, headers: { [HEADERS.accessAssertion]: await live.issuer.assertion(), ...phone.proofHeaders(options.method, options.target, toBody(options.body)) } });

t = performance.now();
const payload = parsePairingUrl(live.host.offerPairing('session-a').url)!;
const redeem = await signed({ method: 'POST', target: '/v1/pair/redeem', body: { challengeId: payload.challengeId, publicKey: phone.publicKey, deviceLabel: 'iroh phone', platform: 'ios', hardwareBacked: false } });
await live.host.approvePairing(redeem.json.pairingRequestId);
const status = await signed({ method: 'GET', target: `/v1/pair/requests/${redeem.json.pairingRequestId}` });
phone.deviceId = status.json.grant.deviceId;
report.pairMs = ms(t);
report.pairState = status.json.state;

t = performance.now();
const sessions = await signed({ method: 'GET', target: '/v1/sessions' });
report.sessionsMs = ms(t);
report.sessions = sessions.json.items.map((s: { sessionId: string }) => s.sessionId);

const snapshot = await signed({ method: 'GET', target: '/v1/sessions/session-a' });
const frames: any[] = [];
const ws = new WebSocket(`ws://127.0.0.1:${client.port}/v1/events`, {
  headers: { host: 'dsh.example.com', [HEADERS.accessAssertion]: await live.issuer.assertion(), ...phone.proofHeaders('GET', '/v1/events', Buffer.alloc(0)) },
});
ws.on('message', (data) => frames.push(JSON.parse(data.toString('utf8'))));
await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)));
ws.send(JSON.stringify({ op: 'subscribe', sessionId: 'session-a', after: snapshot.json.cursor }));
const waitFor = async (predicate: (f: any) => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!frames.some(predicate)) {
    if (Date.now() > deadline) throw new Error(`timeout; frames: ${frames.map((f) => f.kind)}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
await waitFor((f) => f.kind === 'subscribed');

t = performance.now();
const prompt = await signed({ method: 'POST', target: '/v1/sessions/session-a/prompts', body: { clientRequestId: 'req_iroh_01', text: 'hello over iroh' } });
report.promptAcceptedMs = ms(t);
await waitFor((f) => f.kind === 'turn.finished');
report.promptToTurnFinishedMs = ms(t);
report.events = frames.filter((f) => f.type === 'session.event').map((f) => f.kind);
report.promptStatus = prompt.status;

const rtts: number[] = [];
for (let i = 0; i < 10; i += 1) {
  const start = performance.now();
  await signed({ method: 'GET', target: '/v1/meta' });
  rtts.push(performance.now() - start);
}
rtts.sort((a, b) => a - b);
report.metaRoundTripMs = { p50: Math.round(rtts[4]!), max: Math.round(rtts[9]!) };
report.paths = client.connection.paths().map((p: { isSelected: boolean; isRelay: boolean; rttMs: number }) => ({ selected: p.isSelected, relay: p.isRelay, rttMs: p.rttMs }));

ws.close();
console.log(JSON.stringify(report, null, 2));
await client.close();
await client.endpoint.close();
await host.close();
await live.close();
process.exit(0);
