import type { ApprovalAnswerer, ApprovalOutcome } from './adapter.ts';
import type { Clock } from './clock.ts';
import type { EventHub } from './events.ts';
import { randomId } from './ids.ts';
import type { HostState } from './state.ts';
import { approvalIdFor, PREVIEW_LIMITS, truncate, wireOutcome } from './translate.ts';

export type ApprovalState = 'pending' | 'allowed_once' | 'denied' | 'cancelled' | 'unavailable';

/** Wire shape of one approval (schema `Approval`). */
export interface RemoteApproval {
  readonly approvalId: string;
  readonly sessionId: string;
  revision: number;
  readonly toolName: string;
  readonly reason?: string;
  readonly preview: { readonly text: string; readonly truncated: boolean };
  readonly requestedAt: number;
  state: ApprovalState;
  resolvedBy?: string;
}

interface Entry {
  readonly approval: RemoteApproval;
  /** First caller wins; later calls return false. Synchronous, so it is the compare-and-set. */
  settle(outcome: ApprovalOutcome, by: string): boolean;
}

export interface ApprovalsOptions {
  /** How long to keep waiting for a phone when no local answerer is available. */
  readonly remoteTimeoutMs: number;
  /** How long to wait for the `approval/asked` event so ids match the timeline. */
  readonly correlationWaitMs?: number;
}

/**
 * Remote answers for DSH tool approvals. DSH's own approval waterfall is
 * first-answer-wins with no revision, so the broker owns the revision and the
 * compare-and-set: whichever of the phone, the local DSH Web card, a timeout
 * or a cancelled turn settles first decides, and every later answer is stale.
 */
export class Approvals {
  private readonly pending = new Map<string, Entry>();
  /** Recently settled approvals, so a late answer is reported stale rather than unknown. */
  private readonly settled = new Map<string, RemoteApproval>();
  private readonly listeners = new Set<(approval: RemoteApproval) => void>();
  private readonly state: HostState;
  private readonly events: EventHub;
  private readonly clock: Clock;
  private readonly options: ApprovalsOptions;

  constructor(state: HostState, events: EventHub, clock: Clock, options: ApprovalsOptions) {
    this.state = state;
    this.events = events;
    this.clock = clock;
    this.options = options;
  }

  readonly answerer: ApprovalAnswerer = async (ask, chain) => {
    if (!this.state.isPublished(ask.sessionId)) return chain.next();
    const context = await this.correlate(ask.sessionId, ask.callId);
    const approvalId = context.dshApprovalId === undefined ? randomId('apr') : approvalIdFor(context.dshApprovalId);
    const detail = context.call === undefined ? (ask.reason ?? '') : `${context.call.name} ${context.call.args}`;
    const approval: RemoteApproval = {
      approvalId,
      sessionId: ask.sessionId,
      revision: 1,
      toolName: ask.toolName,
      ...(ask.reason === undefined ? {} : { reason: ask.reason }),
      preview: truncate(detail, PREVIEW_LIMITS.toolArgs),
      requestedAt: this.clock.now(),
      state: 'pending',
    };

    let finish!: (result: { outcome: ApprovalOutcome; by: string }) => void;
    const finished = new Promise<{ outcome: ApprovalOutcome; by: string }>((resolve) => (finish = resolve));
    const entry: Entry = {
      approval,
      settle: (outcome, by) => {
        if (approval.state !== 'pending') return false;
        approval.state = wireOutcome(outcome) as ApprovalState;
        approval.revision += 1;
        approval.resolvedBy = by;
        this.pending.delete(approvalId);
        this.settled.set(approvalId, approval);
        if (this.settled.size > 500) this.settled.delete(this.settled.keys().next().value!);
        this.notify(approval);
        finish({ outcome, by });
        return true;
      },
    };
    this.pending.set(approvalId, entry);
    this.notify(approval);

    const onAbort = () => entry.settle('cancelled', 'host');
    ask.signal?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    chain.next().then(
      (outcome) => {
        // No local answerer: keep the question open for the phone, then fail closed.
        if (outcome === 'unavailable') timer = setTimeout(() => entry.settle('unavailable', 'timeout'), this.options.remoteTimeoutMs);
        else entry.settle(outcome, 'local');
      },
      () => entry.settle('unavailable', 'local'),
    );
    if (ask.signal?.aborted) onAbort();

    const result = await finished;
    clearTimeout(timer);
    ask.signal?.removeEventListener('abort', onAbort);
    if (result.by.startsWith('device:')) chain.withdrawLocal();
    return result.outcome;
  };

  list(): RemoteApproval[] {
    return [...this.pending.values()].map((entry) => entry.approval).filter((approval) => this.state.isPublished(approval.sessionId));
  }

  pendingFor(sessionId: string): RemoteApproval[] {
    return this.list().filter((approval) => approval.sessionId === sessionId);
  }

  /** A phone's Allow once / Deny with compare-and-set on `expectedRevision`. */
  respond(approvalId: string, device: { deviceId: string; label: string }, decision: 'allow_once' | 'deny', expectedRevision: number): { ok: true; approval: RemoteApproval } | { ok: false; code: 'NOT_FOUND' | 'APPROVAL_STALE' } {
    const entry = this.pending.get(approvalId);
    if (entry === undefined || !this.state.isPublished(entry.approval.sessionId)) {
      return { ok: false, code: this.settled.has(approvalId) ? 'APPROVAL_STALE' : 'NOT_FOUND' };
    }
    if (entry.approval.revision !== expectedRevision) return { ok: false, code: 'APPROVAL_STALE' };
    const settled = entry.settle(decision === 'allow_once' ? 'allowed-once' : 'rejected', `device:${device.label}`);
    return settled ? { ok: true, approval: entry.approval } : { ok: false, code: 'APPROVAL_STALE' };
  }

  onChange(listener: (approval: RemoteApproval) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async correlate(sessionId: string, callId: string | undefined): Promise<ReturnType<EventHub['approvalContext']>> {
    // Real elapsed time, not the injectable clock: this only bounds an internal wait.
    const deadline = performance.now() + (this.options.correlationWaitMs ?? 300);
    for (;;) {
      const context = this.events.approvalContext(sessionId, callId);
      if (context.dshApprovalId !== undefined || callId === undefined || performance.now() >= deadline) return context;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private notify(approval: RemoteApproval): void {
    for (const listener of this.listeners) listener(approval);
  }
}
