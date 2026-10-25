// Phase 0.3 desktop half of the Cloudflare gate (answers C1-C8 from a laptop).
// Walks Managed OAuth discovery, dynamic client registration, PKCE with a
// loopback redirect, a Bearer REST call, a Bearer WebSocket and a refresh.
// Tokens stay in memory; the report records only shapes and status codes.
//
//   node oauth-probe.mjs https://dsh.example.com \
//     [--try-redirect https://link.example.com/oauth/callback] [--try-redirect dshremote://oauth] \
//     [--ws-seconds 30] [--ws-hold-minutes 20]
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const origin = new URL(args[0] ?? usage()).origin;
const tryRedirects = flagValues('--try-redirect');
const wsSeconds = Number(flagValues('--ws-seconds')[0] ?? 30);
const wsHoldMinutes = Number(flagValues('--ws-hold-minutes')[0] ?? 0);
const report = { origin, startedAt: new Date().toISOString(), steps: {} };

function usage() {
  console.error('usage: node oauth-probe.mjs https://<protected-host> [--try-redirect <uri>]... [--ws-seconds N] [--ws-hold-minutes N]');
  process.exit(2);
}

function flagValues(flag) {
  return args.flatMap((arg, i) => (arg === flag && args[i + 1] ? [args[i + 1]] : []));
}

function step(name, value) {
  report.steps[name] = value;
  console.log(`\n[${name}]`, JSON.stringify(value, null, 2));
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function jsonOrText(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text.slice(0, 300); }
}

function redactError(body) {
  return typeof body === 'object' && body !== null ? { error: body.error, error_description: body.error_description } : body;
}

function tokenShape(tokens) {
  return {
    token_type: tokens.token_type,
    expires_in: tokens.expires_in,
    scope: tokens.scope ?? null,
    hasRefreshToken: typeof tokens.refresh_token === 'string',
    accessTokenPrefix: typeof tokens.access_token === 'string' ? tokens.access_token.split(':')[0] : null,
    accessTokenLooksJwt: typeof tokens.access_token === 'string' && tokens.access_token.split('.').length === 3,
  };
}

// C1: an unauthenticated non-browser request should get 401 + WWW-Authenticate.
const unauth = await fetch(`${origin}/gate/hello`, { redirect: 'manual', headers: { accept: 'application/json' } });
const wwwAuthenticate = unauth.headers.get('www-authenticate');
step('C1.unauthenticated', { status: unauth.status, wwwAuthenticate, location: unauth.headers.get('location') });

const resourceMetadataUrl = /resource_metadata="([^"]+)"/.exec(wwwAuthenticate ?? '')?.[1] ?? `${origin}/.well-known/oauth-protected-resource`;
const resourceMeta = await fetch(resourceMetadataUrl).then(async (r) => ({ status: r.status, body: await jsonOrText(r) }));
step('C1.resourceMetadata', { url: resourceMetadataUrl, ...resourceMeta });
const asBase = resourceMeta.body?.authorization_servers?.[0] ?? origin;
const asMetaUrl = `${new URL(asBase).origin}/.well-known/oauth-authorization-server`;
const asMeta = await fetch(asMetaUrl).then(async (r) => ({ status: r.status, body: await jsonOrText(r) }));
step('C1.authorizationServerMetadata', { url: asMetaUrl, status: asMeta.status, body: asMeta.body });
const meta = asMeta.body;
if (typeof meta !== 'object' || !meta.authorization_endpoint) {
  step('ABORT', 'no authorization server metadata; is Managed OAuth enabled on this Access application?');
  finish();
}

async function register(redirectUri) {
  const res = await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'DSH Remote gate probe',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const body = await jsonOrText(res);
  return { status: res.status, clientId: res.ok ? body.client_id : undefined, error: res.ok ? undefined : redactError(body), echoedRedirects: body?.redirect_uris };
}

// C2: which redirect URI kinds dynamic registration accepts.
const c2 = {};
for (const uri of tryRedirects) {
  const result = await register(uri);
  c2[uri] = { status: result.status, accepted: Boolean(result.clientId), error: result.error, echoedRedirects: result.echoedRedirects };
}

