/**
 * The single seam between DSH Remote and DeepSeek Harness. `DshAdapter` binds it
 * to a pinned DSH build (see docs/dsh-adapter-findings.md); `FakeAdapter` backs
 * tests and the dev host. Nothing outside an adapter imports DSH.
 */

export interface HostSession {
  readonly sessionId: string;
  /** Working directory; only its basename and a hash ever leave the host. */
  readonly cwd: string | null;
  readonly title: string | null;
  readonly running: boolean;
  /** Whether DSH currently has a live agent for the session. */
  readonly available: boolean;
  readonly updatedAt: number;
}

/** One durable DSH session-log event (`seq` is dense and stable per session). */
export interface WireEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
}

export type AssistantStreamFrame =
  | { readonly type: 'start'; readonly attemptId: string; readonly turn: number; readonly step: number }
  | { readonly type: 'chunk'; readonly attemptId: string; readonly index: number; readonly time: number; readonly chunk: unknown }
  | { readonly type: 'end'; readonly attemptId: string; readonly committed: boolean };

export type FollowFrame =
  /** Opening window: the latest events up to and including `cursor`. */
  | { readonly type: 'snapshot'; readonly cursor: number; readonly events: readonly WireEvent[]; readonly hasMore: boolean }
  | { readonly type: 'event'; readonly event: WireEvent }
  | { readonly type: 'assistant-stream'; readonly frame: AssistantStreamFrame };

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

export interface ApprovalAsk {
  readonly sessionId: string;
  readonly toolName: string;
  readonly callId?: string;
  readonly reason?: string;
  /** Aborts when DSH withdraws the question (e.g. the turn was cancelled). */
  readonly signal?: AbortSignal;
}

export interface ApprovalChain {
  /** Ask the remaining local DSH answerers (the DSH Web approval card). */
  next(): Promise<ApprovalOutcome>;
  /** Withdraw the question from the local answerers after a phone answered. */
  withdrawLocal(): void;
}

export type ApprovalAnswerer = (ask: ApprovalAsk, chain: ApprovalChain) => Promise<ApprovalOutcome>;

export interface PromptSubmission {
  readonly sessionId: string;
  /** Persisted by DSH on the accepted user message; we use the turn id. */
  readonly requestId: string;
  readonly text: string;
}

export interface SessionAdapter {
  listSessions(signal: AbortSignal): Promise<HostSession[]>;
  /** Owner-side live follow of one session log. */
  follow(sessionId: string, signal: AbortSignal): AsyncIterable<FollowFrame>;
  /** Submit a prompt on behalf of a paired device (attributed to it in the DSH log). */
  prompt(deviceId: string, submission: PromptSubmission, signal: AbortSignal): Promise<void>;
  /** Cancel the active turn on behalf of a paired device. */
  cancel(deviceId: string, sessionId: string): Promise<void>;
  /** Install the outermost approval answerer; returns its disposer. */
  answerApprovals(answerer: ApprovalAnswerer): () => void;
  /** Publication or device grants changed; refresh DSH-side access control. */
  accessChanged(): void;
}

/** A DSH call failed in a way that says nothing about whether it took effect. */
export class AdapterUncertainError extends Error {
  override readonly name = 'AdapterUncertainError';
}

/** DSH refused the call; it definitely did not take effect. */
export class AdapterRefusedError extends Error {
  override readonly name = 'AdapterRefusedError';
  readonly reason: 'not-found' | 'denied' | 'busy' | 'invalid';
  constructor(reason: AdapterRefusedError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}
