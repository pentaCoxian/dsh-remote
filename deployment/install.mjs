#!/usr/bin/env node
// Install (or remove) the supervised DSH host and cloudflared as *user* services:
// systemd user units on Linux, launchd agents on macOS. Values are validated and
// escaped per format; --dry-run prints everything without touching the system.
//
//   node deployment/install.mjs [--dry-run] [--uninstall]
//     [--dsh-entry PATH] [--node PATH] [--cloudflared PATH]
//     [--dsh-home DIR] [--workdir DIR] [--web-port 3080]
//
// Prerequisite: `node deployment/render.mjs` (writes deployment/out/cloudflared/config.yml).
import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = has('--dry-run');
const uninstall = has('--uninstall');
const home = homedir();

const platform = process.platform === 'linux' ? 'systemd' : process.platform === 'darwin' ? 'launchd' : undefined;
if (platform === undefined) fail(`unsupported platform ${process.platform} (Linux systemd or macOS launchd only)`);

const units = platform === 'systemd'
  ? [
      { template: 'systemd/dsh-remote-host.service.tmpl', target: join(home, '.config/systemd/user/dsh-remote-host.service'), name: 'dsh-remote-host.service' },
      { template: 'systemd/dsh-remote-cloudflared.service.tmpl', target: join(home, '.config/systemd/user/dsh-remote-cloudflared.service'), name: 'dsh-remote-cloudflared.service' },
    ]
  : [
      { template: 'launchd/dev.dshremote.host.plist.tmpl', target: join(home, 'Library/LaunchAgents/dev.dshremote.host.plist'), name: 'dev.dshremote.host' },
      { template: 'launchd/dev.dshremote.cloudflared.plist.tmpl', target: join(home, 'Library/LaunchAgents/dev.dshremote.cloudflared.plist'), name: 'dev.dshremote.cloudflared' },
    ];

function fail(message) {
  console.error(`install: ${message}`);
  process.exit(1);
}

