import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileAudit } from '../src/core/audit.ts';
import { systemClock } from '../src/core/clock.ts';
import { HostKey } from '../src/core/host-key.ts';
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
    expect(reopened.publications().map((p) => p.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('keeps publications but drops Access-bound devices from a Sprint 1 state file', async () => {
    const path = join(dir, 'state.json');
    writeFileSync(path, JSON.stringify({ version: 1, hostId: 'host_xxxxxxxxxxxxxxxx', devices: [{ deviceId: 'dev_old', accessSub: 'u' }], published: [{ sessionId: 's1', publishedAt: 1 }] }), { mode: 0o600 });
    const state = await HostState.open(new JsonFileStore<HostStateDocument>(path), systemClock);
    expect(state.devices()).toEqual([]);
    expect(state.isPublished('s1')).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(2);
  });

  it('creates the iroh key once, 0600, and reloads the same EndpointId', async () => {
    const path = join(dir, 'endpoint-key');
    const first = await HostKey.loadOrCreate(path);
    expect(mode(path)).toBe(0o600);
    expect(first.endpointId).toMatch(/^[0-9a-f]{64}$/);
    const second = await HostKey.loadOrCreate(path);
    expect(second.endpointId).toBe(first.endpointId);
  });

  it('appends the audit log as 0600', async () => {
    const path = join(dir, 'audit.jsonl');
    const audit = new FileAudit(path, systemClock);
    audit.record({ event: 'test', requestId: 'trace_1' });
    await audit.flush();
    expect(mode(path)).toBe(0o600);
  });
});
