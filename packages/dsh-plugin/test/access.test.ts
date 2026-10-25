import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { cloudflareAccessVerifier } from '../src/core/access.ts';
import { testIssuer, unsignedAssertion, type TestIssuer } from './helpers/access.ts';

let issuer: TestIssuer;
beforeAll(async () => {
  issuer = await testIssuer();
});

describe('Access assertion verification', () => {
  it('accepts a valid application assertion and extracts the identity', async () => {
    const result = await issuer.verifier.verify(await issuer.assertion());
    expect(result).toMatchObject({ ok: true, identity: { sub: 'user-0001', email: 'owner@example.com' } });
  });

  it('refuses a missing assertion', async () => {
    expect(await issuer.verifier.verify(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(await issuer.verifier.verify('')).toEqual({ ok: false, reason: 'missing' });
  });

  it.each([
    ['wrong audience', {}, { audience: 'b'.repeat(64) }],
    ['wrong issuer', {}, { issuer: 'https://evil.cloudflareaccess.com' }],
    ['expired', {}, { expiresInSec: -120 }],
    ['not yet valid', {}, { notBeforeSec: 600 }],
    ['unknown kid', {}, { kid: 'k2' }],
    ['foreign key under a known kid', {}, { foreignKey: true }],
    ['missing exp', { exp: undefined }, {}],
    ['missing sub', { sub: undefined }, {}],
  ] as const)('refuses an assertion with %s', async (_label, claims, options) => {
    const result = await issuer.verifier.verify(await issuer.assertion(claims, options));
    expect(result.ok).toBe(false);
  });

  it('refuses alg none', async () => {
    expect(await issuer.verifier.verify(unsignedAssertion(issuer))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses an HS256 token (algorithm confusion)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: 'user-0001', email: 'owner@example.com', iss: issuer.issuer, aud: [issuer.audience], iat: now, exp: now + 300 })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .sign(new TextEncoder().encode('x'.repeat(32)));
    expect(await issuer.verifier.verify(token)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses service-token assertions', async () => {
    expect(await issuer.verifier.verify(await issuer.assertion({ sub: '', common_name: 'client.access' }))).toMatchObject({ ok: false });
    expect(await issuer.verifier.verify(await issuer.assertion({ common_name: 'client.access' }))).toEqual({ ok: false, reason: 'service-token' });
  });

  it('refuses an assertion without an email', async () => {
    expect(await issuer.verifier.verify(await issuer.assertion({ email: undefined }))).toEqual({ ok: false, reason: 'no-identity' });
  });

  it('refuses oversized input without parsing it', async () => {
    expect(await issuer.verifier.verify('a'.repeat(9000))).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('production verifier configuration', () => {
  it('derives everything from the team name and validates inputs', () => {
    expect(() => cloudflareAccessVerifier('myteam', ['a'.repeat(64)])).not.toThrow();
    expect(() => cloudflareAccessVerifier('https://evil.example', ['a'.repeat(64)])).toThrow();
    expect(() => cloudflareAccessVerifier('myteam', [])).toThrow();
    expect(() => cloudflareAccessVerifier('myteam', ['not-an-aud'])).toThrow();
  });
});
