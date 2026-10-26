import {
  AdapterRefusedError,
  AdapterUncertainError,
  type ApprovalAnswerer,
  type ApprovalOutcome,
  type FollowFrame,
  type HostSession,
  type PromptSubmission,
  type SessionAdapter,
  type SessionObserver,
  type WireEvent,
} from '../core/adapter.ts';

interface FakeSession {
  info: HostSession;
  readonly log: WireEvent[];
  readonly followers: Set<{ push: (frame: FollowFrame) => void; end: () => void }>;
  turn: number;
  activeTurn: number | null;
}

/**
 * In-memory stand-in for DSH used by tests and the dev host. It mirrors the
 * behaviour of DSH 0.2.1-rc.3 that `pnpm test:dsh` checks: dense per-session
 * `seq`, a bounded follow snapshot, inbox splices carrying the request id, and
 * approvals that only exist inside a turn.
 */
export class FakeAdapter implements SessionAdapter {
  readonly sessions = new Map<string, FakeSession>();
  readonly prompts: { deviceId: string; submission: PromptSubmission }[] = [];
  readonly cancels: { deviceId: string; sessionId: string }[] = [];
  accessChanges = 0;
  snapshotWindow = 50;
  /** Run a scripted turn (echo reply) right after each prompt. */
  autoReply = true;
  /** Called for every accepted prompt when `autoReply` is off (the dev host scripts its own turns). */
  onPrompt: ((deviceId: string, submission: PromptSubmission) => void) | undefined;
  /** Make the next prompt fail as `refused` or `uncertain` (`uncertain` still records it). */
  nextPromptFailure: 'refused' | 'uncertain' | undefined;
  /** Answer of the local DSH Web card; undefined keeps it pending until `settleLocal`. */
  localOutcome: ApprovalOutcome | undefined = undefined;
  private answerer: ApprovalAnswerer | undefined;
  private readonly observers = new Set<SessionObserver>();
  private settleLocal: ((outcome: ApprovalOutcome) => void) | undefined;
  localWithdrawn = 0;

  addSession(sessionId: string, options: { cwd?: string; title?: string } = {}): void {
    this.sessions.set(sessionId, {
      info: { sessionId, cwd: options.cwd ?? '/home/me/project', title: options.title ?? sessionId, running: false, available: true, updatedAt: Date.now() },
      log: [],
      followers: new Set(),
      turn: 0,
      activeTurn: null,
    });
    this.append(sessionId, 'permission/preset', { preset: 'workspace-write' });
  }

  append(sessionId: string, type: string, data: unknown): WireEvent {
    const session = this.require(sessionId);
    const event: WireEvent = { type, seq: session.log.length, time: Date.now(), data };
    session.log.push(event);
    session.info = { ...session.info, updatedAt: event.time };
    for (const follower of session.followers) follower.push({ type: 'event', event });
    for (const observer of this.observers) observer(sessionId, event);
    return event;
  }

  /** The agent failed outside a turn (DSH's `api-session/error`). */
  failSession(sessionId: string, message: string): void {
    for (const observer of this.observers) observer(sessionId, { type: 'session/error', seq: -1, time: Date.now(), data: { message } });
  }

  stream(sessionId: string, frame: Extract<FollowFrame, { type: 'assistant-stream' }>['frame']): void {
    for (const follower of this.require(sessionId).followers) follower.push({ type: 'assistant-stream', frame });
  }

  startTurn(sessionId: string, text?: string, rpcId?: string, principal?: unknown): number {
    const session = this.require(sessionId);
    session.turn += 1;
    session.activeTurn = session.turn;
    session.info = { ...session.info, running: true };
    this.append(sessionId, 'turn/start', { turn: session.turn });
    if (text !== undefined) {
      this.append(sessionId, 'user/message', {
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', ...(rpcId === undefined ? {} : { rpcId }), ...(principal === undefined ? {} : { principal }) },
      });
    }
    return session.turn;
  }

  endTurn(sessionId: string, reason = 'completed'): void {
    const session = this.require(sessionId);
    if (session.activeTurn === null) return;
    this.append(sessionId, 'turn/end', { turn: session.activeTurn, reason: { kind: reason } });
    session.activeTurn = null;
    session.info = { ...session.info, running: false };
  }

