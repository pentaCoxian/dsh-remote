import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { createAccessVerifier, type AccessVerifier } from '../../src/core/access.ts';

export interface TestIssuer {
  readonly issuer: string;
  readonly audience: string;
  readonly verifier: AccessVerifier;
  /** A Cloudflare-shaped application assertion; `claims` override or delete (undefined) payload fields. */
  assertion(claims?: Record<string, unknown>, options?: AssertionOptions): Promise<string>;
}

export interface AssertionOptions {
  readonly issuer?: string;
  readonly audience?: string;
  readonly expiresInSec?: number;
  readonly notBeforeSec?: number;
  readonly kid?: string;
  /** Sign with a key the verifier does not know. */
  readonly foreignKey?: boolean;
}

export async function testIssuer(): Promise<TestIssuer> {
  const issuer = 'https://team.cloudflareaccess.com';
  const audience = 'a'.repeat(64);
  const known = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(known.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const verifier = createAccessVerifier({ issuer, audiences: [audience], keys: createLocalJWKSet({ keys: [jwk] }) });

  async function assertion(claims: Record<string, unknown> = {}, options: AssertionOptions = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload: JWTPayload = {
      sub: 'user-0001',
      email: 'owner@example.com',
      type: 'app',
      identity_nonce: 'nonce',
      country: 'JP',
      iat: now,
      nbf: now + (options.notBeforeSec ?? 0),
      exp: now + (options.expiresInSec ?? 300),
      iss: options.issuer ?? issuer,
      aud: [options.audience ?? audience],
    };
    for (const [key, value] of Object.entries(claims)) {
      if (value === undefined) delete payload[key];
      else payload[key] = value;
    }
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'k1' })
      .sign(options.foreignKey ? foreign.privateKey : known.privateKey);
  }

  return { issuer, audience, verifier, assertion };
}

/** An unsigned `alg: none` token with an otherwise valid payload. */
export function unsignedAssertion(issuer: TestIssuer): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', kid: 'k1' })}.${encode({ sub: 'user-0001', email: 'owner@example.com', iat: now, exp: now + 300, iss: issuer.issuer, aud: [issuer.audience] })}.`;
}
