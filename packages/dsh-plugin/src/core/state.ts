import type { Scope } from '@dsh-remote/protocol';
import type { Clock } from './clock.ts';
import { randomId } from './ids.ts';
import type { DocumentStore } from './store.ts';

export interface DeviceRecord {
  readonly deviceId: string;
  readonly label: string;
  readonly platform: 'android' | 'ios' | 'other';
  readonly hardwareBacked: boolean;
  /** base64url SPKI DER of the phone's P-256 key. */
  readonly publicKey: string;
  readonly fingerprint: string;
  /** Access identity the grant is bound to. */
  readonly accessSub: string;
  readonly accessEmail: string;
  readonly scopes: readonly Scope[];
  readonly createdAt: number;
  readonly expiresAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export interface Publication {
  readonly sessionId: string;
  readonly publishedAt: number;
}

export interface HostStateDocument {
  readonly version: 1;
  readonly hostId: string;
  devices: DeviceRecord[];
  published: Publication[];
}

type Listener<T> = (value: T) => void;

/**
 * Owner of `state.json`: the host id, device grants and published sessions.
 * Reads are synchronous from memory; every change is persisted before the
 * returned promise settles.
 */
export class HostState {
  private readonly revokedListeners = new Set<Listener<DeviceRecord>>();
  private readonly publicationListeners = new Set<Listener<{ sessionId: string; published: boolean }>>();
  private lastSeenFlush = 0;

  private readonly store: DocumentStore<HostStateDocument>;
  private readonly clock: Clock;
  private doc: HostStateDocument;

  private constructor(
    store: DocumentStore<HostStateDocument>,
    clock: Clock,
    doc: HostStateDocument,
  ) {
    this.store = store;
    this.clock = clock;
    this.doc = doc;
  }

  static async open(store: DocumentStore<HostStateDocument>, clock: Clock): Promise<HostState> {
    const existing = await store.read();
    if (existing !== undefined) {
      if (existing.version !== 1) throw new Error('dsh-remote: unsupported state.json version');
      return new HostState(store, clock, existing);
    }
    const doc: HostStateDocument = { version: 1, hostId: randomId('host'), devices: [], published: [] };
    await store.write(doc);
    return new HostState(store, clock, doc);
  }

  get hostId(): string {
    return this.doc.hostId;
  }

  device(deviceId: string): DeviceRecord | undefined {
    return this.doc.devices.find((device) => device.deviceId === deviceId);
  }

  devices(): readonly DeviceRecord[] {
    return this.doc.devices;
  }

  async addDevice(record: DeviceRecord): Promise<void> {
    if (this.device(record.deviceId) !== undefined) throw new Error('dsh-remote: duplicate device id');
    this.doc.devices.push(record);
    await this.store.write(this.doc);
  }

  /** Revoke a device and notify listeners (which close its sockets). */
  async revokeDevice(deviceId: string): Promise<boolean> {
    const device = this.device(deviceId);
    if (device === undefined || device.revokedAt !== null) return false;
    device.revokedAt = this.clock.now();
    await this.store.write(this.doc);
    for (const listener of this.revokedListeners) listener(device);
    return true;
  }

  /** Record activity; persisted at most once a minute so reads stay cheap. */
  touchDevice(deviceId: string): void {
    const device = this.device(deviceId);
    if (device === undefined) return;
    const now = this.clock.now();
    device.lastSeenAt = now;
    if (now - this.lastSeenFlush > 60_000) {
      this.lastSeenFlush = now;
      void this.store.write(this.doc).catch(() => {});
    }
  }

  onDeviceRevoked(listener: Listener<DeviceRecord>): () => void {
    this.revokedListeners.add(listener);
    return () => this.revokedListeners.delete(listener);
  }

  isPublished(sessionId: string): boolean {
    return this.doc.published.some((entry) => entry.sessionId === sessionId);
  }

  publications(): readonly Publication[] {
    return this.doc.published;
  }

  async setPublished(sessionId: string, published: boolean): Promise<boolean> {
    if (this.isPublished(sessionId) === published) return false;
    this.doc.published = published
      ? [...this.doc.published, { sessionId, publishedAt: this.clock.now() }]
      : this.doc.published.filter((entry) => entry.sessionId !== sessionId);
    await this.store.write(this.doc);
    for (const listener of this.publicationListeners) listener({ sessionId, published });
    return true;
  }

  onPublicationChanged(listener: Listener<{ sessionId: string; published: boolean }>): () => void {
    this.publicationListeners.add(listener);
    return () => this.publicationListeners.delete(listener);
  }
}
