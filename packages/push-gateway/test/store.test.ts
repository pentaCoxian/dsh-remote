import { describe, expect, it } from 'vitest';
import { HandleStore } from '../src/store.ts';

const phone = 'p'.repeat(64);
const host = 'h'.repeat(64);

describe('HandleStore', () => {
  it('keeps one handle per phone and host, updating the token', () => {
    const store = HandleStore.open(':memory:');
    const first = store.upsert({ phone, host, platform: 'fcm', token: 'token-1', env: null }, 1);
    expect(first.created).toBe(true);
    expect(first.handle).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const again = store.upsert({ phone, host, platform: 'fcm', token: 'token-2', env: null }, 2);
    expect(again).toEqual({ handle: first.handle, created: false });
    expect(store.get(first.handle)).toMatchObject({ phone, host, platform: 'fcm', token: 'token-2', env: null, created: 1, used: 2 });
    expect(store.size()).toBe(1);
  });

  it('drops the old handle when a reinstalled app registers the same token for the same host', () => {
    const store = HandleStore.open(':memory:');
    const old = store.upsert({ phone, host, platform: 'apns', token: 'same-token', env: 'sandbox' }, 1);
    const otherHost = store.upsert({ phone, host: 'o'.repeat(64), platform: 'apns', token: 'same-token', env: 'sandbox' }, 1);
    const reinstalled = store.upsert({ phone: 'q'.repeat(64), host, platform: 'apns', token: 'same-token', env: 'sandbox' }, 2);
    expect(store.get(old.handle)).toBeUndefined();
    expect(store.get(otherHost.handle)).toBeDefined();
    expect(store.get(reinstalled.handle)).toBeDefined();
  });

  it('prunes handles idle since a cutoff', () => {
    const store = HandleStore.open(':memory:');
    const stale = store.upsert({ phone, host, platform: 'fcm', token: 'token-a', env: null }, 1);
    const fresh = store.upsert({ phone, host: 'o'.repeat(64), platform: 'fcm', token: 'token-b', env: null }, 1);
    store.touch(fresh.handle, 100);
    expect(store.prune(50)).toBe(1);
    expect(store.get(stale.handle)).toBeUndefined();
    expect(store.countForPhone(phone)).toBe(1);
  });
});
