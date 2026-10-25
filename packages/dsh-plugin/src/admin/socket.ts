import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { AdminError, parseAdminRequest, type AdminRequest } from './ops.ts';

const MAX_LINE = 64 * 1024;

/**
 * Newline-delimited JSON RPC on a Unix socket for the `dsh-remote` CLI. The
 * socket lives in the 0700 state directory and is itself 0600, so only the
 * owner's processes can approve pairings or revoke devices through it.
 */
export class AdminSocket {
  private readonly path: string;
  private readonly handle: (request: AdminRequest) => Promise<unknown>;
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();

  constructor(path: string, handle: (request: AdminRequest) => Promise<unknown>) {
    this.path = path;
    this.handle = handle;
  }

  async listen(): Promise<void> {
    removeStaleSocket(this.path);
    const server = createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(this.path, 0o600);
    this.server = server;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (this.server === undefined ? resolve() : this.server.close(() => resolve())));
    removeStaleSocket(this.path);
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) {
        socket.destroy();
        return;
      }
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void this.answer(socket, line);
      }
    });
  }

  private async answer(socket: Socket, line: string): Promise<void> {
    let id: unknown = null;
    try {
      const message = JSON.parse(line) as { id?: unknown };
      id = message.id ?? null;
      const result = await this.handle(parseAdminRequest(message));
      socket.write(`${JSON.stringify({ id, ok: true, result })}\n`);
    } catch (error) {
      const message = error instanceof AdminError || error instanceof SyntaxError ? error.message : 'internal error';
      socket.write(`${JSON.stringify({ id, ok: false, error: message })}\n`);
    }
  }
}

function removeStaleSocket(path: string): void {
  try {
    if (lstatSync(path).isSocket()) unlinkSync(path);
  } catch {
    // absent
  }
}

/** Client used by the CLI: one connection, sequential requests. */
export class AdminClient {
  private readonly socket: Socket;
  private buffer = '';
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (let newline = this.buffer.indexOf('\n'); newline >= 0; newline = this.buffer.indexOf('\n')) {
        const reply = JSON.parse(this.buffer.slice(0, newline)) as { id: number; ok: boolean; result?: unknown; error?: string };
        this.buffer = this.buffer.slice(newline + 1);
        const waiter = this.waiting.get(reply.id);
        this.waiting.delete(reply.id);
        if (reply.ok) waiter?.resolve(reply.result);
        else waiter?.reject(new Error(reply.error ?? 'request failed'));
      }
    });
    socket.on('close', () => {
      for (const waiter of this.waiting.values()) waiter.reject(new Error('DSH Remote closed the admin connection'));
      this.waiting.clear();
    });
  }

  static connect(path: string): Promise<AdminClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once('connect', () => resolve(new AdminClient(socket)));
      socket.once('error', reject);
    });
  }

  call<T = unknown>(request: AdminRequest): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.write(`${JSON.stringify({ id, ...request })}\n`);
    });
  }

  close(): void {
    this.socket.end();
  }
}
