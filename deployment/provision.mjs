#!/usr/bin/env node
// Provision the Cloudflare side of DSH Remote with your own API token.
// Deliberate and reviewable: `--plan` only reads; `--apply` shows the same
// plan, asks before changing anything, and is safe to re-run (no duplicates).
// The token is read from the environment, never printed and never stored.
//
//   CLOUDFLARE_API_TOKEN=… node deployment/provision.mjs --plan
//   CLOUDFLARE_API_TOKEN=… node deployment/provision.mjs --apply [--yes]
//
// Options:
//   --env FILE            site.env to read and update (default deployment/site.env)
//   --owner-email EMAIL   the one identity the Access policy allows (or OWNER_EMAIL in site.env)
//   --gate on|off         allow loopback/localhost OAuth redirects for the desktop gate probe
//                         (default: keep the current setting; off for a new application)
//   --require-mfa         require IdP-reported MFA (Okta, Entra ID, generic OIDC or SAML only)
//   --tunnel-name NAME    Named Tunnel to use or create (default dsh-remote)
//   --replace-dns         allow repointing an existing CNAME for API_HOSTNAME at the tunnel
//
// Token permissions: Account › Access: Apps and Policies › Edit; Account › Access:
// Organizations, Identity Providers, and Groups › Read; Account › Cloudflare Tunnel › Edit;
// Zone › Zone › Read; Zone › DNS › Edit; Account › Workers Scripts › Edit (for wrangler).
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const APPLY = has('--apply');
if (APPLY === has('--plan')) usage('pass exactly one of --plan or --apply');
const envFile = option('--env') ?? join(here, 'site.env');
const gate = option('--gate');
if (gate !== undefined && gate !== 'on' && gate !== 'off') usage('--gate must be on or off');
const tunnelName = option('--tunnel-name') ?? 'dsh-remote';
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) usage('set CLOUDFLARE_API_TOKEN (see the permissions at the top of this file)');
// Tests point this at a local fake; in normal use it is always the public API.
const API = process.env.DSH_REMOTE_CF_API_BASE ?? 'https://api.cloudflare.com/client/v4';

const POLICY_NAME = 'DSH Remote owner';
const APP_NAME = 'DSH Remote API';

function usage(message) {
  console.error(`provision: ${message}\nusage: CLOUDFLARE_API_TOKEN=… node deployment/provision.mjs --plan|--apply [--yes] [--owner-email EMAIL] [--gate on|off] [--require-mfa] [--tunnel-name NAME] [--replace-dns] [--env FILE]`);
  process.exit(2);
}

function fail(message) {
  console.error(`\nprovision: ${message}`);
  process.exit(1);
}

// ---------- site.env ----------

function readEnv(path) {
  if (!existsSync(path)) fail(`${path} not found: copy deployment/site.env.example and set API_HOSTNAME, LINK_HOSTNAME and OWNER_EMAIL`);
  const values = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/** Replace or append KEY=value lines, keeping comments and order; written 0600 atomically. */
function updateEnv(path, updates) {
  const lines = readFileSync(path, 'utf8').replace(/\n$/, '').split('\n');
  const pending = new Map(Object.entries(updates));
  const out = lines.map((line) => {
    const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];
    if (key === undefined || !pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${out.join('\n')}\n`, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

const site = readEnv(envFile);
const hostname = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const apiHost = site.API_HOSTNAME;
const linkHost = site.LINK_HOSTNAME;
const ownerEmail = option('--owner-email') ?? site.OWNER_EMAIL;
if (!hostname.test(apiHost ?? '')) fail('API_HOSTNAME in site.env must be a hostname such as dsh.example.com');
if (!hostname.test(linkHost ?? '')) fail('LINK_HOSTNAME in site.env must be a hostname such as link.example.com');
if (apiHost === linkHost) fail('API_HOSTNAME and LINK_HOSTNAME must differ');
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail ?? '')) fail('set OWNER_EMAIL in site.env (or --owner-email): the only identity the Access policy allows');

// ---------- Cloudflare API ----------

async function cf(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json().catch(() => ({ success: false, errors: [{ code: response.status, message: response.statusText }] }));
  if (!json.success) {
    const errors = (json.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${response.status}`;
    const hint = response.status === 403 || response.status === 401 ? ' (check the API token permissions listed at the top of this script)' : '';
    throw new Error(`${method} ${path.split('?')[0]} failed: ${errors}${hint}`);
  }
  return json;
}

async function list(path) {
  const results = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const json = await cf('GET', `${path}${separator}page=${page}&per_page=50`);
    results.push(...(Array.isArray(json.result) ? json.result : []));
    const info = json.result_info;
    if (info === undefined || info.total_pages === undefined || page >= info.total_pages) return results;
  }
}

/** Walk the hostname's suffixes to find the zone that contains it. */
async function zoneFor(name) {
  const labels = name.split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    const candidate = labels.slice(i).join('.');
    const [zone] = (await cf('GET', `/zones?name=${encodeURIComponent(candidate)}`)).result;
    if (zone !== undefined) return zone;
  }
  fail(`no Cloudflare zone on this token contains ${name}`);
}