  /** Simulate a tool call that needs approval inside the active turn. */
  async askApproval(sessionId: string, toolName: string, args: string, signal?: AbortSignal): Promise<ApprovalOutcome> {
    const session = this.require(sessionId);
    if (session.activeTurn === null) throw new Error('fake: approvals only exist inside a turn');
    const callId = `call_${session.log.length}`;
    this.append(sessionId, 'tool/call', { turn: session.activeTurn, step: 1, callId, name: toolName, arguments: args });
    const id = `00000000-0000-4000-8000-${String(session.log.length).padStart(12, '0')}`;
    this.append(sessionId, 'approval/asked', { id, toolName, callId, reason: `${toolName} needs approval` });
    const local = new Promise<ApprovalOutcome>((resolve) => {
      this.settleLocal = resolve;
      if (this.localOutcome !== undefined) resolve(this.localOutcome);
    });
    const outcome = this.answerer === undefined
      ? 'unavailable'
      : await this.answerer(
          { sessionId, toolName, callId, reason: `${toolName} needs approval`, ...(signal === undefined ? {} : { signal }) },
          { next: () => local, withdrawLocal: () => (this.localWithdrawn += 1) },
        );
    this.append(sessionId, 'approval/decided', { id, outcome });
    return outcome;
  }

  /** The local DSH Web card answers. */
  answerLocally(outcome: ApprovalOutcome): void {
    this.settleLocal?.(outcome);
  }

  async listSessions(): Promise<HostSession[]> {
    return [...this.sessions.values()].map((s) => s.info);
  }

  async *follow(sessionId: string, signal: AbortSignal): AsyncIterable<FollowFrame> {
    const session = this.require(sessionId);
    const queue: FollowFrame[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    const follower = {
      push: (frame: FollowFrame) => {
        queue.push(frame);
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
      },
    };
    session.followers.add(follower);
    try {
      const events = session.log.slice(-this.snapshotWindow);
      yield { type: 'snapshot', cursor: session.log.length - 1, events, hasMore: session.log.length > events.length };
      while (!signal.aborted && !ended) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        wake = undefined;
      }
    } finally {
      session.followers.delete(follower);
    }
  }

  /** End every live follow (as if DSH restarted the session). */
  dropFollowers(sessionId: string): void {
    for (const follower of [...this.require(sessionId).followers]) follower.end();
  }

  async prompt(deviceId: string, submission: PromptSubmission): Promise<void> {
    const failure = this.nextPromptFailure;
    this.nextPromptFailure = undefined;
    if (failure === 'refused') throw new AdapterRefusedError('busy', 'fake refusal');
    if (!this.sessions.has(submission.sessionId)) throw new AdapterRefusedError('not-found', 'no such session');
    this.prompts.push({ deviceId, submission });
    const principal = { kind: 'dsh-remote-device', deviceId };
    this.append(submission.sessionId, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ role: 'user', content: [{ type: 'text', text: submission.text }], source: { kind: 'user', rpcId: submission.requestId, principal } }] });
    if (failure === 'uncertain') throw new AdapterUncertainError('fake timeout');
    if (!this.autoReply) {
      this.onPrompt?.(deviceId, submission);
      return;
    }
    queueMicrotask(() => {
      this.startTurn(submission.sessionId, submission.text, submission.requestId, principal);
      this.append(submission.sessionId, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `Echo: ${submission.text}` }] } });
      this.endTurn(submission.sessionId);
    });
  }

  async cancel(deviceId: string, sessionId: string): Promise<void> {
    this.cancels.push({ deviceId, sessionId });
    this.endTurn(sessionId, 'cancelled');
  }

  answerApprovals(answerer: ApprovalAnswerer): () => void {
    this.answerer = answerer;
    return () => {
      if (this.answerer === answerer) this.answerer = undefined;
    };
  }

  accessChanged(): void {
    this.accessChanges += 1;
  }

  observe(listener: SessionObserver): () => void {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }

  private require(sessionId: string): FakeSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new AdapterRefusedError('not-found', 'no such session');
    return session;
  }
}
