/** Time source; tests substitute a controllable one. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Manually advanced clock for tests and the dev host. */
export class ManualClock implements Clock {
  private current: number;

  constructor(current: number = 1_792_900_000_000) {
    this.current = current;
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}
