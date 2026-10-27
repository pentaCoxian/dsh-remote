import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { compareVersions, MOBILE_UI } from '../dsh/mobile-ui.ts';

/**
 * Install or upgrade DSH Remote and dsh-mobile-maxxing in a DSH profile, from
 * release tarballs downloaded (and checked) into `$DSH_HOME/plugin-tarballs`.
 *
 * Why files and not URLs: DSH's pnpm records no integrity for a tarball added
 * by URL, then refuses that lockfile entry on every later install, so a profile
 * set up from URLs can never change again. Local files get an integrity hash.
 * Profiles set up from URLs (the 0.1.0 instructions) are repaired first.
 *
 * Node built-ins only: this also runs on its own, as the release's install.mjs.
 */
export const REPO = 'pentaCoxian/dsh-remote';
export const PLUGIN = '@dsh-remote/dsh-plugin';
const PLUGIN_FILE = /^dsh-remote-dsh-plugin-(\d+\.\d+\.\d+)\.tgz$/;

export interface InstallOptions {
  /** e.g. `0.1.1`; the latest release when absent. */
  readonly version?: string;
  readonly profile?: string;
  /** Default `$DSH_HOME`, else `~/.dsh`. */
  readonly dshHome?: string;
  /** How to run DSH's CLI; default `dsh` on the PATH. */
  readonly dsh?: readonly string[];
  /** How DSH runs pnpm, to check its version; default `pnpm` on the PATH. */
  readonly pnpm?: readonly string[];
  /** A directory already holding the tarballs, instead of GitHub (tests, offline installs). */
  readonly from?: string;
  readonly log?: (line: string) => void;
}

export interface InstallResult {
  readonly version: string;
  /** The tarballs handed to DSH; empty when the profile already had these versions. */
  readonly files: readonly string[];
  readonly repaired: readonly string[];
}

export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME?.trim() || join(homedir(), '.dsh');
}

