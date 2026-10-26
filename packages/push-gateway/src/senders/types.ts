import type { ApnsEnvironment } from '../store.ts';

/** What a sender needs to deliver one sealed notification. */
export interface OutboundPush {
  readonly token: string;
  readonly env: ApnsEnvironment | null;
  readonly handle: string;
  readonly host: string;
  readonly envelope: string;
  readonly urgency: 'high' | 'normal';
  readonly collapseId?: string;
}

export type SendOutcome =
  | { readonly ok: true }
  /** `gone`: the platform dropped the token; the handle is dead. */
  | { readonly ok: false; readonly gone: boolean; readonly reason: string };

export interface Sender {
  send(push: OutboundPush): Promise<SendOutcome>;
  close(): void;
}

/** How long APNs and FCM keep trying a phone that is offline. */
export const DELIVERY_TTL_SECONDS = 3600;

export const b64url = (value: unknown): string => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64url');
