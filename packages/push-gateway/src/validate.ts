import type { PushPlatform } from '@dsh-remote/protocol/push';
import type { ApnsEnvironment } from './store.ts';

// The schema's GatewayHandleRequest and GatewayPushRequest, checked by hand so the
// bundled gateway needs no schema file; test/validate.test.ts keeps them in step.
const ENDPOINT_ID = /^[0-9a-f]{64}$/;
const HANDLE = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9:_.-]{8,4096}$/;
const ENVELOPE = /^[A-Za-z0-9_-]{40,3072}$/;
const COLLAPSE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface HandleRequest {
  readonly platform: PushPlatform;
  readonly token: string;
  readonly apnsEnvironment?: ApnsEnvironment;
  readonly host: string;
}

export interface PushRequest {
  readonly handle: string;
  readonly envelope: string;
  readonly urgency: 'high' | 'normal';
  readonly collapseId?: string;
}

function object(value: unknown, required: readonly string[], optional: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!required.every((key) => keys.includes(key))) return undefined;
  if (!keys.every((key) => required.includes(key) || optional.includes(key))) return undefined;
  return record;
}

const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);

export function parseHandleRequest(value: unknown): HandleRequest | undefined {
  const body = object(value, ['platform', 'token', 'host'], ['apnsEnvironment']);
  if (body === undefined) return undefined;
  const { platform, token, host, apnsEnvironment } = body;
  if (platform !== 'apns' && platform !== 'fcm') return undefined;
  if (!matches(token, TOKEN) || !matches(host, ENDPOINT_ID)) return undefined;
  if (apnsEnvironment !== undefined && apnsEnvironment !== 'sandbox' && apnsEnvironment !== 'production') return undefined;
  return { platform, token, host, ...(apnsEnvironment === undefined ? {} : { apnsEnvironment }) };
}

export function parsePushRequest(value: unknown): PushRequest | undefined {
  const body = object(value, ['handle', 'envelope', 'urgency'], ['collapseId']);
  if (body === undefined) return undefined;
  const { handle, envelope, urgency, collapseId } = body;
  if (!matches(handle, HANDLE) || !matches(envelope, ENVELOPE)) return undefined;
  if (urgency !== 'high' && urgency !== 'normal') return undefined;
  if (collapseId !== undefined && !matches(collapseId, COLLAPSE_ID)) return undefined;
  return { handle, envelope, urgency, ...(collapseId === undefined ? {} : { collapseId }) };
}

export const isHandle = (value: string): boolean => HANDLE.test(value);
