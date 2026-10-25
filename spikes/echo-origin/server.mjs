// Phase 0.3 gate origin. Stands in for the plugin on 127.0.0.1:4318 behind
// cloudflared: verifies Cf-Access-Jwt-Assertion, reports claim *shapes* (never
// token or identity values) and holds WebSockets open to observe the edge.
//   CF_TEAM_DOMAIN=<team>.cloudflareaccess.com CF_AUD=<aud tag> node server.mjs
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { WebSocketServer } from 'ws';

const TEAM = required('CF_TEAM_DOMAIN');
const AUD = required('CF_AUD');
const LOG = process.env.GATE_LOG ?? 'gate-origin.jsonl';
// CF_ISSUER only exists for the local smoke test; leave it unset behind Cloudflare.
const issuer = process.env.CF_ISSUER ?? `https://${TEAM}`;
const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return value;
}

function record(kind, data) {
  const line = JSON.stringify({ at: new Date().toISOString(), kind, ...data });
  console.log(line);
  appendFileSync(LOG, `${line}\n`);
}

function summarize(payload) {
  const now = Math.floor(Date.now() / 1000);
  return {
    claimNames: Object.keys(payload).sort(),
    type: payload.type ?? null,
    subPresent: typeof payload.sub === 'string' && payload.sub.length > 0,
    emailDomain: typeof payload.email === 'string' ? payload.email.split('@')[1] : null,
    commonNamePresent: 'common_name' in payload,
    lifetimeSec: payload.exp - payload.iat,
    expiresInSec: payload.exp - now,
  };
}

function requestShape(req) {
  const auth = req.headers.authorization;
  return {
    headerNames: Object.keys(req.headers).sort(),
    authScheme: typeof auth === 'string' ? auth.split(' ')[0] : null,
    cookieNames: (req.headers.cookie ?? '').split(';').map((c) => c.split('=')[0].trim()).filter(Boolean),
  };
}

async function verify(req) {
  const token = req.headers['cf-access-jwt-assertion'];
  if (typeof token !== 'string') return { ok: false, reason: 'missing-assertion' };
  try {
    const { payload, protectedHeader } = await jwtVerify(token, jwks, { issuer, audience: AUD, algorithms: ['RS256'] });
    return { ok: true, claims: summarize(payload), kid: protectedHeader.kid ?? null, exp: payload.exp };
  } catch (error) {
    return { ok: false, reason: error.code ?? error.name };
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://origin.invalid');
  const auth = await verify(req);
  record('http', { method: req.method, path: url.pathname, verified: auth.ok, reason: auth.reason, claims: auth.claims, request: requestShape(req) });
  if (url.pathname !== '/gate/hello') {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
    return;
  }
  if (!auth.ok) {
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ verified: false, reason: auth.reason }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ verified: true, claims: auth.claims, kid: auth.kid }));
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://origin.invalid');
  const auth = await verify(req);
  record('upgrade', { path: url.pathname, verified: auth.ok, reason: auth.reason, claims: auth.claims, request: requestShape(req) });
  if (url.pathname !== '/gate/ws' || !auth.ok) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const openedAt = Date.now();
    const idle = url.searchParams.get('idle') === '1';
    let beats = 0;
    const timer = idle ? undefined : setInterval(() => ws.send(JSON.stringify({ type: 'heartbeat', n: ++beats, openSec: Math.round((Date.now() - openedAt) / 1000) })), 25_000);
    ws.send(JSON.stringify({ type: 'hello', claims: auth.claims, idle }));
    ws.on('message', (data) => ws.send(JSON.stringify({ type: 'echo', bytes: data.length })));
    ws.on('close', (code, reason) => {
      clearInterval(timer);
      const openSec = Math.round((Date.now() - openedAt) / 1000);
      record('ws-close', { code, reason: reason.toString(), openSec, idle, pastAssertionExp: Date.now() / 1000 > auth.exp });
    });
  });
});

server.listen(4318, '127.0.0.1', () => record('listening', { address: '127.0.0.1:4318', issuer, audience: 'configured' }));
