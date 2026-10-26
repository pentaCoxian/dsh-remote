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

  it('names the file it could not find', async () => {
    await expect(install({ from: release(), version: '2.0.0', dshHome: join(dir, 'home') })).rejects.toThrow('no dsh-remote-dsh-plugin-2.0.0.tgz in');
  });
});