// Loopback redirect for the interactive desktop flow.
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const state = b64url(randomBytes(16));
let deliverCallback;
const callbackReceived = new Promise((resolve) => { deliverCallback = resolve; });
const loopback = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/plain' }).end('DSH Remote gate probe: you can close this tab.');
  loopback.close();
  deliverCallback({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), error: url.searchParams.get('error'), errorDescription: url.searchParams.get('error_description') });
});
await new Promise((resolve) => loopback.listen(0, '127.0.0.1', resolve));
const redirectUri = `http://127.0.0.1:${loopback.address().port}/callback`;
const registration = await register(redirectUri);
c2[redirectUri] = { status: registration.status, accepted: Boolean(registration.clientId), error: registration.error };
step('C2.registration', c2);
if (!registration.clientId) {
  step('ABORT', 'loopback registration rejected; enable "allow any on loopback" for the desktop probe');
  finish();
}
const clientId = registration.clientId;
const authUrl = new URL(meta.authorization_endpoint);
authUrl.search = new URLSearchParams({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: redirectUri,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state,
  resource: origin,
}).toString();
console.log(`\nOpening the system browser for Access sign-in:\n${authUrl}\n`);
execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [authUrl.toString()], () => {});
const callback = await callbackReceived;
step('C3.authorizationResponse', { hasCode: Boolean(callback.code), stateMatches: callback.state === state, error: callback.error, errorDescription: callback.errorDescription });
if (!callback.code || callback.state !== state) finish();

async function tokenRequest(params) {
  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: await jsonOrText(res) };
}

const exchange = await tokenRequest({ grant_type: 'authorization_code', code: callback.code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: origin });
step('C3/C5.tokenExchange', { status: exchange.status, shape: exchange.status === 200 ? tokenShape(exchange.body) : redactError(exchange.body) });
if (exchange.status !== 200) finish();
let tokens = exchange.body;

// C4: header the edge accepts, and C7: what the origin sees.
for (const variant of [
  { name: 'authorization-bearer', headers: { authorization: `Bearer ${tokens.access_token}` } },
  { name: 'cf-access-token', headers: { 'cf-access-token': tokens.access_token } },
]) {
  const res = await fetch(`${origin}/gate/hello`, { redirect: 'manual', headers: { accept: 'application/json', ...variant.headers } });
  step(`C4/C7.rest.${variant.name}`, { status: res.status, body: await jsonOrText(res) });
}

// C6/C8: WebSocket upgrade with the Bearer header.
async function holdSocket(label, seconds, idle) {
  return new Promise((resolve) => {
    const started = Date.now();
    const frames = [];
    const ws = new WebSocket(`${origin.replace('https:', 'wss:')}/gate/ws${idle ? '?idle=1' : ''}`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    const done = (outcome) => resolve({ label, ...outcome, openSec: Math.round((Date.now() - started) / 1000), frames: frames.slice(0, 3) });
    const timer = setTimeout(() => ws.close(1000, 'probe done'), seconds * 1000);
    ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); done({ opened: false, status: res.statusCode }); });
    ws.on('open', () => frames.push('open'));
    ws.on('message', (data) => frames.push(JSON.parse(data.toString()).type));
    ws.on('close', (code, reason) => { clearTimeout(timer); done({ opened: frames.includes('open'), closeCode: code, closeReason: reason.toString() }); });
    ws.on('error', (error) => frames.push(`error:${error.code ?? error.message}`));
  });
}
step('C6.websocket', await holdSocket('bearer-upgrade', wsSeconds, false));

// C5: refresh and rotation.
const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId, resource: origin });
const rotated = refreshed.status === 200 && refreshed.body.refresh_token !== undefined && refreshed.body.refresh_token !== tokens.refresh_token;
const reuseOld = rotated ? await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId, resource: origin }) : undefined;
step('C5.refresh', { status: refreshed.status, shape: refreshed.status === 200 ? tokenShape(refreshed.body) : redactError(refreshed.body), refreshTokenRotated: rotated, oldRefreshReuseStatus: reuseOld?.status });
if (refreshed.status === 200) tokens = { ...tokens, ...refreshed.body };

// C8: hold a socket past the access-token lifetime (and an idle one) to see who closes it.
if (wsHoldMinutes > 0) {
  console.log(`\nHolding sockets for ${wsHoldMinutes} minutes...`);
  const [busy, idle] = await Promise.all([holdSocket('hold-heartbeat', wsHoldMinutes * 60, false), holdSocket('hold-idle', wsHoldMinutes * 60, true)]);
  step('C8.hold', { busy, idle });
}
finish();

function finish() {
  report.finishedAt = new Date().toISOString();
  writeFileSync('gate-probe.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log('\nwrote gate-probe.json (redacted; no tokens)');
  process.exit(0);
}