function run(command, commandArgs, { ignoreFailure = false } = {}) {
  console.log(`$ ${command} ${commandArgs.join(' ')}`);
  if (dryRun) return '';
  try {
    return execFileSync(command, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (!ignoreFailure) fail(`${command} failed: ${error.stderr ?? error.message}`);
    return '';
  }
}

/** Location on PATH, kept as-is so package-manager upgrades do not break the unit. */
function which(binary) {
  try {
    return execFileSync('/usr/bin/env', ['which', binary], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

if (uninstall) {
  for (const unit of units) {
    if (platform === 'systemd') run('systemctl', ['--user', 'disable', '--now', unit.name], { ignoreFailure: true });
    else run('launchctl', ['bootout', `gui/${process.getuid()}/${unit.name}`], { ignoreFailure: true });
    console.log(`remove ${unit.target}`);
    if (!dryRun) rmSync(unit.target, { force: true });
  }
  if (platform === 'systemd') run('systemctl', ['--user', 'daemon-reload'], { ignoreFailure: true });
  console.log('Removed the DSH Remote services. Your DSH home, plugin state and cloudflared config were left in place.');
  process.exit(0);
}

const node = value('--node') ?? process.execPath;
const [major, minor] = execFileSync(node, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim().split('.').map(Number);
if (!(major > 24 || (major === 24 && minor >= 9))) fail(`${node} is Node ${major}.${minor}; DSH needs 24.9+ (pass --node)`);

let dshEntry = value('--dsh-entry');
if (dshEntry === undefined) {
  const onPath = which('dsh');
  // rdsh may sit on PATH as `dsh`; only a Node entry script is run directly.
  if (onPath !== undefined && readFileSync(realpathSync(onPath), 'utf8').startsWith('#!/usr/bin/env node')) dshEntry = realpathSync(onPath);
  else {
    const npmRoot = execFileSync(join(dirname(node), 'npm'), ['root', '-g'], { encoding: 'utf8' }).trim();
    const candidate = join(npmRoot, '@deepseek-ai/dsh/lib/bin.js');
    if (existsSync(candidate)) dshEntry = candidate;
  }
}
if (dshEntry === undefined || !existsSync(dshEntry)) fail('cannot find the dsh entry script; pass --dsh-entry /path/to/@deepseek-ai/dsh/lib/bin.js');

const cloudflared = value('--cloudflared') ?? which('cloudflared');
if (cloudflared === undefined) fail('cloudflared is not on PATH; install it or pass --cloudflared');

const renderedTunnel = join(here, 'out/cloudflared/config.yml');
if (!existsSync(renderedTunnel)) fail('run `node deployment/render.mjs` first (deployment/out/cloudflared/config.yml is missing)');
const configDir = join(home, '.config/dsh-remote');
const tunnelConfig = join(configDir, 'cloudflared.yml');

const values = {
  NODE: node,
  NODE_BIN_DIR: dirname(node),
  DSH_ENTRY: dshEntry,
  DSH_HOME: value('--dsh-home') ?? (process.env.DSH_HOME?.trim() || join(home, '.dsh')),
  WORKDIR: value('--workdir') ?? home,
  DSH_WEB_PORT: value('--web-port') ?? '3080',
  CLOUDFLARED: cloudflared,
  CLOUDFLARED_CONFIG: tunnelConfig,
  LOG_DIR: join(home, 'Library/Logs/dsh-remote'),
};

for (const [name, text] of Object.entries(values)) {
  if (name === 'DSH_WEB_PORT') {
    if (!/^\d{2,5}$/.test(text)) fail('--web-port must be a port number');
    continue;
  }
  if (!isAbsolute(text)) fail(`${name} must be an absolute path (${text})`);
  // Refuse characters that would need format-specific quoting tricks.
  if (/[\x00-\x1f\x7f"\\$`]/.test(text)) fail(`${name} contains characters this installer refuses to quote (${JSON.stringify(text)})`);
}

const escapeFor = {
  systemd: (text) => text.replaceAll('%', '%%'),
  launchd: (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll("'", '&apos;'),
};

for (const unit of units) {
  const template = readFileSync(join(here, unit.template), 'utf8');
  const rendered = template.replace(/@([A-Z_]+)@/g, (whole, name) => {
    if (!(name in values)) fail(`${unit.template}: unknown placeholder ${whole}`);
    return escapeFor[platform](values[name]);
  });
  console.log(`\n# ${unit.target}\n${rendered}`);
  if (!dryRun) {
    mkdirSync(dirname(unit.target), { recursive: true });
    writeFileSync(unit.target, rendered, { mode: 0o644 });
  }
}

console.log(`\ninstall ${renderedTunnel} -> ${tunnelConfig} (0600)`);
if (!dryRun) {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  copyFileSync(renderedTunnel, tunnelConfig);
  chmodSync(tunnelConfig, 0o600);
  if (platform === 'launchd') mkdirSync(values.LOG_DIR, { recursive: true, mode: 0o700 });
}

if (platform === 'systemd') {
  run('systemctl', ['--user', 'daemon-reload']);
  for (const unit of units) run('systemctl', ['--user', 'enable', '--now', unit.name]);
  const linger = run('loginctl', ['show-user', process.env.USER ?? '', '-p', 'Linger'], { ignoreFailure: true });
  if (!dryRun && !linger.includes('Linger=yes')) console.log('\nNote: run `sudo loginctl enable-linger $USER` so the services start at boot without a login session.');
} else {
  for (const unit of units) {
    run('launchctl', ['bootout', `gui/${process.getuid()}/${unit.name}`], { ignoreFailure: true });
    run('launchctl', ['bootstrap', `gui/${process.getuid()}`, unit.target]);
  }
  console.log('\nNote: a sleeping Mac takes the host offline. Keep it awake (System Settings → Energy, or `sudo pmset -c sleep 0`).');
}
console.log(dryRun ? '\nDry run: nothing was changed.' : '\nInstalled. Check with `dsh-remote doctor`.');
