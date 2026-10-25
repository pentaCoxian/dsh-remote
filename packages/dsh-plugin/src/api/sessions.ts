import { basename } from 'node:path';
import { LIMITS, sha256Hex } from '@dsh-remote/protocol';
import { AdapterRefusedError, type HostSession, type SessionAdapter } from '../core/adapter.ts';
import type { Approvals } from '../core/approvals.ts';
import type { Clock } from '../core/clock.ts';
import type { EventHub } from '../core/events.ts';
import { randomId } from '../core/ids.ts';
import type { Leases } from '../core/leases.ts';
import type { Receipt, Receipts } from '../core/receipts.ts';
import type { DeviceRecord, HostState } from '../core/state.ts';
import { ApiError, type Route } from '../http/server.ts';

export interface SessionDeps {
  readonly adapter: SessionAdapter;
  readonly state: HostState;
  readonly events: EventHub;
  readonly receipts: Receipts;
  readonly leases: Leases;
  readonly approvals: Approvals;
  readonly clock: Clock;
}

/** Workspaces are the sessions' working directories, shown by basename and keyed by a hash. */
export function workspaceOf(cwd: string | null): { workspaceId: string; name: string } {
  return { workspaceId: `ws_${sha256Hex(cwd ?? '').slice(0, 24)}`, name: cwd === null ? 'Workspace' : basename(cwd) || cwd };
}

const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{6,80}$/;
const SUBMIT_GRACE_MS = 60_000;

