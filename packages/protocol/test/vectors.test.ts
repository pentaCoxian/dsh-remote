import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalRequestString,
  decodeCursor,
  encodeCursor,
  grantSigningString,
  importP256PublicKey,
  parsePairingUrl,
  sha256Hex,
  verifyP256Signature,
  type GrantFields,
  type PairingPayload,
} from '../src/index.ts';

interface VectorKey {
  spki: string;
  fingerprint: string;
}
interface SigningVector {
  key: VectorKey;
  requests: { method: string; target: string; body: string; bodySha256Hex: string; timestampMs: number; nonce: string; canonical: string; signature: string }[];
}
interface GrantVector {
  hostKey: VectorKey;
  grant: GrantFields;
  signingString: string;
  signature: string;
}
interface CursorVector {
  valid: { sessionId: string; seq: number; cursor: string }[];
  invalid: string[];
}
interface PairingVector {
  valid: { url: string; payload: PairingPayload }[];
  invalid: string[];
}

function vector<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../../protocol/vectors/${name}.json`, import.meta.url), 'utf8')) as T;
}

describe('signing vectors', () => {
  const { key, requests } = vector<SigningVector>('signing');
  const imported = importP256PublicKey(key.spki);

  it('imports the vector key and reproduces its fingerprint', () => {
    expect(imported?.fingerprint).toBe(key.fingerprint);
  });

  for (const request of requests) {
    it(`${request.method} ${request.target}`, () => {
      expect(sha256Hex(Buffer.from(request.body, 'utf8'))).toBe(request.bodySha256Hex);
      const canonical = canonicalRequestString(request);
      expect(canonical).toBe(request.canonical);
      expect(canonical.endsWith('\n')).toBe(false);
      expect(verifyP256Signature(imported!.key, canonical, request.signature)).toBe(true);
    });
  }

  it('rejects a signature over any changed field', () => {
    const request = requests[2]!;
    const lastNonceChar = request.nonce.endsWith('A') ? 'B' : 'A';
    const changed = [
      { ...request, method: 'PUT' },
      { ...request, target: `${request.target}?x=1` },
      { ...request, bodySha256Hex: sha256Hex('{}') },
      { ...request, timestampMs: request.timestampMs + 1 },
      { ...request, nonce: `${request.nonce.slice(0, -1)}${lastNonceChar}` },
    ];
    for (const variant of changed) {
      expect(verifyP256Signature(imported!.key, canonicalRequestString(variant), request.signature)).toBe(false);
    }
  });
});

describe('grant vector', () => {
  const { hostKey, grant, signingString, signature } = vector<GrantVector>('grant');

  it('sorts scopes into the signing string and verifies', () => {
    expect(grantSigningString(grant)).toBe(signingString);
    expect(signingString.split('\n')[5]).toBe('approval:read,approval:respond,host:read,session:read,session:write,workspace:read');
    const key = importP256PublicKey(hostKey.spki)!;
    expect(key.fingerprint).toBe(hostKey.fingerprint);
    expect(verifyP256Signature(key.key, signingString, signature)).toBe(true);
    expect(verifyP256Signature(key.key, grantSigningString({ ...grant, deviceId: 'dev_SOMEoneELSEentirely1' }), signature)).toBe(false);
  });
});

describe('cursor vectors', () => {
  const { valid, invalid } = vector<CursorVector>('cursor');

  for (const value of valid) {
    it(`round-trips ${value.cursor}`, () => {
      expect(encodeCursor(value)).toBe(value.cursor);
      expect(decodeCursor(value.cursor)).toEqual({ sessionId: value.sessionId, seq: value.seq });
    });
  }

  for (const cursor of invalid) {
    it(`rejects ${JSON.stringify(cursor)}`, () => {
      expect(decodeCursor(cursor)).toBeUndefined();
    });
  }
});

describe('pairing vectors', () => {
  const { valid, invalid } = vector<PairingVector>('pairing');

  it('parses the QR URL back into its payload', () => {
    expect(parsePairingUrl(valid[0]!.url)).toEqual(valid[0]!.payload);
  });

  for (const url of invalid) {
    it(`rejects ${url}`, () => {
      expect(parsePairingUrl(url)).toBeUndefined();
    });
  }
});
