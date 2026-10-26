import {
  AdapterRefusedError,
  AdapterUncertainError,
  type ApprovalAnswerer,
  type FollowFrame,
  type HostSession,
  type PromptSubmission,
  type SessionAdapter,
  type SessionObserver,
} from '../core/adapter.ts';
import type { HostState } from '../core/state.ts';
import type { DshContext, DshPeer } from './types.ts';

/** Principal kind DSH records on every prompt and cancel a phone makes. */
export const PRINCIPAL_KIND = 'dsh-remote-device';

const CONTROLLER_ROLE = { name: 'dsh-remote-controller', resource: 'session', actions: ['session/prompt', 'session/cancel'] } as const;

/**
 * Binds DSH Remote to DSH 0.2.1-rc.3. Reads (list, follow) run owner-side
 * in-process; mutations run as a per-device peer through the Typert gateway,
 * so DSH's remote-access policy is enforced and the device is attributed in
 * the session log. The plugin's own checks still run first.
 */
export class DshAdapter implements SessionAdapter {
  private readonly ctx: DshContext;
  private readonly state: HostState;
  private readonly peers = new Map<string, DshPeer>();

  constructor(ctx: DshContext, state: HostState) {
    this.ctx = ctx;
    this.state = state;
  }

  /** Register the DSH-side access policy for phone principals; returns its disposer. */
  registerPolicy(): () => void {
    return this.ctx.remoteAccess.registerPolicy(PRINCIPAL_KIND, {
      bindings: (principal) => {
        const device = typeof principal.deviceId === 'string' ? this.state.device(principal.deviceId) : undefined;
        if (device === undefined || device.revokedAt !== null || device.expiresAt <= Date.now()) return [];
        return this.state.publications().map((p) => ({ role: CONTROLLER_ROLE, resource: { kind: 'session', id: p.sessionId } }));
      },
    });
  }

  async listSessions(signal: AbortSignal): Promise<HostSession[]> {
    const { items } = await this.ctx.sessionController.list({}, signal);
    return items
      .filter((item) => item.origin !== 'subagent' && !item.blank)
      .map((item) => {
        const title = item.projections?.values?.title;
        return {
          sessionId: item.sessionId,
          cwd: item.cwd ?? null,
          title: typeof title === 'string' && title !== '' ? title : null,
          running: item.running,
          available: item.agentAvailable,
          updatedAt: item.updatedAt,
        };
      });
  }

  async *follow(sessionId: string, signal: AbortSignal): AsyncIterable<FollowFrame> {
    for await (const frame of this.ctx.sessionController.follow({ address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 100 }, signal)) {
      if (frame.type === 'snapshot') {
        yield { type: 'snapshot', cursor: frame.cursor, events: frame.records.map((record) => record.event), hasMore: frame.hasMore };
      } else if (frame.type === 'event') {
        yield { type: 'event', event: frame.event };
      } else {
        const stream = frame.frame;
        if (stream.type === 'end') yield { type: 'assistant-stream', frame: { type: 'end', attemptId: stream.attemptId, committed: stream.outcome.kind === 'committed' } };
        else yield { type: 'assistant-stream', frame: stream };
      }
    }
  }

  async prompt(deviceId: string, submission: PromptSubmission, signal: AbortSignal): Promise<void> {
    await this.invoke(deviceId, 'prompt', {
      request: { requestId: submission.requestId, sessionId: submission.sessionId, mode: 'queue', content: [{ type: 'text', text: submission.text }] },
    }, signal);
  }

  async cancel(deviceId: string, sessionId: string): Promise<void> {
    await this.invoke(deviceId, 'cancel', { request: { sessionId } }, AbortSignal.timeout(10_000));
  }

  answerApprovals(answerer: ApprovalAnswerer): () => void {
    // Outermost listener (prepend) so a phone can race the DSH Web card.
    return this.ctx.on('approval/request', async function (request, next) {
      const sessionId = request.agent.session?.id ?? request.agent.id;
      const original = request.signal;
      const local = new AbortController();
      try {
        // The Web forwarder and the Gateway read this signal: aborting it withdraws the Web card.
        request.signal = original === undefined ? local.signal : AbortSignal.any([original, local.signal]);
      } catch {
        // Not replaceable on this DSH build: a phone answer still wins, the Web card just lingers.
      }
      return answerer(
        {
          sessionId,
          toolName: request.toolName,
          ...(request.callId === undefined ? {} : { callId: request.callId }),
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          ...(original === undefined ? {} : { signal: original }),
        },
        { next: () => next(), withdrawLocal: () => local.abort(new Error('answered from DSH Remote')) },
      );
    }, { prepend: true });
  }

  accessChanged(): void {
    for (const [deviceId, peer] of [...this.peers]) {
      const device = this.state.device(deviceId);
      if (device === undefined || device.revokedAt !== null) {
        this.peers.delete(deviceId);
        void peer.dispose().catch(() => {});
      }
    }
    this.ctx.remoteAccess.invalidate();
  }

  observe(listener: SessionObserver): () => void {
    // The plugin's context is not agent-scoped, so it hears every session; subagent children are skipped.
    const offEvent = this.ctx.on('session/event', (session, event) => {
      if (session.header?.origin !== 'subagent') listener(session.id, event);
    });
    const offError = this.ctx.on('api-session/error', (sessionId, message) => listener(sessionId, { type: 'session/error', seq: -1, time: Date.now(), data: { message } }));
    return () => {
      offEvent();
      offError();
    };
  }

  dispose(): void {
    for (const peer of this.peers.values()) void peer.dispose().catch(() => {});
    this.peers.clear();
  }

  private peer(deviceId: string): DshPeer {
    let peer = this.peers.get(deviceId);
    if (peer === undefined) {
      peer = this.ctx.connection.createPeer({ principal: { kind: PRINCIPAL_KIND, deviceId }, interactions: 'none' });
      this.peers.set(deviceId, peer);
    }
    return peer;
  }

  private async invoke(deviceId: string, method: 'prompt' | 'cancel', args: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    try {
      await this.ctx.typertGateway.invoke({ namespace: 'session', method, args, peer: this.peer(deviceId), signal });
    } catch (error) {
      throw classify(error, signal);
    }
  }
}

/** Map a DSH Remote failure onto "definitely not applied" versus "unknown". */
function classify(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return new AdapterUncertainError('DSH did not answer in time');
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : '';
  if (code === 'remote-access/denied') return new AdapterRefusedError('denied', code);
  if (code === 'session/not-found') return new AdapterRefusedError('not-found', code);
  if (['session/agent-busy', 'session/writer-held', 'session/migration-required', 'session/model-unavailable'].includes(code)) return new AdapterRefusedError('busy', code);
  if (code.startsWith('gateway/arguments') || code === 'gateway/bad-request') return new AdapterRefusedError('invalid', code);
  return new AdapterUncertainError(code === '' ? 'DSH call failed' : code);
}
