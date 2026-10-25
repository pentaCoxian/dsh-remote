import { createServer, type Server, type Socket } from 'node:net';
import iroh from '@number0/iroh';
import type { Connection, Endpoint } from '@number0/iroh';
import { ALPN, PeerStream } from '../../src/transport/iroh.ts';

const { Endpoint: EndpointClass, EndpointTicket, RelayMode, SecretKey } = iroh;

/**
 * The phone's transport in tests: an iroh endpoint that dials a host ticket and
 * exposes the connection as a loopback TCP port, one bi-stream per socket (what
 * the app's Rust pipe does over a Unix socket).
 */
export interface IrohDialer {
  readonly peerId: string;
  readonly endpoint: Endpoint;
  readonly connection: Connection;
  /** Loopback port that tunnels to the host. */
  readonly port: number;
  close(): Promise<void>;
}

export async function dialTicket(ticket: string, options: { secretKey?: number[]; relays?: string[] } = {}): Promise<IrohDialer> {
  const builder = EndpointClass.builder();
  builder.applyMinimal();
  // Default bind: a loopback-only socket could not reach a host's LAN addresses.
  builder.relayMode(options.relays === undefined ? RelayMode.disabled() : RelayMode.customFromUrls(options.relays));
  builder.secretKey(options.secretKey ?? SecretKey.generate().toBytes());
  const endpoint = await builder.bind();
  const connection = await endpoint.connect(EndpointTicket.fromString(ticket).endpointAddr(), Array.from(Buffer.from(ALPN, 'utf8')));
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    connection.openBi().then(
      (bi) => {
        const stream = new PeerStream(bi);
        stream.on('error', () => socket.destroy());
        socket.on('close', () => stream.destroy());
        socket.pipe(stream);
        stream.pipe(socket);
      },
      () => socket.destroy(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    peerId: endpoint.id().toString(),
    endpoint,
    connection,
    port,
    async close() {
      // Keep-alive sockets from the HTTP agent would hold server.close open.
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
      connection.close(0n, []);
      await endpoint.close();
    },
  };
}
