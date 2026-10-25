#!/usr/bin/env node
// Render deployment templates from deployment/site.env into deployment/out/.
// Every value is validated before substitution and any @NAME@ left behind is
// an error, so a rendered file never carries a placeholder or an injected line.
//   node deployment/render.mjs [--env deployment/site.env] [--out deployment/out]
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const envFile = flag('--env', join(here, 'site.env'));
const outDir = flag('--out', join(here, 'out'));

const hostname = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const validators = {
  API_HOSTNAME: hostname,
  LINK_HOSTNAME: hostname,
  TEAM_NAME: /^[a-z0-9][a-z0-9-]{0,62}$/,
  AUD_TAG: /^[a-f0-9]{64}$/,
  TUNNEL_ID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  CREDENTIALS_FILE: /^\/[^\s"'\\]+\.json$/,
  APPLE_TEAM_ID: /^[A-Z0-9]{10}$/,
  IOS_BUNDLE_ID: /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/,
  ANDROID_PACKAGE: /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
  ANDROID_CERT_SHA256: /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/,
};

function readEnv(path) {
  const values = {};
  for (const [index, line] of readFileSync(path, 'utf8').split('\n').entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) throw new Error(`${path}:${index + 1}: expected NAME=value`);
    values[match[1]] = match[2];
  }
  return values;
}

const values = readEnv(envFile);
const problems = [];
for (const [name, pattern] of Object.entries(validators)) {
  const value = values[name];
  if (value === undefined) problems.push(`${name} is missing`);
  else if (!pattern.test(value)) problems.push(`${name} has an invalid value`);
}
if (values.API_HOSTNAME && values.API_HOSTNAME === values.LINK_HOSTNAME) {
  problems.push('API_HOSTNAME and LINK_HOSTNAME must differ: the link host is public, the API host is Access-protected');
}
if (problems.length > 0) {
  console.error(`render: ${envFile}\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

function render(text, source) {
  const output = text.replace(/@([A-Z0-9_]+)@/g, (whole, name) => {
    if (!(name in validators)) throw new Error(`${source}: unknown placeholder ${whole}`);
    return values[name];
  });
  return output;
}

const sources = [
  { from: join(here, 'cloudflared', 'config.yml.tmpl'), to: join(outDir, 'cloudflared', 'config.yml') },
  ...walk(join(here, 'link-site')).map((file) => ({ from: file, to: join(outDir, 'link-site', relative(join(here, 'link-site'), file)) })),
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

for (const { from, to } of sources) {
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, render(readFileSync(from, 'utf8'), relative(here, from)));
  console.log(`rendered ${relative(process.cwd(), to)}`);
}
