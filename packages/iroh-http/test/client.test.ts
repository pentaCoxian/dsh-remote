import { createServer, type Server } from 'node:http';
import iroh from '@number0/iroh';
import type { Endpoint } from '@number0/iroh';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IrohHttpClient, PeerStream } from '../src/index.ts';

const { Endpoint: EndpointClass, RelayMode } = iroh;
const ALPN = 'test/http/1';

async function bind(alpns: string[] = []): Promise<Endpoint> {
  const builder = EndpointClass.builder();
  builder.applyMinimal();
  builder.relayMode(RelayMode.disabled());
  builder.alpns(alpns.map((alpn) => Array.from(Buffer.from(alpn, 'utf8'))));
  return builder.bind();
}

describe('IrohHttpClient', () => {
  let server: Endpoint;
  let client: Endpoint;
  let http: Server;
  const peers: string[] = [];

  beforeEach(async () => {
    server = await bind([ALPN]);
    client = await bind();
    http = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(req.url === '/missing' ? 404 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, url: req.url, body: body === '' ? null : JSON.parse(body) }));
      });
    });
    void (async () => {
      for (;;) {
        const incoming = await server.acceptNext().catch(() => null);
        if (incoming === null) return;
        void (async () => {
          const connection = await (await incoming.accept()).connect();
          peers.push(connection.remoteId().toString());
          try {
            for (;;) http.emit('connection', new PeerStream(await connection.acceptBi()));
          } catch {
            // closed
          }
        })().catch(() => {});
      }
    })();
  });

  afterEach(async () => {
    peers.length = 0;
    await client.close();
    await server.close();
  });

  it('sends JSON and reads the reply, one stream per request, on one connection', async () => {
    const http = new IrohHttpClient(client, () => server.addr(), ALPN);
    expect(await http.request('POST', '/v1/push', { handle: 'h', n: 1 })).toEqual({ status: 200, body: { method: 'POST', url: '/v1/push', body: { handle: 'h', n: 1 } } });
    expect(await http.request('GET', '/missing')).toEqual({ status: 404, body: { method: 'GET', url: '/missing', body: null } });
    expect(peers).toEqual([client.id().toString()]);
    http.close();
  });

  it('dials again after the connection closed', async () => {
    const http = new IrohHttpClient(client, () => server.addr(), ALPN);
    await http.request('GET', '/one');
    http.close();
    expect((await http.request('GET', '/two')).status).toBe(200);
    expect(peers).toHaveLength(2);
    http.close();
  });
});
