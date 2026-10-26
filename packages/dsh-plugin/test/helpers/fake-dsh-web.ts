import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

/**
 * Stands in for DSH Web with its two gates (docs/dsh-adapter-findings.md A1):
 * the Host fence (loopback authorities on any port; Origin, when sent, must be
 * the same authority) and the launch-token → cookie exchange.
 */
export interface FakeDshWeb {
  readonly server: Server;
  readonly port: number;
  readonly token: string;
  /** Host header of every request, in order. */
  readonly hosts: string[];
  close(): Promise<void>;
}

export async function startFakeDshWeb(token = randomBytes(18).toString('base64url')): Promise<FakeDshWeb> {
  const hosts: string[] = [];
  const fenced = (req: IncomingMessage) => {
    const host = req.headers.host ?? '';
    const origin = req.headers.origin;
    return /^127\.0\.0\.1(:\d+)?$/.test(host) && (origin === undefined || origin === `http://${host}`);
  };
  const server = createServer((req, res) => {
    hosts.push(req.headers.host ?? '');
    if (!fenced(req)) return void res.writeHead(403).end('forbidden');
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.searchParams.get('token') === token) return void res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-test=owner; HttpOnly; SameSite=Strict; Path=/' }).end();
    if (req.headers.cookie !== 'dsh-auth-test=owner') return void res.writeHead(401).end('unauthorized');
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<title>DeepSeek Harness</title>${url.pathname}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port, token, hosts, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