export function sessionRoutes(deps: SessionDeps): Route[] {
  const { adapter, state, events, receipts, leases, approvals, clock } = deps;
  let cache: { at: number; sessions: HostSession[] } | undefined;

  async function hostSessions(): Promise<HostSession[]> {
    if (cache !== undefined && clock.now() - cache.at < 2_000) return cache.sessions;
    try {
      const sessions = await adapter.listSessions(AbortSignal.timeout(5_000));
      cache = { at: clock.now(), sessions };
      return sessions;
    } catch {
      throw new ApiError('UNAVAILABLE');
    }
  }

  function published(sessionId: string | undefined): string {
    if (sessionId === undefined || !state.isPublished(sessionId)) throw new ApiError('SESSION_NOT_PUBLISHED');
    return sessionId;
  }

  function summary(sessionId: string, sessions: readonly HostSession[]) {
    const session = sessions.find((s) => s.sessionId === sessionId);
    const holder = leases.holder(sessionId);
    const needsApproval = approvals.pendingFor(sessionId).length > 0;
    const running = session?.running === true || events.activeTurn(sessionId) !== null;
    return {
      sessionId,
      workspaceId: workspaceOf(session?.cwd ?? null).workspaceId,
      title: session?.title ?? 'Untitled session',
      status: session === undefined ? 'unavailable' : needsApproval ? 'needs_approval' : running ? 'running' : 'idle',
      updatedAt: session?.updatedAt ?? state.publications().find((p) => p.sessionId === sessionId)?.publishedAt ?? 0,
      controller: holder === null ? null : { deviceId: holder.deviceId, label: holder.label },
    };
  }

  /** A `submitting` receipt the log never confirmed did not reach DSH. */
  function settleStale(receipt: Receipt): Receipt {
    if (receipt.state === 'submitting' && clock.now() - receipt.createdAt > SUBMIT_GRACE_MS) void receipts.advance(receipt.turnId, 'failed');
    return receipt;
  }

  const receiptBody = (r: Receipt) => ({ clientRequestId: r.clientRequestId, turnId: r.turnId, state: r.state });

  function requireLease(sessionId: string, device: DeviceRecord): void {
    const lease = leases.acquire(sessionId, { deviceId: device.deviceId, label: device.label }, false);
    if (!lease.ok) throw new ApiError('LEASE_HELD', 'Another device is controlling this session');
  }

  const leaseBody = (sessionId: string) => {
    const holder = leases.holder(sessionId);
    return { sessionId, holder: holder === null ? null : { deviceId: holder.deviceId, label: holder.label }, ...(holder === null ? {} : { expiresAt: holder.expiresAt }) };
  };

  return [
    {
      method: 'GET',
      path: '/v1/workspaces',
      auth: 'device',
      scope: 'workspace:read',
      async handle() {
        const sessions = await hostSessions();
        const byId = new Map<string, { workspaceId: string; name: string }>();
        for (const { sessionId } of state.publications()) {
          const workspace = workspaceOf(sessions.find((s) => s.sessionId === sessionId)?.cwd ?? null);
          byId.set(workspace.workspaceId, workspace);
        }
        return { status: 200, body: { items: [...byId.values()] } };
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions',
      auth: 'device',
      scope: 'session:read',
      async handle({ query }) {
        const sessions = await hostSessions();
        const workspaceId = query.get('workspaceId');
        const items = state
          .publications()
          .map(({ sessionId }) => summary(sessionId, sessions))
          .filter((item) => workspaceId === undefined || item.workspaceId === workspaceId)
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return { status: 200, body: { items } };
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId',
      auth: 'device',
      scope: 'session:read',
      async handle({ params }) {
        const sessionId = published(params.sessionId);
        const snapshot = events.snapshot(sessionId);
        if (snapshot === undefined) throw new ApiError('UNAVAILABLE');
        return {
          status: 200,
          body: {
            session: summary(sessionId, await hostSessions()),
            cursor: snapshot.cursor,
            hasMore: snapshot.hasMore,
            items: snapshot.items,
            ...(snapshot.activeTurn === null ? {} : { activeTurn: { turn: snapshot.activeTurn.turn, turnId: snapshot.activeTurn.turnId } }),
            ...(snapshot.partial === null ? {} : { partial: snapshot.partial }),
            pendingApprovals: approvals.pendingFor(sessionId),
          },
        };
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/prompts',
      auth: 'device',
      scope: 'session:write',
      body: 'PromptRequest',
      async handle({ params, body, device }) {
        const sessionId = published(params.sessionId);
        const { clientRequestId, text } = body as { clientRequestId: string; text: string };
        if (Buffer.byteLength(text, 'utf8') > LIMITS.maxPromptBytes) throw new ApiError('PAYLOAD_TOO_LARGE');
        const digest = sha256Hex(text);
        const existing = receipts.get(device.deviceId, clientRequestId);
        if (existing !== undefined) {
          if (existing.sessionId !== sessionId || existing.textSha256 !== digest) throw new ApiError('IDEMPOTENCY_CONFLICT');
          return { status: 200, body: receiptBody(settleStale(existing)) };
        }
        requireLease(sessionId, device);
        const receipt = await receipts.create({ clientRequestId, deviceId: device.deviceId, sessionId, textSha256: digest, turnId: randomId('turn') });
        try {
          await adapter.prompt(device.deviceId, { sessionId, requestId: receipt.turnId, text }, AbortSignal.timeout(15_000));
          await receipts.advance(receipt.turnId, 'queued');
        } catch (error) {
          if (error instanceof AdapterRefusedError) {
            await receipts.advance(receipt.turnId, 'failed');
            throw new ApiError(error.reason === 'not-found' ? 'SESSION_NOT_PUBLISHED' : 'UNAVAILABLE');
          }
          // Outcome unknown: the receipt stays `submitting` until the DSH log confirms it.
          throw new ApiError('UNAVAILABLE');
        }
        leases.touch(sessionId, device.deviceId);
        return { status: 202, body: receiptBody(receipt) };
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/prompts/:clientRequestId',
      auth: 'device',
      scope: 'session:read',
      async handle({ params, device }) {
        const sessionId = published(params.sessionId);
        const id = params.clientRequestId!;
        const receipt = CLIENT_REQUEST_ID.test(id) ? receipts.get(device.deviceId, id) : undefined;
        if (receipt === undefined || receipt.sessionId !== sessionId) throw new ApiError('NOT_FOUND');
        return { status: 200, body: receiptBody(settleStale(receipt)) };
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/cancel',
      auth: 'device',
      scope: 'session:write',
      body: 'CancelRequest',
      async handle({ params, body, device }) {
        const sessionId = published(params.sessionId);
        const active = events.activeTurn(sessionId);
        if (active === null || active.turnId !== (body as { turnId: string }).turnId) throw new ApiError('TURN_NOT_ACTIVE');
        requireLease(sessionId, device);
        try {
          await adapter.cancel(device.deviceId, sessionId);
        } catch {
          throw new ApiError('UNAVAILABLE');
        }
        leases.touch(sessionId, device.deviceId);
        return { status: 202, body: { accepted: true, turnId: active.turnId } };
      },
    },
    {
      method: 'GET',
      path: '/v1/approvals',
      auth: 'device',
      scope: 'approval:read',
      async handle() {
        return { status: 200, body: { items: approvals.list() } };
      },
    },
    {
      method: 'POST',
      path: '/v1/approvals/:approvalId/responses',
      auth: 'device',
      scope: 'approval:respond',
      body: 'ApprovalResponseRequest',
      async handle({ params, body, device }) {
        const { decision, expectedRevision } = body as { decision: 'allow_once' | 'deny'; expectedRevision: number };
        const result = approvals.respond(params.approvalId!, device, decision, expectedRevision);
        if (!result.ok) throw new ApiError(result.code);
        return { status: 200, body: result.approval };
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/control-lease',
      auth: 'device',
      scope: 'session:write',
      body: 'LeaseRequest',
      async handle({ params, body, device }) {
        const sessionId = published(params.sessionId);
        const result = leases.acquire(sessionId, { deviceId: device.deviceId, label: device.label }, (body as { takeover?: boolean }).takeover === true);
        if (!result.ok) throw new ApiError('LEASE_HELD', 'Another device is controlling this session');
        return { status: 200, body: leaseBody(sessionId) };
      },
    },
    {
      method: 'DELETE',
      path: '/v1/sessions/:sessionId/control-lease',
      auth: 'device',
      scope: 'session:write',
      async handle({ params, device }) {
        const sessionId = published(params.sessionId);
        leases.release(sessionId, device.deviceId);
        return { status: 200, body: leaseBody(sessionId) };
      },
    },
  ];
}
