// node --test deployment/test/
// Runs deployment/provision.mjs against an in-memory fake of the Cloudflare API.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'provision.mjs');
const TOKEN = 'test-token-must-never-be-printed';
const ACCOUNT = 'acct0123456789';

let server;
let base;
let state;
let writes;
let dir;
let envFile;

function freshState() {
  return {
    zones: [{ id: 'zone1', name: 'example.com', account: { id: ACCOUNT, name: 'Home' } }],
    organization: { auth_domain: 'myteam.cloudflareaccess.com' },
    policies: [],
    apps: [],
    tunnels: [],
    dns: [],
    secrets: {},
    seq: 0,
  };
}

const id = (prefix) => `${prefix}${String(++state.seq).padStart(4, '0')}`;
const uuid = () => `00000000-0000-4000-8000-${String(++state.seq).padStart(12, '0')}`;

function reply(res, result, info) {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) }));
}

function page(res, items, url) {
  const p = Number(url.searchParams.get('page') ?? 1);
  const per = Number(url.searchParams.get('per_page') ?? 50);
  reply(res, items.slice((p - 1) * per, p * per), { page: p, per_page: per, count: items.length, total_count: items.length, total_pages: Math.max(1, Math.ceil(items.length / per)) });
}

function handle(req, res, body) {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'auth' }] }));
  const url = new URL(req.url, 'http://fake');
  const path = url.pathname.replace(/^\/client\/v4/, '');
  const key = `${req.method} ${path}`;
  if (req.method !== 'GET') writes.push({ key, body });
  const acct = `/accounts/${ACCOUNT}`;
  let m;
  if (key === 'GET /zones') return reply(res, state.zones.filter((z) => z.name === url.searchParams.get('name')));
  if (key === `GET ${acct}/access/organizations`) return reply(res, state.organization);
  if (key === `GET ${acct}/access/policies`) return page(res, state.policies, url);
  if (key === `POST ${acct}/access/policies`) {
    const policy = { ...body, id: uuid(), created_at: 'now', reusable: true };
    state.policies.push(policy);
    return reply(res, policy);
  }
  if ((m = new RegExp(`^PUT ${acct}/access/policies/(.+)$`).exec(key))) {
    const i = state.policies.findIndex((p) => p.id === m[1]);
    state.policies[i] = { ...body, id: m[1] };
    return reply(res, state.policies[i]);
  }
  if (key === `GET ${acct}/access/apps`) return reply(res, state.apps.filter((a) => a.domain === url.searchParams.get('domain')));
  if (key === `POST ${acct}/access/apps`) {
    // Echo extra defaults the way the real API does, so matching must tolerate them.
    const app = { ...body, id: uuid(), aud: 'a'.repeat(63) + String(state.seq % 10), allowed_idps: [], created_at: 'now', policies: body.policies.map((p) => ({ ...p, name: 'DSH Remote owner', decision: 'allow' })) };
    app.oauth_configuration = { ...app.oauth_configuration, dynamic_client_registration: { ...app.oauth_configuration.dynamic_client_registration, client_name_prefix: null } };
    state.apps.push(app);
    return reply(res, app);
  }
  if ((m = new RegExp(`^GET ${acct}/access/apps/(.+)$`).exec(key))) return reply(res, state.apps.find((a) => a.id === m[1]));
  if ((m = new RegExp(`^PUT ${acct}/access/apps/(.+)$`).exec(key))) {
    const i = state.apps.findIndex((a) => a.id === m[1]);
    assert.equal(body.id, undefined, 'PUT must not send read-only fields');
    state.apps[i] = { ...body, id: m[1], aud: state.apps[i].aud, policies: body.policies.map((p) => ({ ...p, name: 'DSH Remote owner' })) };
    return reply(res, state.apps[i]);
  }
  if (key === `GET ${acct}/cfd_tunnel`) return page(res, state.tunnels.filter((t) => t.name === url.searchParams.get('name') && !t.deleted_at), url);
  if (key === `POST ${acct}/cfd_tunnel`) {
    assert.ok(Buffer.from(body.tunnel_secret, 'base64').length >= 32);
    const tunnel = { id: uuid(), name: body.name, config_src: body.config_src, deleted_at: null };
    state.tunnels.push(tunnel);
    state.secrets[tunnel.id] = body.tunnel_secret;
    return reply(res, tunnel);
  }
  if ((m = new RegExp(`^GET ${acct}/cfd_tunnel/([^/]+)/token$`).exec(key))) {
    return reply(res, Buffer.from(JSON.stringify({ a: ACCOUNT, t: m[1], s: state.secrets[m[1]] })).toString('base64'));
  }
  if ((m = new RegExp(`^GET ${acct}/cfd_tunnel/([^/]+)$`).exec(key))) {
    const tunnel = state.tunnels.find((t) => t.id === m[1]);
    return tunnel ? reply(res, tunnel) : res.writeHead(404).end(JSON.stringify({ success: false, errors: [{ code: 1003, message: 'not found' }] }));
  }
  if (key === 'GET /zones/zone1/dns_records') return page(res, state.dns.filter((r) => r.name === url.searchParams.get('name.exact')), url);
  if (key === 'POST /zones/zone1/dns_records') {
    const record = { ...body, id: id('dns') };
    state.dns.push(record);
    return reply(res, record);
  }
  if ((m = /^PATCH \/zones\/zone1\/dns_records\/(.+)$/.exec(key))) {
    const record = state.dns.find((r) => r.id === m[1]);
    Object.assign(record, body);
    return reply(res, record);
  }
  res.writeHead(404).end(JSON.stringify({ success: false, errors: [{ code: 7003, message: `no route ${key}` }] }));
}

