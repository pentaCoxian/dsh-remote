/** Wire protocol major version carried in `X-DSH-Protocol` and every frame's `v`. */
export const PROTOCOL_VERSION = 1;
/** Minor version of the v1 contract this package implements (1: iroh transport, unsigned grants). */
export const PROTOCOL_MINOR = 1;

/** Request-proof headers (spec §5), lowercase as Node exposes them. */
export const HEADERS = {
  protocol: 'x-dsh-protocol',
  deviceId: 'x-dsh-device-id',
  timestamp: 'x-dsh-timestamp',
  nonce: 'x-dsh-nonce',
  signature: 'x-dsh-signature',
} as const;

/** Device id sent by a phone that has no grant yet (pair redeem and pair status). */
export const PENDING_DEVICE_ID = 'pending';

export const LIMITS = {
  /** Maximum request body in bytes. */
  maxBodyBytes: 64 * 1024,
  /** Maximum prompt text in UTF-8 bytes. */
  maxPromptBytes: 16 * 1024,
  /** Accepted distance between the signed timestamp and host time. */
  timestampWindowMs: 60_000,
  /** How long a nonce stays remembered; at least twice the timestamp window. */
  nonceTtlMs: 120_000,
  /** Lifetime of a pairing challenge shown as a QR code. */
  challengeTtlMs: 120_000,
  /** How long an idempotency receipt is kept. */
  receiptTtlMs: 24 * 60 * 60 * 1000,
  /** Server heartbeat interval on /v1/events. */
  heartbeatMs: 25_000,
} as const;

export const SCOPES = [
  'host:read',
  'workspace:read',
  'session:read',
  'session:write',
  'approval:read',
  'approval:respond',
] as const;
export type Scope = (typeof SCOPES)[number];

/** WebSocket close codes used by /v1/events. */
export const CLOSE_CODES = {
  hostRestarting: 1012,
  authExpired: 4401,
  deviceRevoked: 4403,
  leaseLost: 4409,
  protocolUnsupported: 4426,
} as const;
