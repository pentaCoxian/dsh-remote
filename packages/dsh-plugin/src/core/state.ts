import type { PushEvents, PushPlatform, Scope } from '@dsh-remote/protocol';
import type { Clock } from './clock.ts';
import type { DocumentStore } from './store.ts';

export interface DeviceRecord {
  readonly deviceId: string;
  readonly label: string;
  readonly platform: 'android' | 'ios' | 'other';
  readonly hardwareBacked: boolean;
  /** base64url SPKI DER of the phone's P-256 key. */
  readonly publicKey: string;
  readonly fingerprint: string;
  /** iroh EndpointId of the phone install; the grant works only over a connection from it. */
  readonly peerId: string;
  readonly scopes: readonly Scope[];
  readonly createdAt: number;
  readonly expiresAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  /** Where and how to notify this device; absent until it registers (`PUT /v1/push`). */
  push?: PushRegistration;
  /** Until when its DSH Web window is open (`POST /v1/web/session`); stored, so a host restart keeps the tunnel. */
  webUntil?: number;
}

/** A device's notification route: its gateway handle and the key only it and this host hold. */
export interface PushRegistration {
  /** EndpointId of the push gateway that issued the handle. */
  readonly gateway: string;
  readonly handle: string;
  /** base64url of the device's 32-byte AES-256-GCM key for this host. */
  readonly key: string;
  readonly platform: PushPlatform;
  readonly events: PushEvents;
  readonly registeredAt: number;
}

export interface Publication {
  readonly sessionId: string;
  readonly publishedAt: number;
}

export interface HostStateDocument {
  readonly version: 2;
  devices: DeviceRecord[];
  published: Publication[];
}

/** Sprint 1 state: devices were bound to Cloudflare Access identities. */
interface HostStateDocumentV1 {
  readonly version: 1;
  readonly published: Publication[];
}

type Listener<T> = (value: T) => void;

/**
 * Owner of `state.json`: device grants and published sessions.
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

  /**
   * Open or create the document. A Sprint 1 (version 1) file keeps its
   * published sessions; its devices are dropped because they were bound to
   * Cloudflare Access identities, which nothing presents any more. Grants made
   * before push existed gain `push:register` when they already hold `web:open`,
   * which is owner-equivalent.
   */
  static async open(store: DocumentStore<HostStateDocument>, clock: Clock): Promise<HostState> {
    const existing = (await store.read()) as HostStateDocument | HostStateDocumentV1 | undefined;
    if (existing?.version === 2) {
      const stale = existing.devices.filter((device) => device.scopes.includes('web:open') && !device.scopes.includes('push:register'));
      if (stale.length > 0) {
        existing.devices = existing.devices.map((device) => (stale.includes(device) ? { ...device, scopes: [...device.scopes, 'push:register'] } : device));
        await store.write(existing);
      }
      return new HostState(store, clock, existing);
    }
    if (existing !== undefined && existing.version !== 1) throw new Error('dsh-remote: unsupported state.json version');
    const doc: HostStateDocument = { version: 2, devices: [], published: existing?.published ?? [] };
    await store.write(doc);
    return new HostState(store, clock, doc);
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

  /** Revoke a device and notify listeners (which close its sockets). Its push route and DSH Web window go with it. */
  async revokeDevice(deviceId: string): Promise<boolean> {
    const device = this.device(deviceId);
    if (device === undefined || device.revokedAt !== null) return false;
    device.revokedAt = this.clock.now();
    delete device.push;
    delete device.webUntil;
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

  /** Open a device's DSH Web window until `until`. */
  async setWebWindow(deviceId: string, until: number): Promise<void> {
    const device = this.device(deviceId);
    if (device === undefined) return;
    device.webUntil = until;
    await this.store.write(this.doc);
  }

  /** Set or clear (`undefined`) a device's push route. */
  async setPush(deviceId: string, push: PushRegistration | undefined): Promise<void> {
    const device = this.device(deviceId);
    if (device === undefined) return;
    if (push === undefined) delete device.push;
    else device.push = push;
    await this.store.write(this.doc);
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
