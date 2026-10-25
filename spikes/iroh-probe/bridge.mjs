// "iroh as a pipe": every QUIC bi-stream carries one TCP connection to a
// loopback port, so the existing HTTP + WebSocket API rides through unchanged.
// The host is reached by its EndpointId (public key) alone: no URL, domain or
// open port, and QUIC authenticates that key, so relays only see ciphertext.
import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import iroh from '@number0/iroh';

const { Endpoint, EndpointAddr, EndpointId, RelayMode, SecretKey } = iroh;

export const ALPN = Array.from(Buffer.from('dsh-remote/http/1', 'utf8'));
const toBuffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));

async function streamToSocket(recv, socket) {
  try {
    for (;;) {
      const chunk = toBuffer(await recv.read(64 * 1024));
      if (chunk.length === 0) break;
      if (!socket.write(chunk)) await once(socket, 'drain');
    }
  } catch {
    // stream reset or connection lost
  } finally {
    socket.end();
  }
}

function socketToStream(socket, send) {
  let chain = Promise.resolve();
  socket.on('data', (data) => {
    socket.pause();
    chain = chain.then(() => send.writeAll(Array.from(data))).then(() => socket.resume(), () => socket.destroy());
  });
  socket.on('end', () => {
    chain = chain.then(() => send.finish()).catch(() => {});
  });
  socket.on('error', () => {
    chain = chain.then(() => send.reset(0n)).catch(() => {});
  });
}

function pipe(bi, socket) {
  socketToStream(socket, bi.send);
  void streamToSocket(bi.recv, socket);
}

async function bind({ secretKey, alpns, relay = true }) {
  const builder = Endpoint.builder();
  builder.applyN0();
  if (secretKey) builder.secretKey(secretKey);
  if (alpns) builder.alpns(alpns);
  if (!relay) builder.relayMode(RelayMode.disabled());
  return builder.bind();
}

/** Host side: accept connections and pipe each stream to 127.0.0.1:targetPort. */
export async function startHost({ targetPort, secretKey, relay = true, onConnection = () => {} }) {
  const endpoint = await bind({ secretKey, alpns: [ALPN], relay });
  void (async () => {
    for (;;) {
      const incoming = await endpoint.acceptNext().catch(() => null);
      if (!incoming) return;
      void (async () => {
        const connection = await (await incoming.accept()).connect();
        onConnection(connection);
        for (;;) {
          let bi;
          try {
            bi = await connection.acceptBi();
          } catch {
            return;
          }
          const socket = connect(targetPort, '127.0.0.1');
          socket.on('error', () => {});
          pipe(bi, socket);
        }
      })().catch(() => {});
    }
  })();
  return endpoint;
}

/** Phone side (stand-in): dial the host by id, expose it as a local TCP port. */
export async function startClient({ hostId, addr, relay = true }) {
  const endpoint = await bind({ relay });
  const started = performance.now();
  const connection = await endpoint.connect(addr ?? new EndpointAddr(EndpointId.fromString(hostId)), ALPN);
  const connectMs = Math.round(performance.now() - started);
  const server = createServer((socket) => {
    socket.on('error', () => {});
    connection.openBi().then((bi) => pipe(bi, socket), () => socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { endpoint, connection, connectMs, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

export function newSecretKey() {
  return SecretKey.generate().toBytes();
}
