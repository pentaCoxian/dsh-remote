// End-to-end against the pinned DSH host: `pnpm test:dsh`.
// Boots `dsh web` (DSH 0.2.1-rc.3) in a throwaway DSH_HOME with the plugin's
// test-harness entry and a scripted model, then drives the phone side over a
// real iroh connection (relays off) dialed from the pairing QR's ticket, through
// the real native API, DSH session controller, gateway and approvals.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IrohHttpClient } from '@dsh-remote/iroh-http';
import { CLOSE_CODES, openPush, parsePairingUrl, PUSH_ALPN, WEB_ALPN } from '@dsh-remote/protocol';
import { Gateway, GatewayTransport, HandleStore, type OutboundPush, type Sender } from '@dsh-remote/push-gateway';
import iroh from '@number0/iroh';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AdminClient } from '../../src/admin/socket.ts';
import type { HostStatus, PairingOffer, PendingPairing } from '../../src/host.ts';
import { dialTicket, type IrohDialer } from '../helpers/iroh.ts';
import { send, toBody, TestPhone, type SendOptions } from '../helpers/phone.ts';

const pluginDir = fileURLToPath(new URL('../..', import.meta.url));
const dshBin = join(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js');

let home: string;
let dsh: ChildProcess;
let fakeModel: ChildProcess;
let dialer: IrohDialer;
let tunnel: IrohDialer | undefined;
let admin: AdminClient;
let sessionId: string;
let phone: TestPhone;
let log = '';
/** A push gateway in this process; its FCM sender records instead of sending. */
let gateway: GatewayTransport;
let gatewayStore: HandleStore;
const pushed: OutboundPush[] = [];
const recorder: Sender = { send: async (push) => (pushed.push(push), { ok: true }), close: () => {} };

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until<T>(probe: () => T | undefined, what: string, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n--- dsh web log ---\n${log.slice(-4000)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const signed = async (options: SendOptions) => send(dialer.port, { ...options, headers: { ...phone.proofHeaders(options.method, options.target, toBody(options.body)), ...options.headers } });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-remote-itest-'));
  chmodSync(home, 0o700);

  const modelPort = await freePort();
  fakeModel = spawn(process.execPath, [join(pluginDir, 'test/integration/fake-llm.mjs'), String(modelPort)], { stdio: 'ignore' });

  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', FAKE_LLM_KEY: 'itest' };
  const add = spawnSync(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', pluginDir], { env, encoding: 'utf8' });
  if (add.status !== 0) throw new Error(`dsh plugin add failed:\n${add.stdout}\n${add.stderr}`);

  gatewayStore = HandleStore.open(':memory:');
  const app = new Gateway({ store: gatewayStore, senders: { fcm: recorder } });
  gateway = await GatewayTransport.start({ secretKey: iroh.SecretKey.generate().toBytes(), relays: [], onStream: (stream, peerId) => app.accept(stream, peerId) });

  const overlay = join(home, 'itest.patch.yml');
  writeFileSync(
    overlay,
    `- id: dsh-remote
  disabled: true
- insert:
    - id: dsh-remote-test-harness
      name: "@dsh-remote/dsh-plugin/testing"
      config:
        hostName: Harness
        relays: []
        remoteApprovalTimeoutSec: 60
        pushGateway: ${gateway.ticket()}
- id: llm-pi-ai
  config:
    providers:
      fake:
        displayName: DSH Remote fake model
        apiKeyEnv: FAKE_LLM_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:${modelPort}/v1
        models:
          - id: fake-model
            name: Fake model
            contextWindow: 128000
            maxTokens: 4096
- id: agent-default-model
  config:
    provider: fake
    model: fake-model
`,
  );
  dsh = spawn(process.execPath, [dshBin, 'web', '--patch', overlay, '--host', '127.0.0.1', '--port', String(await freePort()), '--no-open'], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
  dsh.stdout!.on('data', (chunk) => (log += chunk));
  dsh.stderr!.on('data', (chunk) => (log += chunk));

  const sessionFile = join(home, 'remote', 'harness-session');
  sessionId = await until(() => (existsSync(sessionFile) ? readFileSync(sessionFile, 'utf8') : undefined), 'the seeded session');
  admin = await AdminClient.connect(join(home, 'remote', 'admin.sock'));
});

afterAll(async () => {
  admin?.close();
  await dialer?.close();
  await tunnel?.close();
  dsh?.kill('SIGTERM');
  fakeModel?.kill();
  await gateway?.close();
  gatewayStore?.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  rmSync(home, { recursive: true, force: true });
});

describe('DSH Remote inside dsh web 0.2.1-rc.3', () => {
  it('runs the production transport: an iroh endpoint and no TCP listener', async () => {
    const status = await admin.call<HostStatus>({ method: 'status' });
    expect(status.entry).toBe('test-harness');
    expect(status.loopbackPort).toBeNull();
    expect(status.transport).toMatchObject({ relays: [], homeRelay: null });
  });

  it('pairs a phone: QR ticket, iroh dial, redeem, local approval, grant', async () => {
    phone = new TestPhone();
    const offer = await admin.call<PairingOffer>({ method: 'offerPairing', sessionId });
    const payload = parsePairingUrl(offer.url)!;
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.hostName).toBe('Harness');
    dialer = await dialTicket(payload.ticket);
    expect(dialer.connection.remoteId().toString()).toBe(offer.hostId);
    const redeem = await signed({ method: 'POST', target: '/v1/pair/redeem', body: { challengeId: payload.challengeId, publicKey: phone.publicKey, deviceLabel: 'Integration Phone', platform: 'android', hardwareBacked: false } });
    expect(redeem.status).toBe(201);
    const pending = await admin.call<PendingPairing[]>({ method: 'pendingPairings' });
    expect(pending.map((p) => p.challengeId)).toContain(payload.challengeId);
    await admin.call({ method: 'decidePairing', pairingRequestId: redeem.json.pairingRequestId, decision: 'approve' });
    const status = await signed({ method: 'GET', target: `/v1/pair/requests/${redeem.json.pairingRequestId}` });
    expect(status.json.state).toBe('approved');
    expect(status.json.grant.hostId).toBe(offer.hostId);
    phone.deviceId = status.json.grant.deviceId;
  });

  it('shows the existing DSH session with the same id', async () => {
    const list = await signed({ method: 'GET', target: '/v1/sessions' });
    expect(list.json.items.map((s: { sessionId: string }) => s.sessionId)).toEqual([sessionId]);
    const reply = await signed({ method: 'GET', target: `/v1/sessions/${sessionId}` });
    expect(reply.status).toBe(200);
    expect(reply.json.session.sessionId).toBe(sessionId);
  });

  it('notifies an away phone from DSH’s own event feed: the approval, then the finished turn', async () => {
    const status = await signed({ method: 'GET', target: '/v1/push' });
    expect(status.json).toMatchObject({ gateway: gateway.ticket(), registered: false });
    const toGateway = new IrohHttpClient(dialer.endpoint, () => iroh.EndpointTicket.fromString(status.json.gateway).endpointAddr(), PUSH_ALPN);
    const hostId = dialer.connection.remoteId().toString();
    const { handle } = (await toGateway.request('POST', '/v1/handles', { platform: 'fcm', token: 'fcm-token-itest', host: hostId })).body as { handle: string };
    toGateway.close();
    const key = randomBytes(32);
    const events = { approval: true, turnFinished: true, turnFailed: false };
    expect((await signed({ method: 'PUT', target: '/v1/push', body: { gateway: gateway.endpointId, handle, key: key.toString('base64url'), platform: 'fcm', events } })).status).toBe(200);
    const read = (push: OutboundPush) => openPush(key, hostId, handle, push.envelope)!;

    const prompt = await signed({ method: 'POST', target: `/v1/sessions/${sessionId}/prompts`, body: { clientRequestId: 'req_itest_push', text: 'please-use-a-tool' } });
    expect(prompt.status).toBe(202);
    const approval = await until(() => pushed.find((push) => read(push).kind === 'approval'), 'an approval notification');
    expect(approval.urgency).toBe('high');
    expect(read(approval)).toMatchObject({ hostId, hostName: 'Harness', sessionId, body: 'Approval needed: glob\nharness: glob needs approval' });

    let asked: { approvalId: string; revision: number } | undefined;
    for (let i = 0; i < 50 && asked === undefined; i += 1) {
      const approvals = await signed({ method: 'GET', target: '/v1/approvals' });
      asked = approvals.json.items.find((item: { sessionId: string; state: string }) => item.sessionId === sessionId && item.state === 'pending');
      if (asked === undefined) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (asked === undefined) throw new Error('no pending approval listed');
    expect((await signed({ method: 'POST', target: `/v1/approvals/${asked.approvalId}/responses`, body: { decision: 'allow_once', expectedRevision: asked.revision } })).status).toBe(200);
    const finished = await until(() => pushed.find((push) => read(push).kind === 'turn.finished'), 'a turn-finished notification');
    expect(read(finished)).toMatchObject({ sessionId, body: 'Tool finished; all done.' });
    expect(pushed).toHaveLength(2);
  });

  it('tunnels the real DSH Web: DSH’s own fence and owner login accept the phone-side origin', async () => {
    const session = await signed({ method: 'POST', target: '/v1/web/session' });
    expect(session.status).toBe(200);
    expect(session.json.tokenQuery).toMatch(/^token=[A-Za-z0-9_-]+$/);
    const status = await admin.call<HostStatus>({ method: 'status' });
    expect(status.web).toBe('ready');

    tunnel = await dialTicket(parsePairingUrl((await admin.call<PairingOffer>({ method: 'offerPairing' })).url)!.ticket, { secretKey: dialer.secretKey, alpn: WEB_ALPN });
    const browse = (target: string, cookie?: string) =>
      send(tunnel!.port, { method: 'GET', target, host: `127.0.0.1:${tunnel!.port}`, headers: { origin: `http://127.0.0.1:${tunnel!.port}`, ...(cookie === undefined ? {} : { cookie }) } });
    expect((await browse('/')).status).toBe(401);
    const login = await browse(`/?${session.json.tokenQuery}`);
    expect(login.status).toBe(303);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect(cookie).toMatch(/^dsh-auth-/);
    const index = await browse('/', cookie);
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toMatch(/text\/html/);
  });

  it('runs a phone prompt through DSH, answers its tool approval from the phone, and streams the turn', async () => {
    const before = await signed({ method: 'GET', target: `/v1/sessions/${sessionId}` });
    const ws = new WebSocket(`ws://127.0.0.1:${dialer.port}/v1/events`, { headers: phone.proofHeaders('GET', '/v1/events', Buffer.alloc(0)) });
    const frames: any[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(data.toString('utf8'))));
    await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)));
    ws.send(JSON.stringify({ op: 'subscribe', sessionId, after: before.json.cursor }));
    await until(() => frames.find((f) => f.kind === 'subscribed'), 'subscribed');

    const prompt = await signed({ method: 'POST', target: `/v1/sessions/${sessionId}/prompts`, body: { clientRequestId: 'req_itest_tool', text: 'please-use-a-tool' } });
    expect(prompt.status).toBe(202);

    const asked = await until(() => frames.find((f) => f.kind === 'approvals.changed' && f.payload.approval.state === 'pending'), 'a pending approval');
    expect(asked.payload.approval).toMatchObject({ sessionId, toolName: 'glob', revision: 1 });
    expect(asked.payload.approval.approvalId).toMatch(/^apr_[0-9a-f-]{36}$/);
    const allow = await signed({ method: 'POST', target: `/v1/approvals/${asked.payload.approval.approvalId}/responses`, body: { decision: 'allow_once', expectedRevision: 1 } });
    expect(allow.status).toBe(200);

    await until(() => frames.find((f) => f.kind === 'turn.finished'), 'the turn to finish');
    const kinds = frames.filter((f) => f.type === 'session.event' && !f.ephemeral).map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(['turn.started', 'user.message', 'tool.started', 'approval.requested', 'approval.resolved', 'tool.finished', 'assistant.message', 'turn.finished']));
    const user = frames.find((f) => f.kind === 'user.message');
    expect(user.payload).toMatchObject({ text: 'please-use-a-tool', origin: 'remote', deviceId: phone.deviceId, requestId: prompt.json.turnId });
    expect(frames.find((f) => f.kind === 'approval.resolved').payload.outcome).toBe('allowed_once');
    expect(frames.filter((f) => f.kind === 'assistant.message').map((f) => f.payload.text)).toContain('Tool finished; all done.');

    // The phone has DSH Web open (the tunnel from the previous test), so nothing was pushed.
    expect(pushed).toHaveLength(2);

    const final = await signed({ method: 'GET', target: `/v1/sessions/${sessionId}/prompts/req_itest_tool` });
    expect(['started', 'finished']).toContain(final.json.state);

    const turnsBefore = frames.filter((f) => f.kind === 'turn.started').length;
    const retry = await signed({ method: 'POST', target: `/v1/sessions/${sessionId}/prompts`, body: { clientRequestId: 'req_itest_tool', text: 'please-use-a-tool' } });
    expect(retry.status).toBe(200);
    expect(retry.json.turnId).toBe(prompt.json.turnId);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(frames.filter((f) => f.kind === 'turn.started').length).toBe(turnsBefore);

    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    await admin.call({ method: 'revokeDevice', deviceId: phone.deviceId });
    expect(await closed).toBe(CLOSE_CODES.deviceRevoked);
    expect((await signed({ method: 'GET', target: '/v1/sessions' })).json.error.code).toBe('DEVICE_REVOKED');
    expect(await dialer.connection.closed()).toContain('revoked');
  });
});
