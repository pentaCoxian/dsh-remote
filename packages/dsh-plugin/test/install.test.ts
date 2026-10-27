import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MOBILE_UI } from '../src/dsh/mobile-ui.ts';
import { install, PLUGIN, repairProfile } from '../src/install/installer.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-remote-install-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A DSH profile as `dsh plugin add` leaves it, with the given dependencies and both lockfiles. */
function profile(dependencies: Record<string, string>): string {
  const root = join(dir, 'home', 'profiles', 'web');
  mkdirSync(join(root, 'node_modules', '.pnpm'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies, dsh: { profile: { bundles: [PLUGIN] } } }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  writeFileSync(join(root, 'node_modules', '.pnpm', 'lock.yaml'), 'lockfileVersion: 9.0\n');
  return root;
}

describe('repairing a profile set up from URLs', () => {
  it('drops the URL entries and both lockfiles, and keeps everything else', () => {
    const root = profile({
      [PLUGIN]: 'https://github.com/pentaCoxian/dsh-remote/releases/download/v0.1.0/dsh-remote-dsh-plugin-0.1.0.tgz',
      [MOBILE_UI.name]: MOBILE_UI.tarball,
      'other-plugin': '1.2.3',
    });
    expect(repairProfile(root)).toEqual([PLUGIN, MOBILE_UI.name]);
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(manifest.dependencies).toEqual({ 'other-plugin': '1.2.3' });
    expect(manifest.dsh).toEqual({ profile: { bundles: [PLUGIN] } });
    expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(false);
    expect(existsSync(join(root, 'node_modules', '.pnpm', 'lock.yaml'))).toBe(false);
  });

  it('leaves a profile installed from files alone', () => {
    const root = profile({ [PLUGIN]: 'file:/x/dsh-remote-dsh-plugin-0.1.1.tgz', [MOBILE_UI.name]: 'file:/x/dsh-mobile-maxxing-0.6.0.tgz' });
    expect(repairProfile(root)).toEqual([]);
    expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(true);
    expect(repairProfile(join(dir, 'no-such-profile'))).toEqual([]);
  });
});

describe('installing from a local release directory', () => {
  const release = () => {
    const from = join(dir, 'release');
    mkdirSync(from, { recursive: true });
    for (const version of ['0.1.0', '0.1.10', '0.1.9']) writeFileSync(join(from, `dsh-remote-dsh-plugin-${version}.tgz`), version);
    return from;
  };

  it('picks the newest plugin by number, or the version asked for', async () => {
    const from = release();
    // A stand-in dsh-mobile-maxxing fails its checksum, so nothing reaches DSH; the plugin was already chosen.
    writeFileSync(join(from, 'dsh-mobile-maxxing-0.6.0.tgz'), 'not the release');
    const home = join(dir, 'home');
    await expect(install({ from, dshHome: home, dsh: ['false'] })).rejects.toThrow(/does not match its published SHA-256/);
    expect(readdirSync(join(home, 'plugin-tarballs'))).toEqual(['dsh-remote-dsh-plugin-0.1.10.tgz']);
    rmSync(join(home, 'plugin-tarballs'), { recursive: true });
    await expect(install({ from, version: '0.1.9', dshHome: home, dsh: ['false'] })).rejects.toThrow(/SHA-256/);
    expect(readdirSync(join(home, 'plugin-tarballs'))).toEqual(['dsh-remote-dsh-plugin-0.1.9.tgz']);
  });

  /** A profile that has these versions installed from files. */
  const installedProfile = (versions: Record<string, string>) => {
    const root = profile(Object.fromEntries(Object.keys(versions).map((name) => [name, `file:/x/${name}.tgz`])));
    for (const [name, version] of Object.entries(versions)) {
      mkdirSync(join(root, 'node_modules', name), { recursive: true });
      writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
    }
  };
  /** A `dsh` that records its arguments instead of installing. */
  const recordingDsh = () => {
    const record = join(dir, 'dsh-args.json');
    return {
      dsh: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(1)))`],
      args: () => (existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : undefined),
      clear: () => rmSync(record, { force: true }),
    };
  };
  /** A `pnpm` that only answers `--version`. */
  const pnpmAt = (version: string) => [process.execPath, '-e', `console.log(${JSON.stringify(version)})`, '--'];

  it('leaves a profile that already has these versions alone', async () => {
    installedProfile({ [PLUGIN]: '0.1.10', [MOBILE_UI.name]: '0.6.0' });
    const fake = recordingDsh();
    const result = await install({ from: release(), dshHome: join(dir, 'home'), dsh: fake.dsh });
    expect(result).toMatchObject({ version: '0.1.10', files: [] });
    expect(fake.args()).toBeUndefined();
  });

  it('adds only the plugin when dsh-mobile-maxxing is already new enough, even newer than pinned', async () => {
    installedProfile({ [PLUGIN]: '0.1.9', [MOBILE_UI.name]: '0.7.0' });
    const fake = recordingDsh();
    const result = await install({ from: release(), dshHome: join(dir, 'home'), dsh: fake.dsh, pnpm: pnpmAt('11.28.8') });
    expect(result.files.map((file) => file.split('/').pop())).toEqual(['dsh-remote-dsh-plugin-0.1.10.tgz']);
    expect(fake.args()).toEqual(['plugin', '--profile', 'web', 'add', join(dir, 'home', 'plugin-tarballs', 'dsh-remote-dsh-plugin-0.1.10.tgz')]);
  });

  it('stops before DSH when its pnpm is one that keeps running after an install', async () => {
    installedProfile({ [PLUGIN]: '0.1.9', [MOBILE_UI.name]: '0.6.0' });
    const fake = recordingDsh();
    const options = { from: release(), dshHome: join(dir, 'home'), dsh: fake.dsh };
    for (const version of ['11.0.0', '11.5.0', '11.22.3']) {
      await expect(install({ ...options, pnpm: pnpmAt(version) })).rejects.toThrow(`pnpm ${version} can keep running after it finishes installing`);
      expect(fake.args()).toBeUndefined();
    }
    // Fixed, unaffected, or a pnpm it cannot ask (DSH then says pnpm is missing).
    for (const pnpm of [pnpmAt('11.23.0'), pnpmAt('10.34.9'), pnpmAt('12.15.0'), [join(dir, 'no-such-pnpm')]]) {
      fake.clear();
      await install({ ...options, pnpm });
      expect(fake.args()).toEqual(['plugin', '--profile', 'web', 'add', join(dir, 'home', 'plugin-tarballs', 'dsh-remote-dsh-plugin-0.1.10.tgz')]);
    }
  });

  it('names the file it could not find', async () => {
    await expect(install({ from: release(), version: '2.0.0', dshHome: join(dir, 'home') })).rejects.toThrow('no dsh-remote-dsh-plugin-2.0.0.tgz in');
  });
});
