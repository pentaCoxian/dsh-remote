// End-to-end against the pinned DSH host: `pnpm test:dsh`.
// Boots `dsh web` (DSH 0.2.1-rc.3) in a throwaway DSH_HOME with the plugin's
// test-harness entry and a scripted model, then drives the phone side through
// the real native API, the real DSH session controller, gateway and approvals.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOSE_CODES, HEADERS, parsePairingUrl } from '@dsh-remote/protocol';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AdminClient } from '../../src/admin/socket.ts';
import type { PairingOffer, PendingPairing } from '../../src/host.ts';
import { send, toBody, TestPhone, type SendOptions } from '../helpers/phone.ts';

const pluginDir = fileURLToPath(new URL('../..', import.meta.url));
const dshBin = join(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js');
const AUD = 'c'.repeat(64);

let home: string;
let apiPort: number;
let dsh: ChildProcess;
let fakeModel: ChildProcess;
let jwksServer: ReturnType<typeof createServer>;
let sign: (sub?: string) => Promise<string>;
let admin: AdminClient;
let sessionId: string;
let phone: TestPhone;
let log = '';

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

const signed = async (options: SendOptions) =>
  send(apiPort, { ...options, headers: { [HEADERS.accessAssertion]: await sign(), ...phone.proofHeaders(options.method, options.target, toBody(options.body)), ...options.headers } });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-remote-itest-'));
  chmodSync(home, 0o700);

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'itest', alg: 'RS256', use: 'sig' };
  jwksServer = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] })));
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const issuer = `http://127.0.0.1:${(jwksServer.address() as { port: number }).port}`;
  sign = (sub = 'itest-user') =>
    new SignJWT({ email: 'owner@example.com', type: 'app' })
      .setProtectedHeader({ alg: 'RS256', kid: 'itest' })
      .setIssuer(issuer)
      .setAudience([AUD])
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);

  const modelPort = await freePort();
  fakeModel = spawn(process.execPath, [join(pluginDir, 'test/integration/fake-llm.mjs'), String(modelPort)], { stdio: 'ignore' });

  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', FAKE_LLM_KEY: 'itest', DSH_REMOTE_TEST_ISSUER: issuer, DSH_REMOTE_TEST_JWKS: `${issuer}/certs`, DSH_REMOTE_TEST_AUD: AUD };
  const add = spawnSync(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', pluginDir], { env, encoding: 'utf8' });
  if (add.status !== 0) throw new Error(`dsh plugin add failed:\n${add.stdout}\n${add.stderr}`);

  apiPort = await freePort();
  const overlay = join(home, 'itest.patch.yml');
  writeFileSync(
    overlay,
    `- id: dsh-remote
  disabled: true
- insert:
    - id: dsh-remote-test-harness
      name: "@dsh-remote/dsh-plugin/testing"
      config:
        publicHost: dsh.example.com
        linkOrigin: https://link.example.com
        hostName: Harness
        port: ${apiPort}
        remoteApprovalTimeoutSec: 60
        access:
          teamName: harness
          audTags: [${AUD}]
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
  dsh?.kill('SIGTERM');
  fakeModel?.kill();
  jwksServer?.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  rmSync(home, { recursive: true, force: true });
});

describe('DSH Remote inside dsh web 0.2.1-rc.3', () => {
  it('pairs a phone: QR challenge, redeem, local approval, host-signed grant', async () => {
    phone = new TestPhone();
    const offer = await admin.call<PairingOffer>({ method: 'offerPairing', sessionId });
    const payload = parsePairingUrl(offer.url)!;
    expect(payload.sessionId).toBe(sessionId);
    const redeem = await signed({ method: 'POST', target: '/v1/pair/redeem', body: { challengeId: payload.challengeId, publicKey: phone.publicKey, deviceLabel: 'Integration Phone', platform: 'android', hardwareBacked: false } });
    expect(redeem.status).toBe(201);
    expect(redeem.json.hostKey.fingerprint).toBe(payload.hostKeyFingerprint);
    const pending = await admin.call<PendingPairing[]>({ method: 'pendingPairings' });
    expect(pending.map((p) => p.challengeId)).toContain(payload.challengeId);
    await admin.call({ method: 'decidePairing', pairingRequestId: redeem.json.pairingRequestId, decision: 'approve' });
    const status = await signed({ method: 'GET', target: `/v1/pair/requests/${redeem.json.pairingRequestId}` });
    expect(status.json.state).toBe('approved');
    phone.deviceId = status.json.grant.deviceId;
  });

  it('shows the existing DSH session with the same id', async () => {
    const list = await signed({ method: 'GET', target: '/v1/sessions' });
    expect(list.json.items.map((s: { sessionId: string }) => s.sessionId)).toEqual([sessionId]);
    const reply = await signed({ method: 'GET', target: `/v1/sessions/${sessionId}` });
    expect(reply.status).toBe(200);
    expect(reply.json.session.sessionId).toBe(sessionId);
  });

  it('runs a phone prompt through DSH, answers its tool approval from the phone, and streams the turn', async () => {
    const before = await signed({ method: 'GET', target: `/v1/sessions/${sessionId}` });
    const ws = new WebSocket(`ws://127.0.0.1:${apiPort}/v1/events`, { headers: { host: 'dsh.example.com', [HEADERS.accessAssertion]: await sign(), ...phone.proofHeaders('GET', '/v1/events', Buffer.alloc(0)) } });
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
  });
});
