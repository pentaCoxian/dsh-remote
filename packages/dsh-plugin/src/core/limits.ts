/**
 * Remembered nonces. Only requests whose signature already verified are
 * remembered, so the table grows with legitimate traffic only.
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  private readonly ttlMs: number;
  private readonly capacity: number;

  constructor(
    ttlMs: number,
    capacity: number = 50_000,
  ) {
    this.ttlMs = ttlMs;
    this.capacity = capacity;
  }

  /** @returns false when `key` was seen within the TTL or the table is full. */
  remember(key: string, now: number): boolean {
    if (this.seen.size >= this.capacity / 2) this.sweep(now);
    const expiresAt = this.seen.get(key);
    if (expiresAt !== undefined && expiresAt > now) return false;
    if (this.seen.size >= this.capacity) return false;
    this.seen.set(key, now + this.ttlMs);
    return true;
  }

  private sweep(now: number): void {
    for (const [key, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(key);
  }
}

/** Fixed-window counters, e.g. pairing attempts per Access principal. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  private readonly limit: number;
  private readonly windowMs: number;

  constructor(
    limit: number,
    windowMs: number,
  ) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Count one attempt; @returns false once `limit` attempts happened in the current window. */
  hit(key: string, now: number): boolean {
    const window = this.windows.get(key);
    if (window === undefined || now - window.start >= this.windowMs) {
      if (this.windows.size > 10_000) this.windows.clear();
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= this.limit;
  }
}
