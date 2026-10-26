import { createHash, randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import type { PushEvents, PushKind, PushMessage } from '@dsh-remote/protocol';
import type { SessionAdapter, WireEvent } from '../core/adapter.ts';
import type { Clock } from '../core/clock.ts';
import type { DeviceRecord, HostState } from '../core/state.ts';
import { textOf } from '../core/translate.ts';
import type { DeliveryOptions, DeliveryResult } from './sender.ts';

export interface NotifierDeps {
  readonly adapter: SessionAdapter;
  readonly state: HostState;
  readonly clock: Clock;
  readonly hostId: string;
  readonly hostName: string;
  /** Whether the device's phone has this host's DSH Web open right now. */
  present(device: DeviceRecord): boolean;
  deliver(device: DeviceRecord, message: PushMessage, options: DeliveryOptions): Promise<DeliveryResult>;
  readonly log?: (line: string) => void;
}

/** A device gets one finished/failed-turn notification per session per this window (queued turns run back to back). */
const TURN_COALESCE_MS = 5_000;
const TITLE_CACHE_MS = 60_000;
const TRACKED_SESSIONS = 256;

const EVENT_FOR_KIND: Record<Exclude<PushKind, 'test'>, keyof PushEvents> = {
  approval: 'approval',
  'turn.finished': 'turnFinished',
  'turn.failed': 'turnFailed',
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The first non-blank line, for a notification body. */
function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
}

/** A gateway collapse id: an approval or a session, hashed into the id alphabet. */
const collapseId = (prefix: string, value: string) => `${prefix}_${createHash('sha256').update(value).digest('base64url').slice(0, 22)}`;

/**
 * Turns DSH session events into notifications for paired phones that are not
 * looking at DSH Web: an approval waiting (on by default), and finished or
 * failed turns (opt-in). Each device chooses its events when it registers.
 */
export class Notifier {
  private readonly deps: NotifierDeps;
  /** First line of each session's latest reply, for the "turn finished" body. */
  private readonly lastReply = new Map<string, string>();
  /** `${deviceId}\n${sessionId}` → when that device last got a turn notification for that session. */
  private readonly lastTurnPush = new Map<string, number>();
  private titles: { at: number; bySession: Map<string, string> } | undefined;

  constructor(deps: NotifierDeps) {
    this.deps = deps;
  }

  start(): () => void {
    return this.deps.adapter.observe((sessionId, event) => this.observe(sessionId, event));
  }

  /** Exposed for tests; DSH calls it through `observe`. */
  observe(sessionId: string, event: WireEvent): void {
    const data = record(event.data) ?? {};
    switch (event.type) {
      case 'assistant/message': {
        const text = firstLine(textOf(record(data.message)?.content));
        if (text !== '' && data.interrupted !== true) this.remember(this.lastReply, sessionId, text);
        return;
      }
      case 'approval/asked': {
        if (typeof data.id !== 'string' || typeof data.toolName !== 'string') return;
        const reason = typeof data.reason === 'string' ? firstLine(data.reason) : '';
        this.notify('approval', sessionId, `Approval needed: ${data.toolName}${reason === '' ? '' : `\n${reason}`}`, { urgency: 'high', collapseId: collapseId('apr', data.id) });
        return;
      }
      case 'turn/end': {
        const reason = record(data.reason);
        const reply = this.lastReply.get(sessionId);
        this.lastReply.delete(sessionId);
        if (reason?.kind === 'completed' || reason?.kind === 'max-tokens') {
          this.notifyTurn('turn.finished', sessionId, reply ?? 'Turn finished');
        } else if (reason?.kind === 'error') {
          const message = typeof record(reason.error)?.message === 'string' ? firstLine(record(reason.error)!.message as string) : '';
          this.notifyTurn('turn.failed', sessionId, message === '' ? 'Turn failed' : `Turn failed: ${message}`);
        }
        return;
      }
      case 'session/error': {
        const message = typeof data.message === 'string' ? firstLine(data.message) : '';
        this.notifyTurn('turn.failed', sessionId, message === '' ? 'The agent stopped with an error' : `The agent stopped: ${message}`);
        return;
      }
      default:
    }
  }

  private notifyTurn(kind: 'turn.finished' | 'turn.failed', sessionId: string, body: string): void {
    this.notify(kind, sessionId, body, { urgency: 'normal', collapseId: collapseId('ses', sessionId) }, true);
  }

  private notify(kind: Exclude<PushKind, 'test'>, sessionId: string, body: string, options: DeliveryOptions, coalesce = false): void {
    const now = this.deps.clock.now();
    const recipients = this.deps.state
      .devices()
      .filter((device) => device.revokedAt === null && device.expiresAt > now && device.push?.events[EVENT_FOR_KIND[kind]] === true && !this.deps.present(device))
      .filter((device) => {
        if (!coalesce) return true;
        const key = `${device.deviceId}\n${sessionId}`;
        const last = this.lastTurnPush.get(key);
        if (last !== undefined && now - last < TURN_COALESCE_MS) return false;
        this.remember(this.lastTurnPush, key, now);
        return true;
      });
    if (recipients.length === 0) return;
    void this.title(sessionId).then((title) => {
      const message: PushMessage = { v: 1, id: `n_${randomBytes(12).toString('base64url')}`, kind, hostId: this.deps.hostId, hostName: this.deps.hostName, sessionId, title, body, ts: now };
      for (const device of recipients) {
        void this.deps
          .deliver(device, message, options)
          .then((result) => {
            if (result !== 'sent') this.deps.log?.(`dsh-remote: a ${kind} notification was not delivered (${result})`);
          })
          .catch(() => {});
      }
    });
  }

  /** The session's title as DSH Web shows it, else its folder name. */
  private async title(sessionId: string): Promise<string> {
    const now = this.deps.clock.now();
    if (this.titles === undefined || now - this.titles.at > TITLE_CACHE_MS || !this.titles.bySession.has(sessionId)) {
      try {
        const sessions = await this.deps.adapter.listSessions(AbortSignal.timeout(5_000));
        this.titles = { at: now, bySession: new Map(sessions.map((s) => [s.sessionId, s.title !== null && s.title !== '' ? s.title : s.cwd === null ? '' : basename(s.cwd)])) };
      } catch {
        // Fall through to the generic title.
      }
    }
    const title = this.titles?.bySession.get(sessionId);
    return title === undefined || title === '' ? 'DSH session' : title;
  }

  private remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > TRACKED_SESSIONS) map.delete(map.keys().next().value!);
  }
}
