import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVersions, MOBILE_UI, mobileUiStatus } from '../src/dsh/mobile-ui.ts';

/** A package laid out like the real one: client module two levels below package.json. */
function installed(version: string, name: string = MOBILE_UI.name): string {
  const root = mkdtempSync(join(tmpdir(), 'mobile-ui-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version }));
  mkdirSync(join(root, 'packages', 'dsh-mobile-maxxing'), { recursive: true });
  const client = join(root, 'packages', 'dsh-mobile-maxxing', 'client.js');
  writeFileSync(client, '');
  return client;
}

describe('the phone layout requirement (dsh-mobile-maxxing)', () => {
  it('is met by the required version or newer', () => {
    expect(mobileUiStatus(installed('0.6.0'))).toEqual({ version: '0.6.0', ok: true });
    expect(mobileUiStatus(installed('1.2.3'))).toEqual({ version: '1.2.3', ok: true });
  });

  it('says how to install it when DSH Web does not load it', () => {
    const status = mobileUiStatus(undefined);
    expect(status).toMatchObject({ version: null, ok: false });
    expect(status.problem).toContain('dsh plugin --profile web add https://github.com/kuraneko1/dsh-mobile-maxxing/releases/download/v0.6.0/dsh-mobile-maxxing-0.6.0.tgz');
  });

  it('asks for an update when it is too old or not what it claims', () => {
    expect(mobileUiStatus(installed('0.5.9'))).toMatchObject({ version: '0.5.9', ok: false });
    expect(mobileUiStatus(installed('0.6.0', 'something-else'))).toMatchObject({ version: null, ok: false });
  });

  it('compares versions by number', () => {
    expect(compareVersions('0.10.0', '0.6.0')).toBe(1);
    expect(compareVersions('0.6.0', '0.6')).toBe(0);
    expect(compareVersions('0.6.0-beta.1', '0.6.0')).toBe(0);
    expect(compareVersions('0.5.12', '0.6.0')).toBe(-1);
  });
});
