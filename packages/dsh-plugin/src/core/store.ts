import { randomBytes } from 'node:crypto';
import { constants, mkdirSync, statSync } from 'node:fs';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Durable JSON document. Writes are serialized and atomic. */
export interface DocumentStore<T> {
  read(): Promise<T | undefined>;
  write(value: T): Promise<void>;
}

/**
 * Create `dir` (and parents) owner-only, and refuse a directory that group or
 * others can reach: everything under it is a credential or an audit trail.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mode = statSync(dir).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`dsh-remote: ${dir} must not be accessible to group or others (mode ${mode.toString(8)})`);
}

/**
 * Write `data` to `path` as an owner-only file: create a fresh temp file
 * (O_EXCL, 0600), fsync it, rename it over the target, then fsync the directory.
 */
export async function writePrivateFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  const dir = await open(dirname(path), constants.O_RDONLY);
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

export class JsonFileStore<T> implements DocumentStore<T> {
  private queue: Promise<void> = Promise.resolve();

  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async read(): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  write(value: T): Promise<void> {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    const next = this.queue.then(() => writePrivateFileAtomic(this.path, text));
    this.queue = next.catch(() => {});
    return next;
  }
}

export class MemoryStore<T> implements DocumentStore<T> {
  writes = 0;
  private value: T | undefined;

  constructor(value?: T) {
    this.value = value;
  }
  async read(): Promise<T | undefined> {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }
  async write(value: T): Promise<void> {
    this.writes += 1;
    this.value = structuredClone(value);
  }
}