function run(...flags) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, '--env', envFile, ...flags], { env: { ...process.env, CLOUDFLARE_API_TOKEN: TOKEN, DSH_REMOTE_CF_API_BASE: `${base}/client/v4`, HOME: dir } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => handle(req, res, raw ? JSON.parse(raw) : undefined));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

beforeEach(() => {
  state = freshState();
  writes = [];
  dir = mkdtempSync(join(tmpdir(), 'dsh-provision-'));
  envFile = join(dir, 'site.env');
  copyFileSync(join(here, '..', 'site.env.example'), envFile);
  const text = readFileSync(envFile, 'utf8').replace(/^OWNER_EMAIL=.*$/m, 'OWNER_EMAIL=owner@example.com');
  writeFileSync(envFile, text);
});

test('plan reads only and lists every resource to create', async () => {
  const before = readFileSync(envFile, 'utf8');
  const result = await run('--plan');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(writes, []);
  assert.equal(readFileSync(envFile, 'utf8'), before);
  for (const text of ['+ Access policy', '+ Access application', '+ Named Tunnel', '+ DNS CNAME dsh.example.com', 'change(s) planned']) assert.ok(result.stdout.includes(text), text);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TOKEN));
});

test('apply creates everything, records the outputs and is idempotent', async () => {
  const first = await run('--apply', '--yes');
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(writes.map((w) => w.key), [
    `POST /accounts/${ACCOUNT}/access/policies`,
    `POST /accounts/${ACCOUNT}/access/apps`,
    `POST /accounts/${ACCOUNT}/cfd_tunnel`,
    'POST /zones/zone1/dns_records',
  ]);
  const app = state.apps[0];
  assert.equal(app.policies[0].id, state.policies[0].id);
  assert.deepEqual(app.oauth_configuration.dynamic_client_registration.allowed_uris, ['https://link.example.com/oauth/callback']);
  assert.equal(app.oauth_configuration.dynamic_client_registration.allow_any_on_loopback, false);
  assert.equal(app.oauth_configuration.grant.session_duration, '336h');
  assert.deepEqual(state.policies[0].include, [{ email: { email: 'owner@example.com' } }]);
  const tunnel = state.tunnels[0];
  assert.deepEqual(state.dns[0], { type: 'CNAME', name: 'dsh.example.com', content: `${tunnel.id}.cfargotunnel.com`, proxied: true, comment: 'DSH Remote tunnel', id: state.dns[0].id });

  const credentials = join(dir, '.cloudflared', `${tunnel.id}.json`);
  assert.equal(statSync(credentials).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(credentials, 'utf8')), { AccountTag: ACCOUNT, TunnelSecret: state.secrets[tunnel.id], TunnelID: tunnel.id });
  const env = readFileSync(envFile, 'utf8');
  for (const line of ['TEAM_NAME=myteam', `AUD_TAG=${app.aud}`, `TUNNEL_ID=${tunnel.id}`, `CREDENTIALS_FILE=${credentials}`, 'API_HOSTNAME=dsh.example.com']) assert.ok(env.includes(`${line}\n`), line);
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  assert.doesNotMatch(first.stdout + first.stderr, new RegExp(TOKEN));
  assert.ok(!first.stdout.includes(state.secrets[tunnel.id]), 'tunnel secret printed');

  writes = [];
  const second = await run('--apply', '--yes');
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(writes, []);
  assert.match(second.stdout, /Everything is already in place/);
});

test('--gate on/off toggles only the loopback allowance', async () => {
  await run('--apply', '--yes');
  writes = [];
  const on = await run('--apply', '--yes', '--gate', 'on');
  assert.equal(on.code, 0, on.stderr);
  assert.deepEqual(writes.map((w) => w.key), [`PUT /accounts/${ACCOUNT}/access/apps/${state.apps[0].id}`]);
  assert.equal(state.apps[0].oauth_configuration.dynamic_client_registration.allow_any_on_loopback, true);
  assert.match(on.stdout, /--gate off/);
  writes = [];
  await run('--apply', '--yes', '--gate', 'off');
  assert.equal(state.apps[0].oauth_configuration.dynamic_client_registration.allow_any_on_localhost, false);
});

test('refuses to repoint a foreign CNAME without --replace-dns', async () => {
  state.dns.push({ id: 'dns-old', type: 'CNAME', name: 'dsh.example.com', content: 'somewhere-else.example.net', proxied: true });
  const refused = await run('--apply', '--yes');
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /--replace-dns/);
  assert.deepEqual(writes, []);
  const replaced = await run('--apply', '--yes', '--replace-dns');
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.match(state.dns[0].content, /cfargotunnel\.com$/);
});

test('rebuilds missing credentials for an existing tunnel from its token', async () => {
  await run('--apply', '--yes');
  const tunnel = state.tunnels[0];
  const credentials = join(dir, '.cloudflared', `${tunnel.id}.json`);
  rmSync(credentials);
  writes = [];
  const result = await run('--apply', '--yes');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(writes, []);
  assert.equal(JSON.parse(readFileSync(credentials, 'utf8')).TunnelSecret, state.secrets[tunnel.id]);
});

test('fails clearly when Zero Trust is not set up', async () => {
  state.organization = {};
  const result = await run('--plan');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Zero Trust is not set up/);
});