// ---------- desired state ----------

/** True when every field of `desired` is present and equal in `actual` (extra fields in `actual` are fine). */
function matches(desired, actual) {
  if (Array.isArray(desired)) return Array.isArray(actual) && actual.length === desired.length && desired.every((item, i) => matches(item, actual[i]));
  if (desired !== null && typeof desired === 'object') return actual !== null && typeof actual === 'object' && Object.entries(desired).every(([key, value]) => matches(value, actual[key]));
  return desired === actual;
}

const READ_ONLY = ['id', 'aud', 'uid', 'created_at', 'updated_at'];
const pick = (object, keys) => Object.fromEntries(keys.filter((key) => object[key] !== undefined).map((key) => [key, object[key]]));
const omit = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

/**
 * One pass over every resource. `plan` only reads and reports, `apply` makes
 * the reported changes, `check` only counts what is still out of place.
 */
async function provision(mode) {
  const apply = mode === 'apply';
  let changes = 0;
  const report = (kind, what, detail) => {
    if (kind !== 'keep' && kind !== 'warn') changes += 1;
    if (mode === 'check' || (apply && (kind === 'keep' || kind === 'warn'))) return;
    const mark = { create: '+', update: '~', keep: '=', write: '>', warn: '!' }[kind];
    console.log(`${apply ? '  done ' : ''}${mark} ${what}`);
    if (!apply && detail !== undefined) console.log(`    ${JSON.stringify(detail, null, 2).replaceAll('\n', '\n    ')}`);
  };
  const write = (run) => (apply ? run() : Promise.resolve(undefined));

  const zone = await zoneFor(apiHost);
  const linkZone = linkHost === zone.name || linkHost.endsWith(`.${zone.name}`) ? zone : await zoneFor(linkHost);
  const account = zone.account.id;
  if (linkZone.account.id !== account) fail('API_HOSTNAME and LINK_HOSTNAME are in zones of different accounts');

  const organization = await cf('GET', `/accounts/${account}/access/organizations`).catch(() => undefined);
  const authDomain = organization?.result?.auth_domain;
  if (typeof authDomain !== 'string' || !authDomain.endsWith('.cloudflareaccess.com')) {
    fail('Zero Trust is not set up on this account yet: open one.dash.cloudflare.com once and choose a team name, then re-run');
  }
  const teamName = authDomain.slice(0, -'.cloudflareaccess.com'.length);
  if (mode === 'plan') console.log(`zone ${zone.name}${linkZone === zone ? '' : ` and ${linkZone.name}`}, account ${zone.account.name ?? account}, Zero Trust team ${teamName}\n`);

  // 1. Reusable Allow policy for the owner only (new apps cannot take inline policies).
  const desiredPolicy = {
    name: POLICY_NAME,
    decision: 'allow',
    include: [{ email: { email: ownerEmail } }],
    exclude: [],
    require: has('--require-mfa') ? [{ auth_method: { auth_method: 'mfa' } }] : [],
    session_duration: '24h',
  };
  if (has('--require-mfa')) report('warn', 'MFA is required from the identity provider: this only works with Okta, Entra ID, generic OIDC or SAML logins');
  const existingPolicy = (await list(`/accounts/${account}/access/policies`)).find((p) => p.name === POLICY_NAME);
  let policyId = existingPolicy?.id;
  if (existingPolicy === undefined) {
    report('create', `Access policy "${POLICY_NAME}": allow ${ownerEmail} only`, desiredPolicy);
    policyId = (await write(() => cf('POST', `/accounts/${account}/access/policies`, desiredPolicy)))?.result.id ?? '<new policy>';
  } else if (!matches(desiredPolicy, { ...existingPolicy, exclude: existingPolicy.exclude ?? [], require: existingPolicy.require ?? [] })) {
    report('update', `Access policy "${POLICY_NAME}"`, desiredPolicy);
    await write(() => cf('PUT', `/accounts/${account}/access/policies/${existingPolicy.id}`, desiredPolicy));
  } else {
    report('keep', `Access policy "${POLICY_NAME}"`);
  }

  // 2. Self-hosted application with Managed OAuth for the phone app.
  const [existingApp] = (await cf('GET', `/accounts/${account}/access/apps?domain=${encodeURIComponent(apiHost)}&exact=true`)).result ?? [];
  const currentGate = existingApp?.oauth_configuration?.dynamic_client_registration?.allow_any_on_loopback === true;
  const gateOn = gate === undefined ? currentGate : gate === 'on';
  const desiredApp = {
    type: 'self_hosted',
    name: APP_NAME,
    domain: apiHost,
    destinations: [{ type: 'public', uri: apiHost }],
    session_duration: '24h',
    app_launcher_visible: false,
    oauth_configuration: {
      enabled: true,
      dynamic_client_registration: {
        enabled: true,
        allowed_uris: [`https://${linkHost}/oauth/callback`],
        allow_any_on_localhost: gateOn,
        allow_any_on_loopback: gateOn,
      },
      grant: { access_token_lifetime: '15m', session_duration: '336h' },
    },
  };
  const appPolicies = [{ id: policyId, precedence: 1 }];
  let aud = existingApp?.aud;
  if (existingApp === undefined) {
    report('create', `Access application "${APP_NAME}" for ${apiHost} with Managed OAuth${gateOn ? ' (loopback redirects on for the gate probe)' : ''}`, { ...desiredApp, policies: appPolicies });
    aud = (await write(() => cf('POST', `/accounts/${account}/access/apps`, { ...desiredApp, policies: appPolicies })))?.result.aud ?? '<new application>';
  } else {
    const attached = (existingApp.policies ?? []).map((p) => (typeof p === 'string' ? p : p.id));
    const others = attached.filter((id) => id !== policyId);
    if (others.length > 0) report('warn', `the application has ${others.length} other polic${others.length === 1 ? 'y' : 'ies'}; updating detaches them so only "${POLICY_NAME}" applies`);
    const drift = Object.keys(desiredApp).filter((key) => !matches(desiredApp[key], existingApp[key]));
    if (attached.length !== 1 || attached[0] !== policyId) drift.push('policies');
    if (drift.length === 0) {
      report('keep', `Access application "${APP_NAME}" (gate redirects ${gateOn ? 'on' : 'off'})`);
    } else {
      report('update', `Access application "${APP_NAME}": ${drift.join(', ')}`, pick({ ...desiredApp, policies: appPolicies }, drift));
      // Access apps have no PATCH: GET the full record, merge, PUT it back.
      await write(async () => {
        const full = (await cf('GET', `/accounts/${account}/access/apps/${existingApp.id}`)).result;
        await cf('PUT', `/accounts/${account}/access/apps/${existingApp.id}`, { ...omit(full, READ_ONLY), ...desiredApp, policies: appPolicies });
      });
    }
  }

  // 3. Named Tunnel (locally managed config) and its credentials file.
  const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(site.TUNNEL_ID ?? '') && !/^[0-]+$/.test(site.TUNNEL_ID);
  const found = byId
    ? [await cf('GET', `/accounts/${account}/cfd_tunnel/${site.TUNNEL_ID}`).then((r) => r.result, () => undefined)].filter((t) => t !== undefined && !t.deleted_at)
    : await list(`/accounts/${account}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`);
  let tunnel = found[0];
  let secret;
  if (tunnel === undefined) {
    if (byId) report('warn', `TUNNEL_ID ${site.TUNNEL_ID} from site.env does not exist; creating "${tunnelName}" instead`);
    secret = randomBytes(32).toString('base64');
    report('create', `Named Tunnel "${tunnelName}" (locally managed; its secret is generated on this machine)`, { name: tunnelName, config_src: 'local', tunnel_secret: '<32 random bytes>' });
    tunnel = (await write(() => cf('POST', `/accounts/${account}/cfd_tunnel`, { name: tunnelName, config_src: 'local', tunnel_secret: secret })))?.result ?? { id: '<new tunnel>', name: tunnelName };
  } else {
    report('keep', `Named Tunnel "${tunnel.name}" (${tunnel.id})`);
  }
  const credentialsFile = isAbsolute(site.CREDENTIALS_FILE ?? '') && site.CREDENTIALS_FILE.includes(tunnel.id) ? site.CREDENTIALS_FILE : join(homedir(), '.cloudflared', `${tunnel.id}.json`);
  let haveCredentials = false;
  try {
    haveCredentials = JSON.parse(readFileSync(credentialsFile, 'utf8')).TunnelID === tunnel.id;
  } catch {
    haveCredentials = false;
  }
  if (haveCredentials) {
    report('keep', `tunnel credentials ${credentialsFile}`);
  } else {
    report('write', `tunnel credentials ${credentialsFile} (0600)`);
    await write(async () => {
      if (secret === undefined) {
        // Existing tunnel without a local file: rebuild it from the tunnel token {a, t, s}.
        const decoded = JSON.parse(Buffer.from((await cf('GET', `/accounts/${account}/cfd_tunnel/${tunnel.id}/token`)).result, 'base64').toString('utf8'));
        secret = decoded.s;
      }
      mkdirSync(dirname(credentialsFile), { recursive: true, mode: 0o700 });
      writeFileSync(credentialsFile, `${JSON.stringify({ AccountTag: account, TunnelSecret: secret, TunnelID: tunnel.id })}\n`, { mode: 0o600 });
      chmodSync(credentialsFile, 0o600);
    });
  }

  // 4. DNS: API host → tunnel as a proxied CNAME. The link host's record comes from the Worker custom domain.
  const target = `${tunnel.id}.cfargotunnel.com`;
  const apiRecords = await list(`/zones/${zone.id}/dns_records?name.exact=${encodeURIComponent(apiHost)}`);
  const others = apiRecords.filter((r) => r.type !== 'CNAME');
  if (others.length > 0) fail(`${apiHost} already has ${others.map((r) => r.type).join('/')} records; remove them first`);
  const cname = apiRecords.find((r) => r.type === 'CNAME');
  if (cname === undefined) {
    report('create', `DNS CNAME ${apiHost} → ${target} (proxied)`);
    await write(() => cf('POST', `/zones/${zone.id}/dns_records`, { type: 'CNAME', name: apiHost, content: target, proxied: true, comment: 'DSH Remote tunnel' }));
  } else if (cname.content === target && cname.proxied === true) {
    report('keep', `DNS CNAME ${apiHost} → ${target}`);
  } else if (!String(cname.content).endsWith('.cfargotunnel.com') && !has('--replace-dns')) {
    fail(`${apiHost} is a CNAME to ${cname.content}; pass --replace-dns to point it at the tunnel`);
  } else {
    report('update', `DNS CNAME ${apiHost}: ${cname.content}${cname.proxied ? '' : ' (DNS only)'} → ${target} (proxied)`);
    await write(() => cf('PATCH', `/zones/${zone.id}/dns_records/${cname.id}`, { content: target, proxied: true }));
  }
  const linkRecords = await list(`/zones/${linkZone.id}/dns_records?name.exact=${encodeURIComponent(linkHost)}`);
  if (linkRecords.some((r) => r.type === 'CNAME')) report('warn', `${linkHost} has a CNAME; remove it before \`wrangler deploy\` (a Worker custom domain cannot be created over a CNAME)`);

  // 5. Record the outputs for render.mjs.
  const outputs = { TEAM_NAME: teamName, AUD_TAG: aud, TUNNEL_ID: tunnel.id, CREDENTIALS_FILE: credentialsFile, OWNER_EMAIL: ownerEmail };
  const envChanges = Object.fromEntries(Object.entries(outputs).filter(([key, value]) => site[key] !== value));
  if (Object.keys(envChanges).length === 0) report('keep', envFile);
  else {
    report('write', `${envFile}: ${Object.keys(envChanges).join(', ')}`);
    await write(async () => updateEnv(envFile, envChanges));
  }
  return { changes, account, gateOn };
}

