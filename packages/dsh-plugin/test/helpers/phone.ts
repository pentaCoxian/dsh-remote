import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { request, type IncomingMessage } from 'node:http';
import { canonicalRequestString, HEADERS, PENDING_DEVICE_ID, sha256Hex, spkiFingerprint } from '@dsh-remote/protocol';
import { isPeerId, type PeerIdentity } from '../../src/core/peer.ts';

/** Loopback test transport only: the peer a request claims to come from. Over iroh, QUIC supplies it. */
export const TEST_PEER_HEADER = 'x-dsh-test-peer';

export function testPeerIdentity(req: IncomingMessage): PeerIdentity | undefined {
  const value = req.headers[TEST_PEER_HEADER];
  return typeof value === 'string' && isPeerId(value) ? { peerId: value } : undefined;
}

export function randomPeerId(): string {
  return randomBytes(32).toString('hex');
}

export interface SignOptions {
  readonly timestampMs?: number;
  readonly nonce?: string;
  /** Sign this body hash instead of the real one. */
  readonly bodySha256Hex?: string;
  readonly deviceId?: string;
}

/** Plays the phone: an iroh peer id plus a software P-256 key that signs requests exactly like the app. */
export class TestPhone {
  readonly peerId = randomPeerId();
  readonly publicKey: string;
  readonly fingerprint: string;
  deviceId: string = PENDING_DEVICE_ID;
  private readonly privateKey: KeyObject;

  constructor() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
    this.privateKey = pair.privateKey;
    this.publicKey = spki.toString('base64url');
    this.fingerprint = spkiFingerprint(spki);
  }

  proofHeaders(method: string, target: string, body: Buffer, options: SignOptions = {}): Record<string, string> {
    const timestampMs = options.timestampMs ?? Date.now();
    const nonce = options.nonce ?? randomBytes(16).toString('base64url');
    const canonical = canonicalRequestString({ method, target, bodySha256Hex: options.bodySha256Hex ?? sha256Hex(body), timestampMs, nonce });
    return {
      [HEADERS.protocol]: '1',
      [HEADERS.deviceId]: options.deviceId ?? this.deviceId,
      [HEADERS.timestamp]: String(timestampMs),
      [HEADERS.nonce]: nonce,
      [HEADERS.signature]: sign('sha256', Buffer.from(canonical, 'utf8'), { key: this.privateKey, dsaEncoding: 'der' }).toString('base64url'),
    };
  }
}

export interface SendOptions {
  readonly method: string;
  readonly target: string;
  readonly body?: Buffer | string | object;
  /** Header map; arrays repeat a header. */
  readonly headers?: Record<string, string | string[]>;
  readonly host?: string;
}

export interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
  readonly json: any;
}

export function toBody(body: SendOptions['body']): Buffer {
  if (body === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
}

/** Raw HTTP so tests control duplicate headers (fetch cannot). */
export function send(port: number, options: SendOptions): Promise<Reply> {
  const body = toBody(options.body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method,
        path: options.target,
        setHost: false,
        headers: {
          host: options.host ?? 'dsh.example.com',
          ...(body.length > 0 ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
