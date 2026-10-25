import { appendFile, rename, stat } from 'node:fs/promises';
import type { Clock } from './clock.ts';

/**
 * One audit line. Fields are deliberately narrow: ids, routes, status codes,
 * denial reasons and timings only — never tokens, prompts, transcripts,
 * tool output or file contents.
 */
export interface AuditEntry {
  readonly event: string;
  readonly requestId?: string;
  readonly deviceId?: string;
  readonly sessionId?: string;
  readonly route?: string;
  readonly status?: number;
  readonly code?: string;
  readonly latencyMs?: number;
  readonly detail?: string;
}

export interface Audit {
  record(entry: AuditEntry): void;
}

const MAX_BYTES = 10 * 1024 * 1024;

/** Append-only JSONL (0600), rotated once to `.1` at 10 MiB. */
export class FileAudit implements Audit {
  private queue: Promise<void> = Promise.resolve();

  private readonly path: string;
  private readonly clock: Clock;

  constructor(
    path: string,
    clock: Clock,
  ) {
    this.path = path;
    this.clock = clock;
  }

  record(entry: AuditEntry): void {
    const line = `${JSON.stringify({ at: new Date(this.clock.now()).toISOString(), ...entry })}\n`;
    this.queue = this.queue
      .then(async () => {
        const size = await stat(this.path).then((s) => s.size, () => 0);
        if (size > MAX_BYTES) await rename(this.path, `${this.path}.1`);
        await appendFile(this.path, line, { mode: 0o600 });
      })
      .catch(() => {});
  }

  flush(): Promise<void> {
    return this.queue;
  }
}

export class MemoryAudit implements Audit {
  readonly entries: AuditEntry[] = [];
  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }
}
