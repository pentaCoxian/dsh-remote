import type { SessionAdapter } from '../core/adapter.ts';
import type { RemoteHost } from '../host.ts';

/** Owner operations. Reachable only from the DSH Web owner (`/api`) and the 0600 admin socket. */
export type AdminRequest =
  | { readonly method: 'status' }
  | { readonly method: 'offerPairing'; readonly sessionId?: string }
  | { readonly method: 'pendingPairings' }
  | { readonly method: 'decidePairing'; readonly pairingRequestId: string; readonly decision: 'approve' | 'deny' }
  | { readonly method: 'devices' }
  | { readonly method: 'revokeDevice'; readonly deviceId: string }
  | { readonly method: 'publish'; readonly sessionId: string }
  | { readonly method: 'unpublish'; readonly sessionId: string }
  | { readonly method: 'sessions' };

export class AdminError extends Error {
  override readonly name = 'AdminError';
}

const ID = /^[\x21-\x7e]{1,200}$/;

function requireId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new AdminError(`${name} is required`);
  return value;
}

/** Parse an untrusted request object (from the socket or a fetch body). */
export function parseAdminRequest(value: unknown): AdminRequest {
  const input = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  switch (input.method) {
    case 'status':
    case 'pendingPairings':
    case 'devices':
    case 'sessions':
      return { method: input.method };
    case 'offerPairing':
      return input.sessionId === undefined ? { method: 'offerPairing' } : { method: 'offerPairing', sessionId: requireId(input.sessionId, 'sessionId') };
    case 'decidePairing':
      if (input.decision !== 'approve' && input.decision !== 'deny') throw new AdminError('decision must be approve or deny');
      return { method: 'decidePairing', pairingRequestId: requireId(input.pairingRequestId, 'pairingRequestId'), decision: input.decision };
    case 'revokeDevice':
      return { method: 'revokeDevice', deviceId: requireId(input.deviceId, 'deviceId') };
    case 'publish':
    case 'unpublish':
      return { method: input.method, sessionId: requireId(input.sessionId, 'sessionId') };
    default:
      throw new AdminError('unknown method');
  }
}

export async function runAdmin(host: RemoteHost, adapter: SessionAdapter, request: AdminRequest): Promise<unknown> {
  switch (request.method) {
    case 'status':
      return host.status();
    case 'offerPairing':
      if (request.sessionId !== undefined) await host.publish(request.sessionId);
      return host.offerPairing(request.sessionId);
    case 'pendingPairings':
      return host.pendingPairings();
    case 'decidePairing':
      if (request.decision === 'deny') return { denied: host.denyPairing(request.pairingRequestId) };
      return { device: (await host.approvePairing(request.pairingRequestId)) ?? null };
    case 'devices':
      return host.devices();
    case 'revokeDevice':
      return { revoked: await host.revokeDevice(request.deviceId) };
    case 'publish':
      return { changed: await host.publish(request.sessionId) };
    case 'unpublish':
      return { changed: await host.unpublish(request.sessionId) };
    case 'sessions': {
      const sessions = await adapter.listSessions(AbortSignal.timeout(5_000));
      return sessions.map((s) => ({ sessionId: s.sessionId, title: s.title, running: s.running, published: host.isPublished(s.sessionId), updatedAt: s.updatedAt }));
    }
  }
}
