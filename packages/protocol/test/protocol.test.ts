import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalRequestString,
  decodeBase64Url,
  EMPTY_BODY_SHA256,
  ERRORS,
  errorEnvelope,
  importP256PublicKey,
  isValid,
  parseTimestamp,
  schema,
  shortFingerprint,
  type ErrorCode,
} from '../src/index.ts';

const base = { method: 'GET', target: '/v1/meta', bodySha256Hex: EMPTY_BODY_SHA256, timestampMs: 1, nonce: 'AAAAAAAAAAAAAAAAAAAAAA' };

describe('canonicalRequestString', () => {
  it.each([
    ['lowercase method', { method: 'get' }],
    ['absolute-form target', { target: 'https://x/v1/meta' }],
    ['target with a newline', { target: '/v1/meta\nX' }],
    ['target with a space', { target: '/v1/ meta' }],
    ['uppercase hex body hash', { bodySha256Hex: EMPTY_BODY_SHA256.toUpperCase() }],
    ['short nonce', { nonce: 'AAAA' }],
    ['nonce with padding', { nonce: 'AAAAAAAAAAAAAAAAAAAAAA==' }],
    ['negative timestamp', { timestampMs: -1 }],
    ['fractional timestamp', { timestampMs: 1.5 }],
  ])('refuses a %s', (_label, change) => {
    expect(() => canonicalRequestString({ ...base, ...change })).toThrow();
  });
});

describe('parseTimestamp', () => {
  it('accepts plain decimal integers only', () => {
    expect(parseTimestamp('1792900000000')).toBe(1792900000000);
    expect(parseTimestamp('0')).toBe(0);
    for (const text of ['', '01', '+1', '-1', '1e3', '1.0', ' 1', '0x10', '99999999999999999']) {
      expect(parseTimestamp(text)).toBeUndefined();
    }
  });
});

describe('keys', () => {
  it('accepts only canonical base64url', () => {
    expect(decodeBase64Url('AQID')?.toString('hex')).toBe('010203');
    expect(decodeBase64Url('AQID=')).toBeUndefined();
    expect(decodeBase64Url('AQI+')).toBeUndefined();
    expect(decodeBase64Url('AQJ')).toBeUndefined();
  });

  it('rejects keys that are not P-256', () => {
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ format: 'der', type: 'spki' });
    const ed = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
    expect(importP256PublicKey(p384.toString('base64url'))).toBeUndefined();
    expect(importP256PublicKey(ed.toString('base64url'))).toBeUndefined();
    expect(importP256PublicKey('AAAA')).toBeUndefined();
  });

  it('formats a short fingerprint for people', () => {
    expect(shortFingerprint('0123456789abcdef'.repeat(4))).toBe('0123 4567 89ab cdef');
  });
});

describe('errors', () => {
  it('covers exactly the schema error codes', () => {
    const schemaCodes = (schema.$defs.errorCode as { enum: string[] }).enum.sort();
    expect(Object.keys(ERRORS).sort()).toEqual(schemaCodes);
  });

  it('builds envelopes the schema accepts', () => {
    for (const code of Object.keys(ERRORS) as ErrorCode[]) {
      expect(isValid('ErrorEnvelope', errorEnvelope(code, 'x', 'trace_1'))).toBe(true);
    }
    expect(errorEnvelope('TIMESTAMP_SKEW', 'clock', 'trace_1', { serverTime: 5 }).error).toMatchObject({ retryable: true, serverTime: 5 });
  });
});

