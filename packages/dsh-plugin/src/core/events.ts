import { encodeCursor } from '@dsh-remote/protocol';
import type { FollowFrame, SessionAdapter, WireEvent } from './adapter.ts';
import type { HostState } from './state.ts';
import { chunkText, queuedRequestIds, translateEvent, type TimelineItem } from './translate.ts';

/** Receives one session's fan-out. Calls are synchronous and must not throw. */
export interface FeedSink {
  item(sessionId: string, item: TimelineItem, cursor: string): void;
  ephemeral(sessionId: string, kind: string, payload: Record<string, unknown>): void;
  control(sessionId: string, kind: 'resync.required' | 'session.unpublished', payload: Record<string, unknown>): void;
}

export interface ActiveTurn {
  readonly turn: number;
  /** Ours when a phone prompt started the turn; a synthesized id for local turns. */
  turnId: string;
  readonly startSeq: number;
}

export type PromptProgress = { readonly requestId: string; readonly sessionId: string; readonly state: 'queued' | 'started' | 'finished'; readonly turn?: number };

export interface SessionSnapshot {
  readonly items: readonly TimelineItem[];
  readonly cursor: string;
  readonly hasMore: boolean;
  readonly activeTurn: ActiveTurn | null;
  /** Text streamed so far by the in-progress assistant attempt. */
  readonly partial: { readonly attemptId: string; readonly text: string } | null;
}

const RING_CAPACITY = 2_000;
const SNAPSHOT_ITEMS = 200;
const TRACKED_CALLS = 256;

class SessionFeed {
  readonly sessionId: string;
  ring: TimelineItem[] = [];
  /** Every durable event with seq >= lowSeq is reflected in `ring` (or was skipped). */
  lowSeq = 0;
  highSeq = -1;
  ready = false;
  activeTurn: ActiveTurn | null = null;
  partial: { attemptId: string; text: string } | null = null;
  readonly sinks = new Set<FeedSink>();
  /** callId → DSH approval id / tool call, for approval correlation and previews. */
  readonly asked = new Map<string, string>();
  readonly calls = new Map<string, { name: string; args: string }>();
  readonly abort = new AbortController();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.set(key, value);
    if (map.size > TRACKED_CALLS) map.delete(map.keys().next().value!);
  }
}

/**
 * Live, replayable event fan-out for published sessions. Each published session
 * has one owner-side DSH follow feeding a bounded ring keyed by the durable
 * DSH `seq`; phones subscribe with the cursor of the snapshot they hold.
 */
export class EventHub {
  private readonly feeds = new Map<string, SessionFeed>();
  private readonly promptListeners = new Set<(progress: PromptProgress) => void>();
  private readonly turnListeners = new Set<(sessionId: string, turn: ActiveTurn | null) => void>();
  private readonly adapter: SessionAdapter;
  private readonly state: HostState;
  private readonly retryMs: (attempt: number) => number;
  private disposePublications: (() => void) | undefined;

  constructor(adapter: SessionAdapter, state: HostState, retryMs: (attempt: number) => number = (n) => Math.min(30_000, 500 * 2 ** n)) {
    this.adapter = adapter;
    this.state = state;
    this.retryMs = retryMs;
  }

  start(): void {
    for (const { sessionId } of this.state.publications()) this.open(sessionId);
    this.disposePublications = this.state.onPublicationChanged(({ sessionId, published }) => (published ? this.open(sessionId) : this.close(sessionId)));
  }

  stop(): void {
    this.disposePublications?.();
    for (const sessionId of [...this.feeds.keys()]) this.close(sessionId, false);
  }

