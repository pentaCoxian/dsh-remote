import { isValid } from '@dsh-remote/protocol';
import { describe, expect, it } from 'vitest';
import { parseHandleRequest, parsePushRequest } from '../src/validate.ts';

// The gateway checks bodies by hand (no schema file in the bundle); these
// samples hold it to the schema's GatewayHandleRequest and GatewayPushRequest.
const host = 'a'.repeat(64);
const handleSamples: unknown[] = [
  { platform: 'fcm', token: 'fcm-token:APA91b_x.y', host },
  { platform: 'apns', token: 'a1b2c3d4e5f6a7b8', apnsEnvironment: 'sandbox', host },
  { platform: 'apns', token: 'a1b2c3d4e5f6a7b8', apnsEnvironment: 'staging', host },
  { platform: 'webpush', token: 'a1b2c3d4e5f6a7b8', host },
  { platform: 'fcm', token: 'short', host },
  { platform: 'fcm', token: 'has space in it', host },
  { platform: 'fcm', token: 'x'.repeat(4097), host },
  { platform: 'fcm', token: 'a1b2c3d4e5f6a7b8', host: 'A'.repeat(64) },
  { platform: 'fcm', token: 'a1b2c3d4e5f6a7b8', host, extra: 1 },
  { platform: 'fcm', host },
  null,
  [],
  'fcm',
];
const pushSamples: unknown[] = [
  { handle: 'A'.repeat(22), envelope: 'C'.repeat(400), urgency: 'high' },
  { handle: 'A'.repeat(22), envelope: 'C'.repeat(400), urgency: 'normal', collapseId: 'apr_1-x' },
  { handle: 'A'.repeat(21), envelope: 'C'.repeat(400), urgency: 'high' },
  { handle: 'A'.repeat(22), envelope: 'C'.repeat(39), urgency: 'high' },
  { handle: 'A'.repeat(22), envelope: 'C'.repeat(3073), urgency: 'high' },
  { handle: 'A'.repeat(22), envelope: 'C+/='.repeat(20), urgency: 'high' },
  { handle: 'A'.repeat(22), envelope: 'C'.repeat(400), urgency: 'urgent' },
  { handle: 'A'.repeat(22), envelope: 'C'.repeat(400), urgency: 'high', collapseId: '' },
  { handle: 'A'.repeat(22), envelope: 'C'.repeat(400), urgency: 'high', collapseId: 'x'.repeat(65) },
  { handle: 'A'.repeat(22), envelope: 'C'.repeat(400), urgency: 'high', to: 'x' },
  {},
];

describe('hand-written validators match the schema', () => {
  it.each(handleSamples.map((sample) => [JSON.stringify(sample)?.slice(0, 80), sample]))('handle request %s', (_label, sample) => {
    expect(parseHandleRequest(sample) !== undefined).toBe(isValid('GatewayHandleRequest', sample));
  });
  it.each(pushSamples.map((sample) => [JSON.stringify(sample).slice(0, 80), sample]))('push request %s', (_label, sample) => {
    expect(parsePushRequest(sample) !== undefined).toBe(isValid('GatewayPushRequest', sample));
  });
});
