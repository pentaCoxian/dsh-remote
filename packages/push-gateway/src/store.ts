import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PushPlatform } from '@dsh-remote/protocol/push';

export type ApnsEnvironment = 'sandbox' | 'production';

/** One phone's delivery route for one host. */
export interface HandleRecord {
  readonly handle: string;
  /** iroh EndpointId of the phone install that registered it. */
  readonly phone: string;
  /** iroh EndpointId of the only host allowed to push to it. */
  readonly host: string;
  readonly platform: PushPlatform;
  readonly token: string;
  readonly env: ApnsEnvironment | null;
  readonly created: number;
  readonly used: number;
}

export interface Registration {
  readonly phone: string;
  readonly host: string;
  readonly platform: PushPlatform;
  readonly token: string;
  readonly env: ApnsEnvironment | null;
}

/** Handles in SQLite: one per (phone, host); re-registering keeps the handle and updates the token. */
export class HandleStore {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS handles (
        handle   TEXT PRIMARY KEY,
        phone    TEXT NOT NULL,
        host     TEXT NOT NULL,
        platform TEXT NOT NULL,
        token    TEXT NOT NULL,
        env      TEXT,
        created  INTEGER NOT NULL,
        used     INTEGER NOT NULL,
        UNIQUE (phone, host)
      );
      CREATE INDEX IF NOT EXISTS handles_token ON handles (token, host);
    `);
  }

  /** `path` is a file (its directory is created, private), or `:memory:` in tests. */
  static open(path: string): HandleStore {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    return new HandleStore(new DatabaseSync(path));
  }

  /**
   * Register or refresh. A reinstalled app has a new phone key but the same
   * token, so older handles for the same token and host are removed: that host
   * would otherwise notify the phone twice.
   */
  upsert(registration: Registration, now: number): { handle: string; created: boolean } {
    const existing = this.db.prepare('SELECT handle FROM handles WHERE phone = ? AND host = ?').get(registration.phone, registration.host) as { handle: string } | undefined;
    const handle = existing?.handle ?? randomBytes(16).toString('base64url');
    if (existing === undefined) {
      this.db
        .prepare('INSERT INTO handles (handle, phone, host, platform, token, env, created, used) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(handle, registration.phone, registration.host, registration.platform, registration.token, registration.env, now, now);
    } else {
      this.db.prepare('UPDATE handles SET platform = ?, token = ?, env = ?, used = ? WHERE handle = ?').run(registration.platform, registration.token, registration.env, now, handle);
    }
    this.db.prepare('DELETE FROM handles WHERE token = ? AND host = ? AND handle != ?').run(registration.token, registration.host, handle);
    return { handle, created: existing === undefined };
  }

  get(handle: string): HandleRecord | undefined {
    return this.db.prepare('SELECT * FROM handles WHERE handle = ?').get(handle) as HandleRecord | undefined;
  }

  countForPhone(phone: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM handles WHERE phone = ?').get(phone) as { n: number }).n;
  }

  touch(handle: string, now: number): void {
    this.db.prepare('UPDATE handles SET used = ? WHERE handle = ?').run(now, handle);
  }

  delete(handle: string): boolean {
    return this.db.prepare('DELETE FROM handles WHERE handle = ?').run(handle).changes > 0;
  }

  /** Drop handles nobody used since `before`; returns how many. */
  prune(before: number): number {
    return Number(this.db.prepare('DELETE FROM handles WHERE used < ?').run(before).changes);
  }

  size(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM handles').get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