// ---------- main ----------

console.log(`DSH Remote: Cloudflare plan for https://${apiHost} (link host https://${linkHost})\n`);
const plan = await provision('plan');
if (plan.changes === 0) {
  console.log('\nEverything is already in place.');
} else if (!APPLY) {
  console.log(`\n${plan.changes} change(s) planned. Nothing was changed; re-run with --apply to make them.`);
} else {
  if (!has('--yes')) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await prompt.question(`\nApply these ${plan.changes} change(s) to your Cloudflare account? [y/N] `)).trim().toLowerCase();
    prompt.close();
    if (answer !== 'y' && answer !== 'yes') fail('nothing was changed');
  }
  console.log('');
  await provision('apply');
  const after = await provision('check').catch(() => undefined);
  if (after !== undefined && after.changes !== 0) console.log(`\nNote: a fresh plan still shows ${after.changes} change(s); re-run --plan to see them.`);
}
if (APPLY || plan.changes === 0) {
  console.log(`
Next:
  node deployment/render.mjs
  CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=${plan.account} npx wrangler@4.150.0 deploy --config deployment/out/link-worker/wrangler.jsonc
  node deployment/install.mjs --dry-run        # then without --dry-run
Not automated on purpose:
  - choosing the login method(s) for "${APP_NAME}" if your team has several identity providers
  - Settings → "Require Access protection" (account-wide; affects every hostname in the account)${plan.gateOn ? '\n  - after the gate: node deployment/provision.mjs --apply --gate off' : ''}`);
}
