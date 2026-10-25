import type { Clock } from './clock.ts';

export interface LeaseHolder {
  readonly deviceId: string;
  readonly label: string;
  expiresAt: number;
}

export type LeaseChange = { readonly sessionId: string; readonly holder: LeaseHolder | null; readonly lost?: string };

/**
 * One mutating controller per session (spec §4). Any number of devices may
 * observe; prompts and cancels need the lease. A lease lapses after `ttlMs`
 * without activity; taking over notifies the previous holder. The local DSH
 * Web owner is never lease-gated.
 */
export class Leases {
  private readonly leases = new Map<string, LeaseHolder>();
  private readonly listeners = new Set<(change: LeaseChange) => void>();
  private readonly clock: Clock;
  private readonly ttlMs: number;

  constructor(clock: Clock, ttlMs = 120_000) {
    this.clock = clock;
    this.ttlMs = ttlMs;
  }

  holder(sessionId: string): LeaseHolder | null {
    const lease = this.leases.get(sessionId);
    if (lease === undefined) return null;
    if (lease.expiresAt <= this.clock.now()) {
      this.leases.delete(sessionId);
      return null;
    }
    return lease;
  }

  /** Acquire or renew; a different live holder blocks unless `takeover`. */
  acquire(sessionId: string, device: { deviceId: string; label: string }, takeover: boolean): { ok: true; holder: LeaseHolder } | { ok: false; holder: LeaseHolder } {
    const current = this.holder(sessionId);
    if (current !== null && current.deviceId !== device.deviceId && !takeover) return { ok: false, holder: current };
    const holder: LeaseHolder = { deviceId: device.deviceId, label: device.label, expiresAt: this.clock.now() + this.ttlMs };
    this.leases.set(sessionId, holder);
    const lost = current !== null && current.deviceId !== device.deviceId ? current.deviceId : undefined;
    this.emit({ sessionId, holder, ...(lost === undefined ? {} : { lost }) });
    return { ok: true, holder };
  }

  /** Renew the holder's lease after activity; no-op for anyone else. */
  touch(sessionId: string, deviceId: string): void {
    const current = this.holder(sessionId);
    if (current?.deviceId === deviceId) current.expiresAt = this.clock.now() + this.ttlMs;
  }

  release(sessionId: string, deviceId: string): boolean {
    if (this.holder(sessionId)?.deviceId !== deviceId) return false;
    this.leases.delete(sessionId);
    this.emit({ sessionId, holder: null });
    return true;
  }

  /** Drop every lease of a revoked device. */
  releaseDevice(deviceId: string): void {
    for (const [sessionId, holder] of [...this.leases]) if (holder.deviceId === deviceId) this.release(sessionId, holder.deviceId);
  }

  onChange(listener: (change: LeaseChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: LeaseChange): void {
    for (const listener of this.listeners) listener(change);
  }
}
