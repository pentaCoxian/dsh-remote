import { PROTOCOL_VERSION } from './constants.ts';

interface ErrorSpec {
  readonly status: number;
  readonly retryable: boolean;
}

/** Every error code the host may return, with its HTTP status (spec §6). */
export const ERRORS = {
  BAD_REQUEST: { status: 400, retryable: false },
  UNAUTHENTICATED: { status: 401, retryable: false },
  SIGNATURE_INVALID: { status: 401, retryable: false },
  TIMESTAMP_SKEW: { status: 401, retryable: true },
  NONCE_REPLAYED: { status: 401, retryable: false },
  ACCESS_DENIED: { status: 403, retryable: false },
  DEVICE_UNPAIRED: { status: 403, retryable: false },
  DEVICE_REVOKED: { status: 403, retryable: false },
  SCOPE_DENIED: { status: 403, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  SESSION_NOT_PUBLISHED: { status: 404, retryable: false },
  CHALLENGE_INVALID: { status: 404, retryable: false },
  METHOD_NOT_ALLOWED: { status: 405, retryable: false },
  IDEMPOTENCY_CONFLICT: { status: 409, retryable: false },
  APPROVAL_STALE: { status: 409, retryable: false },
  LEASE_HELD: { status: 409, retryable: false },
  LEASE_REQUIRED: { status: 409, retryable: false },
  TURN_NOT_ACTIVE: { status: 409, retryable: false },
  /** Push gateway: the handle is unknown, or APNs/FCM dropped its device token. */
  HANDLE_GONE: { status: 410, retryable: false },
  PAYLOAD_TOO_LARGE: { status: 413, retryable: false },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, retryable: false },
  PROTOCOL_UNSUPPORTED: { status: 426, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  INTERNAL: { status: 500, retryable: false },
  UNAVAILABLE: { status: 503, retryable: true },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERRORS;

export interface ErrorEnvelope {
  readonly v: typeof PROTOCOL_VERSION;
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly retryable: boolean;
    readonly serverTime?: number;
  };
}

/**
 * Build an error body. `message` must be a fixed, user-safe sentence: never
 * echo request input, paths, tokens or prompt text into it.
 */
export function errorEnvelope(code: ErrorCode, message: string, requestId: string, extra: { serverTime?: number } = {}): ErrorEnvelope {
  return {
    v: PROTOCOL_VERSION,
    error: { code, message, requestId, retryable: ERRORS[code].retryable, ...extra },
  };
}
