import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { b64url, DELIVERY_TTL_SECONDS, type OutboundPush, type Sender, type SendOutcome } from './types.ts';

/** The fields of a Google service-account JSON key that FCM HTTP v1 needs. */
export interface ServiceAccount {
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri: string;
}

export interface FcmOptions {
  readonly serviceAccount: ServiceAccount;
  /** Tests point this at a local server. */
  readonly endpoint?: string;
  readonly now?: () => number;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const REQUEST_TIMEOUT_MS = 10_000;
/** FCM error codes that mean the token will never work again. */
const DEAD_TOKEN_CODES = new Set(['UNREGISTERED', 'SENDER_ID_MISMATCH']);

export function parseServiceAccount(json: string): ServiceAccount {
  const value = JSON.parse(json) as Partial<ServiceAccount>;
  for (const field of ['project_id', 'client_email', 'private_key', 'token_uri'] as const) {
    if (typeof value[field] !== 'string' || value[field] === '') throw new Error(`service account JSON has no ${field}`);
  }
  return value as ServiceAccount;
}

/**
 * FCM HTTP v1 with a service account: data-only messages, so the app's
 * FirebaseMessagingService decrypts `e` and posts the notification itself.
 */
export class FcmSender implements Sender {
  private readonly options: FcmOptions;
  private readonly privateKey: KeyObject;
  private readonly endpoint: string;
  private accessToken: { token: string; expires: number } | undefined;

  constructor(options: FcmOptions) {
    this.options = options;
    this.privateKey = createPrivateKey(options.serviceAccount.private_key);
    this.endpoint = options.endpoint ?? 'https://fcm.googleapis.com';
  }

  async send(push: OutboundPush): Promise<SendOutcome> {
    for (let attempt = 0; ; attempt += 1) {
      let reply: Response;
      try {
        reply = await fetch(`${this.endpoint}/v1/projects/${this.options.serviceAccount.project_id}/messages:send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: push.token,
              data: { h: push.handle, e: push.envelope },
              android: { priority: push.urgency === 'high' ? 'HIGH' : 'NORMAL', ttl: `${DELIVERY_TTL_SECONDS}s`, ...(push.collapseId === undefined ? {} : { collapse_key: push.collapseId }) },
            },
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        return { ok: false, gone: false, reason: error instanceof Error ? error.message : String(error) };
      }
      if (reply.ok) return { ok: true };
      if (reply.status === 401 && attempt === 0) {
        this.accessToken = undefined;
        continue;
      }
      const code = errorCode(await reply.json().catch(() => undefined));
      return { ok: false, gone: DEAD_TOKEN_CODES.has(code), reason: `${reply.status} ${code}` };
    }
  }

  close(): void {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** An OAuth access token from a self-signed service-account JWT, reused until 5 minutes before it expires. */
  private async token(): Promise<string> {
    const now = this.now();
    if (this.accessToken !== undefined && this.accessToken.expires - now > 5 * 60_000) return this.accessToken.token;
    const account = this.options.serviceAccount;
    const iat = Math.floor(now / 1000);
    const input = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iss: account.client_email, scope: SCOPE, aud: account.token_uri, iat, exp: iat + 3600 })}`;
    const assertion = `${input}.${sign('sha256', Buffer.from(input, 'utf8'), this.privateKey).toString('base64url')}`;
    const reply = await fetch(account.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await reply.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!reply.ok || typeof body.access_token !== 'string') throw new Error(`FCM token request failed (${reply.status})`);
    this.accessToken = { token: body.access_token, expires: now + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }
}

/** `FcmError.errorCode` from an FCM v1 error body, else the status name. */
function errorCode(body: unknown): string {
  const error = (body as { error?: { status?: string; details?: { '@type'?: string; errorCode?: string }[] } } | undefined)?.error;
  const detail = error?.details?.find((entry) => entry['@type']?.endsWith('google.firebase.fcm.v1.FcmError'));
  return detail?.errorCode ?? error?.status ?? 'UNKNOWN';
}
