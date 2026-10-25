import { grantSigningString, importP256PublicKey, verifyP256Signature } from '@dsh-remote/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.ts';
import { HostIdentity } from '../src/core/host-identity.ts';
import { Pairing } from '../src/core/pairing.ts';
import { HostState } from '../src/core/state.ts';
import { MemoryStore } from '../src/core/store.ts';
import { startTestHost, type TestHost } from './helpers/host.ts';
import { TestPhone } from './helpers/phone.ts';

let host: TestHost;
beforeEach(async () => {
  host = await startTestHost();
});
afterEach(() => host.close());

function redeemBody(phone: TestPhone, challengeId: string) {
  return { challengeId, publicKey: phone.publicKey, deviceLabel: 'Pixel 9', platform: 'android', hardwareBacked: true };
}

describe('pairing over the native API', () => {
  it('pairs end to end and the phone can verify the host-signed grant', async () => {
    const phone = new TestPhone();
    const challenge = host.pairing.createChallenge('session-1');
    const redeem = await host.signed(phone, { method: 'POST', target: '/v1/pair/redeem', body: redeemBody(phone, challenge.challengeId) });
    expect(redeem.status).toBe(201);
    expect(redeem.json.hostKey.fingerprint).toBe(host.identity.fingerprint);

    const statusTarget = `/v1/pair/requests/${redeem.json.pairingRequestId}`;
    const pending = await host.signed(phone, { method: 'GET', target: statusTarget });
    expect(pending.json).toEqual({ state: 'pending' });
    expect(host.pairing.pending().map((r) => r.deviceLabel)).toEqual(['Pixel 9']);

    await host.pairing.approve(redeem.json.pairingRequestId);
    const approved = await host.signed(phone, { method: 'GET', target: statusTarget });
    expect(approved.json.state).toBe('approved');
    const { grant } = approved.json;
    expect(grant.deviceKeyFingerprint).toBe(phone.fingerprint);

    // What the app does: trust only the host key whose fingerprint the QR showed.
    const hostKey = importP256PublicKey(redeem.json.hostKey.publicKey)!;
    const qrFingerprint = host.identity.fingerprint;
    expect(hostKey.fingerprint).toBe(qrFingerprint);
    const signingString = grantSigningString({ ...grant, pairingRequestId: redeem.json.pairingRequestId });
    expect(verifyP256Signature(hostKey.key, signingString, grant.signature)).toBe(true);
  });

  it('uses a challenge once, even under parallel redemption', async () => {
    const challenge = host.pairing.createChallenge();
    const phones = [new TestPhone(), new TestPhone(), new TestPhone()];
    const replies = await Promise.all(
      phones.map((phone) => host.signed(phone, { method: 'POST', target: '/v1/pair/redeem', body: redeemBody(phone, challenge.challengeId) })),
    );
    expect(replies.map((r) => r.status).sort()).toEqual([201, 404, 404]);
    expect(replies.filter((r) => r.status === 404).every((r) => r.json.error.code === 'CHALLENGE_INVALID')).toBe(true);
  });

  it('requires proof of possession of the submitted key', async () => {
    const phone = new TestPhone();
    const impostor = new TestPhone();
    const challenge = host.pairing.createChallenge();
    const reply = await host.signed(impostor, { method: 'POST', target: '/v1/pair/redeem', body: redeemBody(phone, challenge.challengeId) });
    expect(reply.status).toBe(401);
    expect(reply.json.error.code).toBe('SIGNATURE_INVALID');
  });

  it('burns a challenge after three failed proofs', async () => {
    const phone = new TestPhone();
    const impostor = new TestPhone();
    const challenge = host.pairing.createChallenge();
    for (let i = 0; i < 3; i += 1) {
      await host.signed(impostor, { method: 'POST', target: '/v1/pair/redeem', body: redeemBody(phone, challenge.challengeId) });
    }
    const honest = await host.signed(phone, { method: 'POST', target: '/v1/pair/redeem', body: redeemBody(phone, challenge.challengeId) });
    expect(honest.json.error.code).toBe('CHALLENGE_INVALID');
  });

  it('rate-limits redemption per Access principal', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const phone = new TestPhone();
      statuses.push((await host.signed(phone, { method: 'POST', target: '/v1/pair/redeem', body: redeemBody(phone, `chl_${'x'.repeat(24)}`) })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('hides a pairing request from other principals', async () => {
    const phone = new TestPhone();
    const challenge = host.pairing.createChallenge();
    const redeem = await host.signed(phone, { method: 'POST', target: '/v1/pair/redeem', body: redeemBody(phone, challenge.challengeId) });
    const other = await host.signed(phone, { method: 'GET', target: `/v1/pair/requests/${redeem.json.pairingRequestId}`, sub: 'someone-else' });
    expect(other.status).toBe(404);
  });

  it('reports denial', async () => {
    const phone = new TestPhone();
    const challenge = host.pairing.createChallenge();
    const redeem = await host.signed(phone, { method: 'POST', target: '/v1/pair/redeem', body: redeemBody(phone, challenge.challengeId) });
    host.pairing.deny(redeem.json.pairingRequestId);
    const status = await host.signed(phone, { method: 'GET', target: `/v1/pair/requests/${redeem.json.pairingRequestId}` });
    expect(status.json).toEqual({ state: 'denied' });
    expect(await host.pairing.approve(redeem.json.pairingRequestId)).toBeUndefined();
  });

  it('offers no remote approval route', async () => {
    const phone = new TestPhone();
    for (const target of ['/v1/pair/approve', '/v1/pair/requests/pair_xxxxxxxxxxxxxxxxxxxxxxxx/approve']) {
      expect((await host.signed(phone, { method: 'POST', target, body: {} })).status).toBe(404);
    }
  });
});

describe('pairing lifetimes', () => {
  it('expires challenges after 120 s and unanswered requests after the approval window', async () => {
    const clock = new ManualClock();
    const state = await HostState.open(new MemoryStore(), clock);
    const pairing = new Pairing(state, HostIdentity.generate(), clock, { grantTtlMs: 1_000, approvalTtlMs: 60_000 });
    const phone = new TestPhone();
    const prove = () => ({ ok: true }) as const;
    const identity = { sub: 'user-0001', email: 'owner@example.com', exp: 0 };
    const body = (challengeId: string) => ({ challengeId, publicKey: phone.publicKey, deviceLabel: 'p', platform: 'ios' as const, hardwareBacked: true });

    const stale = pairing.createChallenge();
    clock.advance(120_000);
    expect(pairing.redeem(identity, body(stale.challengeId), prove)).toEqual({ ok: false, code: 'CHALLENGE_INVALID' });

    const fresh = pairing.createChallenge();
    const redeemed = pairing.redeem(identity, body(fresh.challengeId), prove);
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;
    clock.advance(60_000);
    expect(pairing.status(redeemed.request.pairingRequestId, identity, prove)).toEqual({ ok: true, state: 'expired' });
    expect(await pairing.approve(redeemed.request.pairingRequestId)).toBeUndefined();
    expect(pairing.pending()).toEqual([]);
  });
});