  /**
   * Attach `sink` after `afterSeq` (the last seq the client holds). Replay and
   * attachment happen in one synchronous step, so no event can fall between.
   * @returns the replayed items and cursor, `resync` when the gap is no longer
   *   held, or `unavailable` before the first snapshot arrived.
   */
  subscribe(sessionId: string, afterSeq: number | undefined, sink: FeedSink): { kind: 'ok'; replay: TimelineItem[]; cursor: string; unsubscribe: () => void } | { kind: 'resync' } | { kind: 'unavailable' } {
    const feed = this.feeds.get(sessionId);
    if (feed === undefined || !feed.ready) return { kind: 'unavailable' };
    const from = afterSeq ?? feed.highSeq;
    if (from > feed.highSeq || from + 1 < feed.lowSeq) return { kind: 'resync' };
    const replay = feed.ring.filter((item) => item.seq > from);
    feed.sinks.add(sink);
    return { kind: 'ok', replay, cursor: encodeCursor({ sessionId, seq: feed.highSeq }), unsubscribe: () => feed.sinks.delete(sink) };
  }

  snapshot(sessionId: string): SessionSnapshot | undefined {
    const feed = this.feeds.get(sessionId);
    if (feed === undefined || !feed.ready) return undefined;
    const items = feed.ring.slice(-SNAPSHOT_ITEMS);
    return {
      items,
      cursor: encodeCursor({ sessionId, seq: feed.highSeq }),
      hasMore: feed.lowSeq > 0 || feed.ring.length > items.length,
      activeTurn: feed.activeTurn,
      partial: feed.partial,
    };
  }

  activeTurn(sessionId: string): ActiveTurn | null {
    return this.feeds.get(sessionId)?.activeTurn ?? null;
  }

  /** DSH approval id and tool call for `callId`, when the feed has seen them. */
  approvalContext(sessionId: string, callId: string | undefined): { dshApprovalId?: string; call?: { name: string; args: string } } {
    const feed = this.feeds.get(sessionId);
    if (feed === undefined || callId === undefined) return {};
    const dshApprovalId = feed.asked.get(callId);
    const call = feed.calls.get(callId);
    return { ...(dshApprovalId === undefined ? {} : { dshApprovalId }), ...(call === undefined ? {} : { call }) };
  }

  onPrompt(listener: (progress: PromptProgress) => void): () => void {
    this.promptListeners.add(listener);
    return () => this.promptListeners.delete(listener);
  }

  onTurn(listener: (sessionId: string, turn: ActiveTurn | null) => void): () => void {
    this.turnListeners.add(listener);
    return () => this.turnListeners.delete(listener);
  }

  private open(sessionId: string): void {
    if (this.feeds.has(sessionId)) return;
    const feed = new SessionFeed(sessionId);
    this.feeds.set(sessionId, feed);
    void this.run(feed);
  }

  private close(sessionId: string, notify = true): void {
    const feed = this.feeds.get(sessionId);
    if (feed === undefined) return;
    this.feeds.delete(sessionId);
    feed.abort.abort();
    if (notify) for (const sink of feed.sinks) sink.control(sessionId, 'session.unpublished', {});
    feed.sinks.clear();
  }

