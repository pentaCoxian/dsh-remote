import { CLOSE_CODES, encodeCursor, isValid } from '@dsh-remote/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startLiveHost, waitFor, type LiveHost } from './helpers/live.ts';
import type { TestPhone } from './helpers/phone.ts';

let live: LiveHost;
let phone: TestPhone;
beforeEach(async () => {
  live = await startLiveHost();
  phone = await live.pair();
});
afterEach(() => live.close());

const snapshot = async () => (await live.signed(phone, { method: 'GET', target: '/v1/sessions/session-a' })).json;

describe('/v1/events', () => {
  it('refuses an unsigned upgrade', async () => {
    const { default: WebSocket } = await import('ws');
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${live.port}/v1/events`, { headers: { host: 'dsh.example.com' } });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
    });
    expect(status).toBe(401);
  });

  it('streams live events after the snapshot cursor with no gap or duplicate', async () => {
    const before = await snapshot();
    const socket = await live.socket(phone);
    await socket.next((f) => f.kind === 'hello');
    socket.send({ op: 'subscribe', sessionId: 'session-a', after: before.cursor });
    const subscribed = await socket.next((f) => f.kind === 'subscribed');
    expect(subscribed.payload.replayed).toBe(0);

    await live.signed(phone, { method: 'POST', target: '/v1/sessions/session-a/prompts', body: { clientRequestId: 'req_stream1', text: 'stream me' } });
    await socket.next((f) => f.kind === 'turn.finished');
    const events = socket.frames.filter((f) => f.type === 'session.event' && !f.ephemeral);
    expect(events.map((f) => f.kind)).toEqual(['turn.started', 'user.message', 'assistant.message', 'turn.finished']);
    expect(events.every((f) => isValid('ServerFrame', f))).toBe(true);
    expect(new Set(events.map((f) => f.eventId)).size).toBe(events.length);
    const seqs = events.map((f) => f.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(events[1].payload).toMatchObject({ text: 'stream me', origin: 'remote', deviceId: phone.deviceId });
  });

  it('replays exactly what a reconnecting client missed', async () => {
    const first = await live.socket(phone);
    first.send({ op: 'subscribe', sessionId: 'session-a', after: (await snapshot()).cursor });
    await first.next((f) => f.kind === 'subscribed');
    live.adapter.append('session-a', 'turn/start', { turn: 7 });
    const seen = await first.next((f) => f.kind === 'turn.started');
    first.ws.terminate();

    live.adapter.append('session-a', 'assistant/message', { turn: 7, step: 1, message: { content: [{ type: 'text', text: 'missed 1' }] } });
    live.adapter.append('session-a', 'turn/end', { turn: 7, reason: { kind: 'completed' } });

    const second = await live.socket(phone);
    second.send({ op: 'subscribe', sessionId: 'session-a', after: seen.cursor });
    const subscribed = await second.next((f) => f.kind === 'subscribed');
    expect(subscribed.payload.replayed).toBe(2);
    const replayed = [await second.next((f) => f.type === 'session.event'), await second.next((f) => f.type === 'session.event')];
    expect(replayed.map((f) => f.kind)).toEqual(['assistant.message', 'turn.finished']);
    expect(replayed[0].seq).toBe(seen.seq + 1);
  });

  it('asks for a resync when a cursor is not usable', async () => {
    const socket = await live.socket(phone);
    socket.send({ op: 'subscribe', sessionId: 'session-a', after: encodeCursor({ sessionId: 'session-a', seq: 10_000 }) });
    expect((await socket.next((f) => f.kind === 'resync.required')).payload.reason).toBe('CURSOR_EXPIRED');
    socket.send({ op: 'subscribe', sessionId: 'session-a', after: encodeCursor({ sessionId: 'session-b', seq: 0 }) });
    expect((await socket.next((f) => f.kind === 'resync.required')).payload.reason).toBe('CURSOR_INVALID');
    socket.send({ op: 'subscribe', sessionId: 'session-b' });
    expect((await socket.next((f) => f.kind === 'error')).payload.code).toBe('SESSION_NOT_PUBLISHED');
  });

  it('forwards assistant deltas as ephemeral frames', async () => {
    const socket = await live.socket(phone);
    socket.send({ op: 'subscribe', sessionId: 'session-a' });
    await socket.next((f) => f.kind === 'subscribed');
    live.adapter.stream('session-a', { type: 'start', attemptId: 'att1', turn: 1, step: 1 });
    live.adapter.stream('session-a', { type: 'chunk', attemptId: 'att1', index: 0, time: Date.now(), chunk: { type: 'text-delta', delta: '3 tests ' } });
    const delta = await socket.next((f) => f.kind === 'assistant.delta');
    expect(delta).toMatchObject({ ephemeral: true, payload: { text: '3 tests ', attemptId: 'att1' } });
    expect(delta.cursor).toBeUndefined();
    expect((await snapshot()).partial).toEqual({ attemptId: 'att1', text: '3 tests ' });
  });

  it('sends heartbeats', async () => {
    const socket = await live.socket(phone);
    expect((await socket.next((f) => f.kind === 'heartbeat')).payload.serverTime).toBeTypeOf('number');
  });

  it('closes a revoked device immediately and refuses its next request', async () => {
    const socket = await live.socket(phone);
    await socket.next((f) => f.kind === 'hello');
    await live.host.revokeDevice(phone.deviceId);
    expect((await socket.closed()).code).toBe(CLOSE_CODES.deviceRevoked);
    const reply = await live.signed(phone, { method: 'GET', target: '/v1/sessions' });
    expect(reply.json.error.code).toBe('DEVICE_REVOKED');
  });

  it('tells subscribers when a session is unpublished', async () => {
    const socket = await live.socket(phone);
    socket.send({ op: 'subscribe', sessionId: 'session-a' });
    await socket.next((f) => f.kind === 'subscribed');
    await live.host.unpublish('session-a');
    expect((await socket.next((f) => f.kind === 'session.unpublished')).sessionId).toBe('session-a');
  });

  it('closes on an invalid client frame', async () => {
    const socket = await live.socket(phone);
    socket.send({ op: 'prompt', text: 'not over the socket' });
    expect((await socket.closed()).code).toBe(1008);
  });

  it('notifies the previous controller when the lease is taken over', async () => {
    const other = await live.pair('Second Phone');
    await live.signed(phone, { method: 'POST', target: '/v1/sessions/session-a/control-lease', body: {} });
    const socket = await live.socket(phone);
    socket.send({ op: 'subscribe', sessionId: 'session-a' });
    await socket.next((f) => f.kind === 'subscribed');
    await live.signed(other, { method: 'POST', target: '/v1/sessions/session-a/control-lease', body: { takeover: true } });
    expect((await socket.next((f) => f.kind === 'lease.lost')).payload.controller.label).toBe('Second Phone');
  });

  it('survives a DSH follow restart without losing events', async () => {
    const socket = await live.socket(phone);
    socket.send({ op: 'subscribe', sessionId: 'session-a', after: (await snapshot()).cursor });
    await socket.next((f) => f.kind === 'subscribed');
    live.adapter.dropFollowers('session-a');
    live.adapter.append('session-a', 'turn/start', { turn: 9 });
    await waitFor(() => socket.frames.some((f) => f.kind === 'turn.started'), 5_000);
    expect(socket.frames.filter((f) => f.kind === 'resync.required')).toHaveLength(0);
  });
});
