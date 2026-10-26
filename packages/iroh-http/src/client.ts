import { request as httpRequest } from 'node:http';
import type { Connection, Endpoint, EndpointAddr } from '@number0/iroh';
import { PeerStream } from './stream.ts';

export interface HttpReply {
  readonly status: number;
  /** Parsed JSON, the raw text when it is not JSON, or undefined when empty. */
  readonly body: unknown;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DIAL_TIMEOUT_MS = 10_000;

/**
 * HTTP/1.1 to one iroh peer on one ALPN, one bi-stream per request. The QUIC
 * connection is dialed on first use and dialed again after it closes.
 */
export class IrohHttpClient {
  private readonly endpoint: Endpoint;
  private readonly addr: () => EndpointAddr;
  private readonly alpn: number[];
  private readonly timeoutMs: number;
  private connection: Promise<Connection> | undefined;

  constructor(endpoint: Endpoint, addr: () => EndpointAddr, alpn: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.endpoint = endpoint;
    this.addr = addr;
    this.alpn = Array.from(Buffer.from(alpn, 'utf8'));
    this.timeoutMs = timeoutMs;
  }

  async request(method: string, path: string, body?: unknown): Promise<HttpReply> {
    const stream = new PeerStream(await this.openBi());
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise<HttpReply>((resolve, reject) => {
      const req = httpRequest(
        {
          method,
          path,
          host: 'iroh',
          headers: { connection: 'close', ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(payload.length) }) },
          createConnection: () => stream as never,
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () => {
            stream.destroy();
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = text === '' ? undefined : text;
            try {
              if (text !== '') parsed = JSON.parse(text);
            } catch {
              // Not JSON: keep the text.
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('request timed out')));
      req.on('error', (error) => {
        stream.destroy();
        reject(error);
      });
      req.end(payload);
    });
  }

  close(): void {
    const connection = this.connection;
    this.connection = undefined;
    void connection?.then((live) => live.close(0n, [])).catch(() => {});
  }

  /** A bi-stream on the live connection; one fresh dial when that connection is gone. */
  private async openBi() {
    for (let attempt = 0; ; attempt += 1) {
      const connection = await this.connect();
      try {
        return await connection.openBi();
      } catch (error) {
        this.drop(connection);
        if (attempt > 0) throw error;
      }
    }
  }

  private async connect(): Promise<Connection> {
    const current = this.connection;
    if (current !== undefined) {
      const live = await current.catch(() => undefined);
      if (live !== undefined && live.closeReason() === null) return live;
      if (this.connection === current) this.connection = undefined;
    }
    if (this.connection === undefined) {
      const dial = withTimeout(this.endpoint.connect(this.addr(), this.alpn), DIAL_TIMEOUT_MS, 'dial timed out');
      this.connection = dial;
      dial.catch(() => {
        if (this.connection === dial) this.connection = undefined;
      });
    }
    return this.connection;
  }

  private drop(connection: Connection): void {
    void this.connection?.then((live) => {
      if (live === connection) this.connection = undefined;
    }, () => {});
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error(message)), ms))),
  ]);
}
