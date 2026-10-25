import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileAudit } from '../src/core/audit.ts';
import { systemClock } from '../src/core/clock.ts';
import { HostIdentity } from '../src/core/host-identity.ts';
import { HostState, type HostStateDocument } from '../src/core/state.ts';
import { ensurePrivateDir, JsonFileStore } from '../src/core/store.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-remote-'));
  chmodSync(dir, 0o700);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mode = (path: string) => statSync(path).mode & 0o777;

describe('private files', () => {
  it('refuses a state directory others can reach', () => {
    const open = join(dir, 'open');
    ensurePrivateDir(join(dir, 'remote'));
    expect(mode(join(dir, 'remote'))).toBe(0o700);
    ensurePrivateDir(open);
    chmodSync(open, 0o755);
    expect(() => ensurePrivateDir(open)).toThrow(/must not be accessible/);
  });

  it('writes state atomically as 0600 and leaves no temp files', async () => {
    const path = join(dir, 'state.json');
    const store = new JsonFileStore<HostStateDocument>(path);
    const state = await HostState.open(store, systemClock);
    await Promise.all([state.setPublished('s1', true), state.setPublished('s2', true)]);
    expect(mode(path)).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['state.json']);
    const reopened = await HostState.open(new JsonFileStore<HostStateDocument>(path), systemClock);
    expect(reopened.hostId).toBe(state.hostId);
    expect(reopened.publications().map((p) => p.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('creates the host key once, 0600, and reloads the same identity', async () => {
    const path = join(dir, 'host-key.pem');
    const first = await HostIdentity.loadOrCreate(path);
    expect(mode(path)).toBe(0o600);
    const second = await HostIdentity.loadOrCreate(path);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('appends the audit log as 0600', async () => {
    const path = join(dir, 'audit.jsonl');
    const audit = new FileAudit(path, systemClock);
    audit.record({ event: 'test', requestId: 'trace_1' });
    await audit.flush();
    expect(mode(path)).toBe(0o600);
  });
});
