/** Fixed-window counters per key: at most `limit` events per `windowMs`. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Count one event for `key`; false when the window is already full. */
  take(key: string, now: number): boolean {
    let window = this.windows.get(key);
    if (window === undefined || now - window.start >= this.windowMs) {
      if (this.windows.size > 100_000) this.sweep(now);
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= this.limit) return false;
    window.count += 1;
    return true;
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) if (now - window.start >= this.windowMs) this.windows.delete(key);
  }
}