  private async run(feed: SessionFeed): Promise<void> {
    for (let attempt = 0; !feed.abort.signal.aborted; attempt += 1) {
      try {
        for await (const frame of this.adapter.follow(feed.sessionId, feed.abort.signal)) {
          this.apply(feed, frame);
          attempt = 0;
        }
      } catch {
        // Follow failures are retried below; nothing about them reaches the phone.
      }
      if (feed.abort.signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, this.retryMs(attempt)));
    }
  }

  private apply(feed: SessionFeed, frame: FollowFrame): void {
    if (frame.type === 'snapshot') {
      const first = frame.events[0]?.seq ?? frame.cursor + 1;
      const contiguous = feed.ready && first <= feed.highSeq + 1;
      if (!contiguous) {
        const hadSubscribers = feed.ready;
        feed.ring = [];
        feed.lowSeq = frame.hasMore ? first : 0;
        feed.highSeq = first - 1;
        feed.activeTurn = null;
        feed.partial = null;
        if (hadSubscribers) {
          for (const sink of feed.sinks) sink.control(feed.sessionId, 'resync.required', { reason: 'GAP' });
          feed.sinks.clear();
        }
      }
      for (const event of frame.events) if (event.seq > feed.highSeq) this.ingest(feed, event, contiguous);
      feed.highSeq = Math.max(feed.highSeq, frame.cursor);
      feed.ready = true;
      return;
    }
    if (frame.type === 'event') {
      if (frame.event.seq > feed.highSeq) this.ingest(feed, frame.event, true);
      return;
    }
    const stream = frame.frame;
    if (stream.type === 'start') {
      feed.partial = { attemptId: stream.attemptId, text: '' };
      this.emitEphemeral(feed, 'assistant.started', { attemptId: stream.attemptId });
    } else if (stream.type === 'chunk') {
      const text = chunkText(stream.chunk);
      if (text === undefined) return;
      if (feed.partial?.attemptId === stream.attemptId && feed.partial.text.length < 64 * 1024) feed.partial.text += text;
      this.emitEphemeral(feed, 'assistant.delta', { attemptId: stream.attemptId, index: stream.index, text });
    } else {
      if (feed.partial?.attemptId === stream.attemptId) feed.partial = null;
      this.emitEphemeral(feed, 'assistant.ended', { attemptId: stream.attemptId, committed: stream.committed });
    }
  }

  private ingest(feed: SessionFeed, event: WireEvent, live: boolean): void {
    feed.highSeq = event.seq;
    for (const requestId of queuedRequestIds(event)) this.emitPrompt({ requestId, sessionId: feed.sessionId, state: 'queued' });
    const item = translateEvent(event);
    if (item === undefined) return;
    this.track(feed, item);
    feed.ring.push(item);
    if (feed.ring.length > RING_CAPACITY) {
      feed.ring.shift();
      feed.lowSeq = feed.ring[0]!.seq;
    }
    if (!live) return;
    const cursor = encodeCursor({ sessionId: feed.sessionId, seq: item.seq });
    for (const sink of feed.sinks) sink.item(feed.sessionId, item, cursor);
  }

  private track(feed: SessionFeed, item: TimelineItem): void {
    const payload = item.payload;
    switch (item.kind) {
      case 'turn.started':
        feed.activeTurn = { turn: Number(payload.turn), turnId: `turn_seq${String(item.seq).padStart(6, '0')}`, startSeq: item.seq };
        this.emitTurn(feed);
        break;
      case 'user.message':
        if (typeof payload.requestId === 'string') {
          if (feed.activeTurn !== null && payload.requestId.startsWith('turn_')) feed.activeTurn.turnId = payload.requestId;
          this.emitPrompt({ requestId: payload.requestId, sessionId: feed.sessionId, state: 'started', ...(feed.activeTurn === null ? {} : { turn: feed.activeTurn.turn }) });
          this.emitTurn(feed);
        }
        break;
      case 'turn.finished': {
        const finished = feed.activeTurn;
        feed.activeTurn = null;
        feed.partial = null;
        if (finished !== null && finished.turnId.startsWith('turn_') && !finished.turnId.startsWith('turn_seq')) {
          this.emitPrompt({ requestId: finished.turnId, sessionId: feed.sessionId, state: 'finished', turn: finished.turn });
        }
        this.emitTurn(feed);
        break;
      }
      case 'tool.started':
        if (typeof payload.callId === 'string') feed.remember(feed.calls, payload.callId, { name: String(payload.name), args: String(payload.argsPreview) });
        break;
      case 'approval.requested':
        if (typeof payload.callId === 'string') feed.remember(feed.asked, payload.callId, String(payload.approvalId).slice('apr_'.length));
        break;
      default:
        break;
    }
  }

  private emitEphemeral(feed: SessionFeed, kind: string, payload: Record<string, unknown>): void {
    for (const sink of feed.sinks) sink.ephemeral(feed.sessionId, kind, payload);
  }

  private emitPrompt(progress: PromptProgress): void {
    for (const listener of this.promptListeners) listener(progress);
  }

  private emitTurn(feed: SessionFeed): void {
    for (const listener of this.turnListeners) listener(feed.sessionId, feed.activeTurn);
  }
}
