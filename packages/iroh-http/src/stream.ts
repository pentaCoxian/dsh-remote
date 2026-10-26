import { Duplex } from 'node:stream';
import type { BiStream } from '@number0/iroh';

const READ_CHUNK = 64 * 1024;

/**
 * One QUIC bi-stream as the socket-like Duplex `node:http` expects. Half-open
 * like the sockets an http.Server normally gets, so the server decides when a
 * finished request side ends the response side.
 */
export class PeerStream extends Duplex {
  private reading = false;
  private timeoutMs = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly bi: BiStream;

  constructor(bi: BiStream) {
    super({ allowHalfOpen: true });
    this.bi = bi;
  }

  override _read(): void {
    if (this.reading) return;
    this.reading = true;
    void this.pump();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.touch();
    this.bi.send.writeAll(Array.from(chunk)).then(() => callback(), callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.bi.send.finish().then(() => callback(), callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    clearTimeout(this.timer);
    if (!this.writableFinished) void this.bi.send.reset(0n).catch(() => {});
    void this.bi.recv.stop(0n).catch(() => {});
    callback(error);
  }

  /** `net.Socket` idle timeout semantics, which http.Server uses for keep-alive. */
  setTimeout(ms: number, callback?: () => void): this {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.timeoutMs = ms;
    if (callback !== undefined) this.once('timeout', callback);
    if (ms > 0) {
      this.timer = setTimeout(() => this.emit('timeout'), ms);
      this.timer.unref();
    }
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  private touch(): void {
    if (this.timeoutMs > 0) this.timer?.refresh();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const chunk = await this.bi.recv.read(READ_CHUNK);
        if (this.destroyed) return;
        if (chunk.length === 0) {
          this.push(null);
          return;
        }
        this.touch();
        if (!this.push(Buffer.from(chunk))) {
          this.reading = false;
          return;
        }
      }
    } catch (error) {
      this.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
