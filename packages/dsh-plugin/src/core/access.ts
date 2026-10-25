import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** The person Cloudflare Access authenticated, taken only from a verified assertion. */
export interface AccessIdentity {
  /** Stable Access user id; device grants bind to it. */
  readonly sub: string;
  readonly email: string;
  /** Assertion expiry, Unix seconds; WebSockets close when it passes. */
  readonly exp: number;
}

export type AccessResult = { readonly ok: true; readonly identity: AccessIdentity } | { readonly ok: false; readonly reason: AccessFailure };
export type AccessFailure = 'missing' | 'invalid' | 'service-token' | 'no-identity';

export interface AccessVerifier {
  verify(assertion: string | undefined): Promise<AccessResult>;
}

export interface AccessVerifierOptions {
  readonly issuer: string;
  readonly audiences: readonly string[];
  readonly keys: JWTVerifyGetKey;
  /** Allowed clock skew in seconds. */
  readonly clockToleranceSec?: number;
}

/**
 * Verify `Cf-Access-Jwt-Assertion`: RS256 only, exact issuer, one of the
 * configured AUD tags, live `exp`/`nbf`. Service-token assertions (empty `sub`
 * or a `common_name`) are refused because a phone is always a person.
 */
export function createAccessVerifier(options: AccessVerifierOptions): AccessVerifier {
  if (options.audiences.length === 0) throw new Error('access verifier: at least one audience is required');
  return {
    async verify(assertion) {
      if (assertion === undefined || assertion === '') return { ok: false, reason: 'missing' };
      if (assertion.length > 8192) return { ok: false, reason: 'invalid' };
      let payload;
      try {
        ({ payload } = await jwtVerify(assertion, options.keys, {
          issuer: options.issuer,
          audience: [...options.audiences],
          algorithms: ['RS256'],
          clockTolerance: options.clockToleranceSec ?? 30,
          requiredClaims: ['exp', 'iat', 'sub'],
        }));
      } catch {
        return { ok: false, reason: 'invalid' };
      }
      if ('common_name' in payload) return { ok: false, reason: 'service-token' };
      const { sub, email, exp } = payload as { sub?: unknown; email?: unknown; exp?: unknown };
      if (typeof sub !== 'string' || sub === '') return { ok: false, reason: 'service-token' };
      if (typeof email !== 'string' || email === '' || typeof exp !== 'number') return { ok: false, reason: 'no-identity' };
      return { ok: true, identity: { sub, email, exp } };
    },
  };
}

const TEAM_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const AUD_TAG = /^[a-f0-9]{64}$/;

/** The production verifier: issuer and JWKS come only from the Zero Trust team name. */
export function cloudflareAccessVerifier(teamName: string, audTags: readonly string[]): AccessVerifier {
  if (!TEAM_NAME.test(teamName)) throw new Error('access verifier: invalid Zero Trust team name');
  if (audTags.length === 0 || !audTags.every((tag) => AUD_TAG.test(tag))) throw new Error('access verifier: invalid AUD tag');
  const issuer = `https://${teamName}.cloudflareaccess.com`;
  return createAccessVerifier({ issuer, audiences: audTags, keys: createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)) });
}