export async function install(options: InstallOptions = {}): Promise<InstallResult> {
  const log = options.log ?? (() => {});
  const home = options.dshHome ?? dshHome();
  const profile = options.profile ?? 'web';
  const dir = join(home, 'plugin-tarballs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const plugin = options.from === undefined ? await downloadRelease(options.version, dir, log) : copyLocalRelease(options.from, options.version, dir);
  const profileDir = join(home, 'profiles', profile);
  const repaired = repairProfile(profileDir, log);

  // Only what changes goes to DSH: an up-to-date profile is left alone, and a newer
  // dsh-mobile-maxxing is kept.
  const files: string[] = [];
  if (installedVersion(profileDir, PLUGIN) !== plugin.version) files.push(plugin.file);
  const mobileUi = installedVersion(profileDir, MOBILE_UI.name);
  if (mobileUi === undefined || compareVersions(mobileUi, MOBILE_UI.minVersion) < 0) files.push(await mobileUiTarball(dir, options.from, log));
  if (files.length === 0) {
    log(`DSH Remote ${plugin.version} and ${MOBILE_UI.name} ${mobileUi} are already installed in the ${profile} profile`);
    return { version: plugin.version, files, repaired };
  }

  const env = { ...process.env, DSH_HOME: home };
  checkPnpm(options.pnpm ?? ['pnpm'], env, existsSync(profileDir) ? profileDir : home);
  const [command = 'dsh', ...prefix] = options.dsh ?? ['dsh'];
  log(`adding ${files.map((file) => basename(file, '.tgz')).join(' and ')} to the ${profile} profile`);
  // pnpm's progress goes straight to this terminal. No pipes: a process pnpm leaves
  // behind holding one open would keep spawnSync waiting after DSH has exited.
  const add = spawnSync(command, [...prefix, 'plugin', '--profile', profile, 'add', ...files], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  if (add.error !== undefined) throw new Error(`cannot run ${command}: ${add.error.message} (is DSH installed? npm i -g @deepseek-ai/dsh)`);
  if (add.status !== 0) throw new Error(`dsh plugin add failed (${add.status ?? add.signal}); its output is above`);
  return { version: plugin.version, files, repaired };
}

/**
 * pnpm 11.0 to 11.22 can keep running after an install, and DSH waits on it. pnpm
 * fetches iroh's native packages for the other platforms in the background without
 * waiting for them; one that reaches the store after pnpm has shut its worker pool
 * down starts a new pool, and nothing shuts that one down. 11.23.0 reuses the shut
 * pool. pnpm is asked where DSH runs it; a pnpm that cannot be asked is left to DSH.
 */
function checkPnpm([command = 'pnpm', ...prefix]: readonly string[], env: NodeJS.ProcessEnv, cwd: string): void {
  const answer = spawnSync(command, [...prefix, '--version'], { env, cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
  const version = /^(\d+)\.(\d+)\.\d+/.exec((answer.stdout ?? '').trim());
  if (version === null || Number(version[1]) !== 11 || Number(version[2]) >= 23) return;
  throw new Error(`pnpm ${version[0]} can keep running after it finishes installing, and DSH would wait on it forever (fixed in pnpm 11.23.0). Update pnpm with \`pnpm self-update 11\` (or \`npm i -g pnpm@11\` if npm installed it), then run this again`);
}

/** The version of `name` the profile lists and has installed, if any. */
function installedVersion(profileDir: string, name: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    if (manifest.dependencies?.[name] === undefined) return undefined;
    const installed = JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof installed.version === 'string' ? installed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A profile that got DSH Remote or dsh-mobile-maxxing from a URL cannot take
 * any further install: drop those entries and both lockfiles that pin them
 * (pnpm-lock.yaml and pnpm's copy in node_modules), so the next add resolves
 * everything afresh. Returns the names it dropped.
 */
export function repairProfile(profileDir: string, log: (line: string) => void = () => {}): string[] {
  const manifestPath = join(profileDir, 'package.json');
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> };
  const dependencies = manifest.dependencies ?? {};
  const fromUrls = [PLUGIN, MOBILE_UI.name].filter((name) => /^https?:/.test(dependencies[name] ?? ''));
  if (fromUrls.length === 0) return [];
  for (const name of fromUrls) delete dependencies[name];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  rmSync(join(profileDir, 'pnpm-lock.yaml'), { force: true });
  rmSync(join(profileDir, 'node_modules', '.pnpm', 'lock.yaml'), { force: true });
  log(`repaired the profile: ${fromUrls.join(' and ')} had been added by URL, which pnpm cannot verify on later installs`);
  return fromUrls;
}

interface ReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
  /** `sha256:<hex>`, on assets uploaded since mid-2025. */
  readonly digest?: string | null;
}

async function downloadRelease(version: string | undefined, dir: string, log: (line: string) => void): Promise<{ version: string; file: string }> {
  const url = `https://api.github.com/repos/${REPO}/releases/${version === undefined ? 'latest' : `tags/v${version}`}`;
  const reply = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-remote-installer' } });
  if (!reply.ok) throw new Error(`no DSH Remote release ${version ?? '(latest)'}: GitHub answered ${reply.status}`);
  const release = (await reply.json()) as { tag_name: string; assets: ReleaseAsset[] };
  const asset = release.assets.find((candidate) => PLUGIN_FILE.test(candidate.name));
  if (asset === undefined) throw new Error(`release ${release.tag_name} has no plugin tarball`);
  const file = join(dir, asset.name);
  await download(asset.browser_download_url, file, asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : undefined, log);
  return { version: PLUGIN_FILE.exec(asset.name)![1]!, file };
}

function copyLocalRelease(from: string, version: string | undefined, dir: string): { version: string; file: string } {
  const candidates = readdirSync(from).flatMap((name) => {
    const match = PLUGIN_FILE.exec(name);
    return match === null ? [] : [{ name, version: match[1]! }];
  });
  const chosen = version === undefined ? candidates.sort((a, b) => compareVersions(b.version, a.version))[0] : candidates.find((candidate) => candidate.version === version);
  if (chosen === undefined) throw new Error(`no dsh-remote-dsh-plugin-${version ?? '<version>'}.tgz in ${from}`);
  const file = join(dir, chosen.name);
  copyFileSync(join(from, chosen.name), file);
  return { version: chosen.version, file };
}

/** dsh-mobile-maxxing's pinned release in `dir`: copied from `from` when there, else downloaded; checked either way. */
export async function mobileUiTarball(dir: string, from: string | undefined, log: (line: string) => void = () => {}): Promise<string> {
  const name = basename(new URL(MOBILE_UI.tarball).pathname);
  const file = join(dir, name);
  const local = from === undefined ? undefined : join(from, name);
  if (local !== undefined && existsSync(local)) {
    verify(readFileSync(local), MOBILE_UI.sha256, name);
    copyFileSync(local, file);
  } else {
    await download(MOBILE_UI.tarball, file, MOBILE_UI.sha256, log);
  }
  return file;
}

/** Fetch `url` to `file` (atomically), checking its SHA-256 when one is known; an intact copy is kept. */
async function download(url: string, file: string, sha256: string | undefined, log: (line: string) => void): Promise<void> {
  if (existsSync(file) && sha256 !== undefined && hash(readFileSync(file)) === sha256) return;
  log(`downloading ${basename(file)}`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const reply = await fetch(url, { headers: { 'user-agent': 'dsh-remote-installer' } });
  if (!reply.ok) throw new Error(`downloading ${url} failed: ${reply.status}`);
  const bytes = Buffer.from(await reply.arrayBuffer());
  if (sha256 !== undefined) verify(bytes, sha256, basename(file));
  writeFileSync(`${file}.part`, bytes, { mode: 0o600 });
  renameSync(`${file}.part`, file);
}

function verify(bytes: Buffer, sha256: string, name: string): void {
  if (hash(bytes) !== sha256) throw new Error(`${name} does not match its published SHA-256; not installing it`);
}

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