describe('schema: client bodies are closed', () => {
  it('validates prompt requests', () => {
    expect(isValid('PromptRequest', { clientRequestId: 'req_d0af36', text: 'hi' })).toBe(true);
    expect(isValid('PromptRequest', { clientRequestId: 'req_d0af36', text: '' })).toBe(false);
    expect(isValid('PromptRequest', { clientRequestId: 'req_d0af36', text: 'hi', extra: 1 })).toBe(false);
    expect(isValid('PromptRequest', { clientRequestId: 'a b', text: 'hi' })).toBe(false);
    expect(isValid('PromptRequest', { clientRequestId: 'req_d0af36', text: 'x'.repeat(16385) })).toBe(false);
  });

  it('validates approval responses', () => {
    expect(isValid('ApprovalResponseRequest', { decision: 'allow_once', expectedRevision: 1 })).toBe(true);
    expect(isValid('ApprovalResponseRequest', { decision: 'allow_always', expectedRevision: 1 })).toBe(false);
    expect(isValid('ApprovalResponseRequest', { decision: 'deny', expectedRevision: 0 })).toBe(false);
  });

  it('validates client frames', () => {
    expect(isValid('ClientFrame', { op: 'subscribe', sessionId: 's1' })).toBe(true);
    expect(isValid('ClientFrame', { op: 'subscribe', sessionId: 's1', after: 'c1.eyJzIjoiczEiLCJxIjozfQ' })).toBe(true);
    expect(isValid('ClientFrame', { op: 'subscribe', sessionId: 's1', after: 'nope' })).toBe(false);
    expect(isValid('ClientFrame', { op: 'ping' })).toBe(true);
    expect(isValid('ClientFrame', { op: 'prompt', sessionId: 's1' })).toBe(false);
  });

  it('validates pair redeem requests', () => {
    const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
    const body = { challengeId: `chl_${'a'.repeat(24)}`, publicKey, deviceLabel: 'Pixel 9', platform: 'android', hardwareBacked: true };
    expect(isValid('PairRedeemRequest', body)).toBe(true);
    expect(isValid('PairRedeemRequest', { ...body, deviceLabel: 'bad\nlabel' })).toBe(false);
    expect(isValid('PairRedeemRequest', { ...body, platform: 'windows' })).toBe(false);
  });

  it('validates push registrations and gateway requests', () => {
    const events = { approval: true, turnFinished: false, turnFailed: false };
    const registration = { gateway: 'a'.repeat(64), handle: 'A'.repeat(22), key: 'B'.repeat(43), platform: 'fcm', events };
    expect(isValid('PushRegistrationRequest', registration)).toBe(true);
    expect(isValid('PushRegistrationRequest', { ...registration, key: 'B'.repeat(42) })).toBe(false);
    expect(isValid('PushRegistrationRequest', { ...registration, events: { approval: true } })).toBe(false);
    expect(isValid('PushRegistrationRequest', { ...registration, extra: 1 })).toBe(false);
    const handle = { platform: 'apns', token: 'a1b2c3d4e5f6', apnsEnvironment: 'sandbox', host: 'a'.repeat(64) };
    expect(isValid('GatewayHandleRequest', handle)).toBe(true);
    expect(isValid('GatewayHandleRequest', { ...handle, token: 'has space' })).toBe(false);
    expect(isValid('GatewayHandleRequest', { ...handle, apnsEnvironment: 'staging' })).toBe(false);
    const push = { handle: 'A'.repeat(22), envelope: 'C'.repeat(400), urgency: 'high', collapseId: 'apr_1' };
    expect(isValid('GatewayPushRequest', push)).toBe(true);
    expect(isValid('GatewayPushRequest', { ...push, envelope: 'C'.repeat(3073) })).toBe(false);
    expect(isValid('GatewayPushRequest', { ...push, urgency: 'urgent' })).toBe(false);
  });
});

describe('schema: host frames are open', () => {
  it('accepts unknown fields and kinds on server frames', () => {
    expect(isValid('ServerFrame', { v: 1, type: 'control', kind: 'heartbeat', payload: {}, extra: true })).toBe(true);
    expect(isValid('ServerFrame', { v: 1, type: 'session.event', sessionId: 's1', eventId: 'e_3', seq: 3, kind: 'future.kind', at: 1, payload: {} })).toBe(true);
    expect(isValid('ServerFrame', { v: 2, type: 'control', kind: 'heartbeat', payload: {} })).toBe(false);
  });
});
