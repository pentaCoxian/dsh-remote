import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import type { ApnsEnvironment } from '../store.ts';
import { b64url, DELIVERY_TTL_SECONDS, type OutboundPush, type Sender, type SendOutcome } from './types.ts';

export interface ApnsOptions {
  /** The `.p8` auth key (PKCS#8 PEM). */
  readonly key: string;
  readonly keyId: string;
  readonly teamId: string;
  /** The app's bundle id. */
  readonly topic: string;
  /** Tests point these at a local HTTP/2 server. */
  readonly origins?: Record<ApnsEnvironment, string>;
  readonly now?: () => number;
}

const ORIGINS: Record<ApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};
/** Apple wants provider tokens refreshed between 20 and 60 minutes. */
const TOKEN_REFRESH_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Tokens that will never work again, beyond a 410. */
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);

/**
 * APNs over HTTP/2 with token auth. The visible alert is a generic fallback:
 * `mutable-content` wakes the app's Notification Service Extension, which
 * decrypts `e` and replaces it.
 */
export class ApnsSender implements Sender {
  private readonly options: ApnsOptions;
  private readonly privateKey: KeyObject;
  private readonly origins: Record<ApnsEnvironment, string>;
  private readonly sessions = new Map<string, ClientHttp2Session>();
  private jwt: { token: string; at: number } | undefined;

  constructor(options: ApnsOptions) {
    this.options = options;
    this.privateKey = createPrivateKey(options.key);
    this.origins = options.origins ?? ORIGINS;
  }

  async send(push: OutboundPush): Promise<SendOutcome> {
    const origin = this.origins[push.env ?? 'production'];
    for (let attempt = 0; ; attempt += 1) {
      let reply: { status: number; reason: string };
      try {
        reply = await this.post(origin, push);
      } catch (error) {
        return { ok: false, gone: false, reason: error instanceof Error ? error.message : String(error) };
      }
      if (reply.status === 200) return { ok: true };
      if (reply.status === 403 && reply.reason === 'ExpiredProviderToken' && attempt === 0) {
        this.jwt = undefined;
        continue;
      }
      const gone = reply.status === 410 || DEAD_TOKEN_REASONS.has(reply.reason);
      return { ok: false, gone, reason: `${reply.status} ${reply.reason}` };
    }
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private providerToken(): string {
    const now = this.now();
    if (this.jwt === undefined || now - this.jwt.at >= TOKEN_REFRESH_MS) {
      const input = `${b64url({ alg: 'ES256', kid: this.options.keyId })}.${b64url({ iss: this.options.teamId, iat: Math.floor(now / 1000) })}`;
      const signature = sign('sha256', Buffer.from(input, 'utf8'), { key: this.privateKey, dsaEncoding: 'ieee-p1363' });
      this.jwt = { token: `${input}.${signature.toString('base64url')}`, at: now };
    }
    return this.jwt.token;
  }

  private session(origin: string): ClientHttp2Session {
    let session = this.sessions.get(origin);
    if (session === undefined || session.closed || session.destroyed) {
      session = connect(origin);
      const current = session;
      const forget = () => {
        if (this.sessions.get(origin) === current) this.sessions.delete(origin);
      };
      session.on('error', forget);
      session.on('goaway', forget);
      session.on('close', forget);
      session.unref();
      this.sessions.set(origin, session);
    }
    return session;
  }

  private post(origin: string, push: OutboundPush): Promise<{ status: number; reason: string }> {
    const high = push.urgency === 'high';
    const payload = JSON.stringify({
      aps: {
        alert: { title: 'DSH Remote', body: 'New activity' },
        'mutable-content': 1,
        'thread-id': createHash('sha256').update(push.host).digest('hex').slice(0, 16),
        ...(high ? { sound: 'default' } : {}),
      },
      h: push.handle,
      e: push.envelope,
    });
    return new Promise((resolve, reject) => {
      const request = this.session(origin).request({
        ':method': 'POST',
        ':path': `/3/device/${push.token}`,
        authorization: `bearer ${this.providerToken()}`,
        'apns-topic': this.options.topic,
        'apns-push-type': 'alert',
        'apns-priority': high ? '10' : '5',
        'apns-expiration': String(Math.floor(this.now() / 1000) + DELIVERY_TTL_SECONDS),
        ...(push.collapseId === undefined ? {} : { 'apns-collapse-id': push.collapseId }),
        'content-type': 'application/json',
      });
      let status = 0;
      const chunks: Buffer[] = [];
      request.setTimeout(REQUEST_TIMEOUT_MS, () => request.close(constants.NGHTTP2_CANCEL));
      request.on('response', (headers) => (status = Number(headers[':status'])));
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('error', reject);
      request.on('close', () => {
        if (status === 0) return reject(new Error('APNs did not answer'));
        let reason = '';
        try {
          reason = String((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: unknown }).reason ?? '');
        } catch {
          // 200 has no body.
        }
        resolve({ status, reason });
      });
      request.end(payload);
    });
  }
}
