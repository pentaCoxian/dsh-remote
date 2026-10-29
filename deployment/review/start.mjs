// The review host: the scripted model, DSH Web with DSH Remote, and the pairing
// page. A phone that scans a code from the page is approved at once; requests
// for codes the page did not issue are left alone. The page lives under a
// secret path (REVIEW_TOKEN), given to App Review in the review notes only.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const QRCode = createRequire(import.meta.url)('qrcode');
const here = import.meta.dirname;
const home = process.env.DSH_HOME;
if (!home) throw new Error('DSH_HOME is not set');
const token = process.env.REVIEW_TOKEN || randomBytes(18).toString('base64url');
if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) throw new Error('REVIEW_TOKEN must be 16 or more URL-safe characters');
const pagePort = Number(process.env.REVIEW_PAGE_PORT ?? 8080);
const hostName = process.env.REVIEW_HOST_NAME ?? 'DSH Remote review host';
const modelPort = 4398;
const log = (line) => console.log(`[review] ${line}`);

// Any child that stops takes the container down, and its restart policy brings it back.
const children = [];
function run(name, command, args, env = process.env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code, signal) => {
    log(`${name} stopped (${code ?? signal})`);
    stop(1);
  });
  children.push(child);
}
function stop(code) {
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3000).unref();
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));

run('model', process.execPath, [join(here, 'model.mjs'), String(modelPort)]);
const patch = join(home, 'review.patch.yml');
writeFileSync(
  patch,
  `- id: dsh-remote
  config:
    hostName: ${JSON.stringify(hostName)}
- id: llm-pi-ai
  config:
    providers:
      review:
        displayName: Scripted model
        apiKeyEnv: REVIEW_MODEL_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:${modelPort}/v1
        models:
          - id: scripted
            name: Scripted model
            contextWindow: 128000
            maxTokens: 4096
- id: agent-default-model
  config:
    provider: review
    model: scripted
`,
);
run('dsh web', 'dsh', ['web', '--patch', patch, '--host', '127.0.0.1', '--port', '3080', '--no-open'], { ...process.env, DSH_TELEMETRY_DISABLED: '1', REVIEW_MODEL_KEY: 'review' });

/** One request on DSH Remote's admin socket (newline-delimited JSON). */
function admin(request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(home, 'remote', 'admin.sock'));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(10_000, () => socket.destroy(new Error('admin socket timed out')));
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 1, ...request })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const reply = JSON.parse(buffer.slice(0, newline));
      socket.end();
      if (reply.ok) resolve(reply.result);
      else reject(new Error(reply.error));
    });
    socket.on('error', reject);
  });
}

// Challenges this page handed out, until they expire.
const issued = new Map();
setInterval(async () => {
  const now = Date.now();
  for (const [challengeId, expiresAt] of issued) if (expiresAt < now) issued.delete(challengeId);
  const pending = await admin({ method: 'pendingPairings' }).catch(() => []);
  for (const request of pending) {
    if (!issued.has(request.challengeId)) continue;
    issued.delete(request.challengeId);
    await admin({ method: 'decidePairing', pairingRequestId: request.pairingRequestId, decision: 'approve' }).then(
      () => log(`approved ${request.deviceLabel} (${request.platform}, key ${request.shortFingerprint})`),
      (error) => log(`could not approve ${request.pairingRequestId}: ${error.message}`),
    );
  }
}, 1000).unref();

// At most one code every 2 s: the page refreshes well within a code's lifetime.
let lastOffer = { at: 0, body: undefined };
async function offer() {
  if (Date.now() - lastOffer.at < 2000 && lastOffer.body !== undefined) return lastOffer.body;
  const pairing = await admin({ method: 'offerPairing' });
  issued.set(pairing.challengeId, pairing.expiresAt);
  const svg = await QRCode.toString(pairing.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  lastOffer = { at: Date.now(), body: JSON.stringify({ url: pairing.url, expiresAt: pairing.expiresAt, svg }) };
  return lastOffer.body;
}

const page = readFileSync(join(here, 'page.html'), 'utf8');
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff' };
createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://review').pathname;
  if (req.method === 'GET' && (path === `/${token}` || path === `/${token}/`)) {
    res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'" });
    res.end(page);
  } else if (req.method === 'GET' && path === `/${token}/offer`) {
    try {
      const body = await offer();
      res.writeHead(200, { ...headers, 'content-type': 'application/json' });
      res.end(body);
    } catch (error) {
      log(`no pairing code: ${error.message}`);
      res.writeHead(503, { ...headers, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'The host is starting; try again in a few seconds.' }));
    }
  } else {
    res.writeHead(404, headers).end();
  }
}).listen(pagePort, '0.0.0.0', () => {
  log(`pairing page on port ${pagePort} at /${process.env.REVIEW_TOKEN ? '<REVIEW_TOKEN>' : token}/`);
  if (!existsSync(join(home, 'remote'))) log('DSH Remote has not started yet; the page answers once it has');
});
