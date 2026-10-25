import type { WireEvent } from './adapter.ts';

/** One durable timeline item as the phone renders it (schema `TimelineItem`). */
export interface TimelineItem {
  readonly eventId: string;
  readonly seq: number;
  readonly kind: string;
  readonly at: number;
  readonly payload: Record<string, unknown>;
}

export const PREVIEW_LIMITS = { userText: 16 * 1024, assistantText: 64 * 1024, toolArgs: 4 * 1024, toolResult: 8 * 1024 } as const;

export function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Concatenate the `text` parts of a DSH content array; other part kinds are not shown remotely. */
export function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => record(part))
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part!.text as string)
    .join('');
}

export const approvalIdFor = (dshApprovalId: string) => `apr_${dshApprovalId}`;

/** Map a DSH approval outcome onto the wire vocabulary. */
export function wireOutcome(outcome: unknown): string {
  switch (outcome) {
    case 'allowed-once':
      return 'allowed_once';
    case 'rejected':
      return 'denied';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unavailable';
  }
}

/**
 * Translate one durable DSH event into a timeline item, or `undefined` for
 * events the phone does not render (system prompts, request headers, runtime
 * context, audit-only records). Unknown events are skipped, never forwarded raw.
 */
export function translateEvent(event: WireEvent): TimelineItem | undefined {
  const data = record(event.data) ?? {};
  const item = (kind: string, payload: Record<string, unknown>): TimelineItem => ({ eventId: `e${event.seq}`, seq: event.seq, kind, at: event.time, payload });
  switch (event.type) {
    case 'user/message': {
      const source = record(data.source);
      if (source?.kind !== 'user') return undefined;
      const principal = record(source.principal);
      const { text, truncated } = truncate(textOf(data.content), PREVIEW_LIMITS.userText);
      return item('user.message', {
        text,
        truncated,
        origin: principal === undefined ? 'local' : 'remote',
        ...(typeof principal?.deviceId === 'string' ? { deviceId: principal.deviceId } : {}),
        ...(typeof source.rpcId === 'string' ? { requestId: source.rpcId } : {}),
      });
    }
    case 'assistant/message': {
      const message = record(data.message);
      const { text, truncated } = truncate(textOf(message?.content), PREVIEW_LIMITS.assistantText);
      if (text === '') return undefined;
      return item('assistant.message', { text, truncated, turn: data.turn, step: data.step, ...(data.interrupted === true ? { interrupted: true } : {}) });
    }
    case 'tool/call': {
      const args = truncate(typeof data.arguments === 'string' ? data.arguments : '', PREVIEW_LIMITS.toolArgs);
      return item('tool.started', { callId: data.callId, name: data.name, argsPreview: args.text, truncated: args.truncated });
    }
    case 'tool/result': {
      const message = record(data.message);
      const result = truncate(textOf(message?.content), PREVIEW_LIMITS.toolResult);
      return item('tool.finished', {
        callId: message?.toolCallId,
        isError: message?.isError === true,
        resultPreview: result.text,
        truncated: result.truncated,
      });
    }
    case 'approval/asked':
      if (typeof data.id !== 'string') return undefined;
      return item('approval.requested', {
        approvalId: approvalIdFor(data.id),
        toolName: data.toolName,
        ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
        ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
      });
    case 'approval/decided':
      if (typeof data.id !== 'string') return undefined;
      return item('approval.resolved', { approvalId: approvalIdFor(data.id), outcome: wireOutcome(data.outcome) });
    case 'turn/start':
      return item('turn.started', { turn: data.turn });
    case 'turn/end':
      return item('turn.finished', { turn: data.turn, reason: record(data.reason)?.kind ?? 'unknown' });
    default:
      return undefined;
  }
}

/** Request ids of prompts that entered the inbox in this event, if any. */
export function queuedRequestIds(event: WireEvent): string[] {
  if (event.type !== 'agent/inbox/spliced') return [];
  const inserted = record(event.data)?.inserted;
  if (!Array.isArray(inserted)) return [];
  return inserted.flatMap((entry) => {
    const rpcId = record(record(entry)?.source)?.rpcId;
    return typeof rpcId === 'string' ? [rpcId] : [];
  });
}

/** Text carried by one live assistant-stream chunk, when it is a text delta. */
export function chunkText(chunk: unknown): string | undefined {
  const value = record(chunk);
  if (value === undefined || typeof value.type !== 'string' || !value.type.includes('text')) return undefined;
  for (const key of ['delta', 'text']) if (typeof value[key] === 'string') return value[key] as string;
  return undefined;
}
