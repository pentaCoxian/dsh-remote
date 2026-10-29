import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * DSH Remote shows DSH Web on a phone and needs dsh-mobile-maxxing
 * (github.com/kuraneko1/dsh-mobile-maxxing, MIT) for its phone layout. DSH
 * loads only the plugins its profile lists itself, so it is installed next to
 * DSH Remote rather than as a dependency; this checks that it is there.
 */
const VERSION = '1.0.0';

export const MOBILE_UI = {
  name: 'dsh-mobile-maxxing',
  /** The oldest release whose phone layout DSH Remote works with. */
  minVersion: '0.6.0',
  /** The tested release: the installer brings older ones up to it and keeps newer ones. */
  version: VERSION,
  /** That release; a versioned URL, because pnpm caches by URL. */
  tarball: `https://github.com/kuraneko1/dsh-mobile-maxxing/releases/download/v${VERSION}/dsh-mobile-maxxing-${VERSION}.tgz`,
  /** SHA-256 of that tarball, checked by the installer before DSH sees it. */
  sha256: '50d151efb86367c8200b7fd861fa05c0929541d1b67d48bb96dc82ffa70b9adc',
  /** Installs it from a checked local copy: a URL install would break later pnpm installs. */
  install: 'run `dsh-remote upgrade`',
} as const;

export interface MobileUiStatus {
  /** The installed version, or null when DSH Web does not load it. */
  readonly version: string | null;
  readonly ok: boolean;
  /** What is wrong and how to fix it, when not ok. */
  readonly problem?: string;
}

/** The status from where DSH Web loads its client module (`clientModules.clientPath`), if it does. */
export function mobileUiStatus(clientPath: string | undefined): MobileUiStatus {
  const fix = `${MOBILE_UI.install}, then restart DSH`;
  if (clientPath === undefined) return { version: null, ok: false, problem: `${MOBILE_UI.name} is not installed, so DSH Web has no phone layout: ${fix}` };
  const version = packageVersion(clientPath);
  if (version === undefined || compareVersions(version, MOBILE_UI.minVersion) < 0) {
    return { version: version ?? null, ok: false, problem: `${MOBILE_UI.name} ${version ?? 'of unknown version'} is older than ${MOBILE_UI.minVersion}: ${fix}` };
  }
  return { version, ok: true };
}

/** The version in the nearest package.json named like the plugin, above its client module. */
function packageVersion(clientPath: string): string | undefined {
  let dir = dirname(clientPath);
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
      if (manifest.name === MOBILE_UI.name && typeof manifest.version === 'string') return manifest.version;
    } catch {
      // No package.json here; keep climbing.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Compare `x.y.z` versions numerically; a pre-release suffix is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split('-')[0]!.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}
