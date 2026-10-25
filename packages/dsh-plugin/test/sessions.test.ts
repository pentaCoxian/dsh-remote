import { decodeCursor, isValid } from '@dsh-remote/protocol';
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

const prompt = (p: TestPhone, clientRequestId: string, text: string, sessionId = 'session-a') =>
  live.signed(p, { method: 'POST', target: `/v1/sessions/${sessionId}/prompts`, body: { clientRequestId, text } });

describe('session discovery', () => {
  it('lists only published sessions and never reveals host paths', async () => {
    const sessions = await live.signed(phone, { method: 'GET', target: '/v1/sessions' });
    expect(sessions.status).toBe(200);
    expect(sessions.json.items.map((s: { sessionId: string }) => s.sessionId)).toEqual(['session-a']);
    expect(sessions.json.items.every((s: unknown) => isValid('SessionSummary', s))).toBe(true);
    const workspaces = await live.signed(phone, { method: 'GET', target: '/v1/workspaces' });
    expect(workspaces.json.items).toEqual([{ workspaceId: sessions.json.items[0].workspaceId, name: 'api' }]);
    expect(sessions.text + workspaces.text).not.toContain('/home/me');
    const filtered = await live.signed(phone, { method: 'GET', target: `/v1/sessions?workspaceId=${sessions.json.items[0].workspaceId}` });
    expect(filtered.json.items).toHaveLength(1);
  });

  it('serves a bounded snapshot with a cursor for the same session id', async () => {
    const snapshot = await live.signed(phone, { method: 'GET', target: '/v1/sessions/session-a' });
    expect(snapshot.status).toBe(200);
    expect(isValid('SessionSnapshot', snapshot.json)).toBe(true);
    expect(decodeCursor(snapshot.json.cursor)?.sessionId).toBe('session-a');
    expect(snapshot.json.session.title).toBe('Refactor the API');
  });

  it('hides unpublished sessions', async () => {
    for (const request of [
      { method: 'GET', target: '/v1/sessions/session-b' },
      { method: 'POST', target: '/v1/sessions/session-b/prompts', body: { clientRequestId: 'req_hidden', text: 'hi' } },
    ]) {
      const reply = await live.signed(phone, request);
      expect(reply.status).toBe(404);
      expect(reply.json.error.code).toBe('SESSION_NOT_PUBLISHED');
    }
    expect(live.adapter.prompts).toHaveLength(0);
  });
});

describe('prompts are exactly-once', () => {
  it('accepts a prompt, attributes it to the device and tracks it to completion', async () => {
    const reply = await prompt(phone, 'req_first01', 'Check the latest test failures.');
    expect(reply.status).toBe(202);
    expect(isValid('PromptReceipt', reply.json)).toBe(true);
    expect(live.adapter.prompts).toEqual([{ deviceId: phone.deviceId, submission: { sessionId: 'session-a', requestId: reply.json.turnId, text: 'Check the latest test failures.' } }]);
    await waitFor(() => live.host.receipts.byTurn(reply.json.turnId)?.state === 'finished');
    const receipt = await live.signed(phone, { method: 'GET', target: '/v1/sessions/session-a/prompts/req_first01' });
    expect(receipt.json).toEqual({ clientRequestId: 'req_first01', turnId: reply.json.turnId, state: 'finished' });
  });

  it('returns the original turn for an exact retry without asking DSH again', async () => {
    const first = await prompt(phone, 'req_retry01', 'hello');
    const retry = await prompt(phone, 'req_retry01', 'hello');
    expect(retry.status).toBe(200);
    expect(retry.json.turnId).toBe(first.json.turnId);
    expect(live.adapter.prompts).toHaveLength(1);
  });

  it('refuses a reused request id with different text', async () => {
    await prompt(phone, 'req_conflict', 'hello');
    const conflict = await prompt(phone, 'req_conflict', 'something else');
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('keeps an uncertain submission and reconciles it from the DSH log instead of resubmitting', async () => {
    live.adapter.autoReply = false;
    live.adapter.nextPromptFailure = 'uncertain';
    const first = await prompt(phone, 'req_uncertain', 'hello');
    expect(first.status).toBe(503);
    expect(first.json.error.retryable).toBe(true);
    const retry = await prompt(phone, 'req_uncertain', 'hello');
    expect(retry.status).toBe(200);
    expect(['submitting', 'queued']).toContain(retry.json.state);
    await waitFor(() => live.host.receipts.get(phone.deviceId, 'req_uncertain')?.state === 'queued');
    expect(live.adapter.prompts).toHaveLength(1);
  });

  it('marks a refused submission failed', async () => {
    live.adapter.nextPromptFailure = 'refused';
    expect((await prompt(phone, 'req_refused', 'hello')).status).toBe(503);
    expect(live.host.receipts.get(phone.deviceId, 'req_refused')?.state).toBe('failed');
  });

  it('refuses prompts above 16 KiB of UTF-8', async () => {
    const reply = await prompt(phone, 'req_toolong', 'あ'.repeat(6000));
    expect(reply.status).toBe(413);
  });
});

describe('control lease', () => {
  it('serializes writers and supports explicit takeover', async () => {
    const other = await live.pair('Second Phone');
    expect((await prompt(phone, 'req_lease01', 'mine')).status).toBe(202);
    const blocked = await prompt(other, 'req_lease02', 'theirs');
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe('LEASE_HELD');

    const summary = await live.signed(other, { method: 'GET', target: '/v1/sessions' });
    expect(summary.json.items[0].controller).toEqual({ deviceId: phone.deviceId, label: 'Test Phone' });

    const takeover = await live.signed(other, { method: 'POST', target: '/v1/sessions/session-a/control-lease', body: { takeover: true } });
    expect(takeover.status).toBe(200);
    expect(takeover.json.holder.deviceId).toBe(other.deviceId);
    expect((await prompt(phone, 'req_lease03', 'mine again')).json.error.code).toBe('LEASE_HELD');

    const release = await live.signed(other, { method: 'DELETE', target: '/v1/sessions/session-a/control-lease' });
    expect(release.json.holder).toBeNull();
    expect((await prompt(phone, 'req_lease04', 'mine again')).status).toBe(202);
  });
});

describe('cancel', () => {
  it('cancels only the active turn it names', async () => {
    live.adapter.autoReply = false;
    const reply = await prompt(phone, 'req_cancel1', 'long task');
    live.adapter.startTurn('session-a', 'long task', reply.json.turnId, { kind: 'dsh-remote-device', deviceId: phone.deviceId });
    await waitFor(() => live.host.events.activeTurn('session-a')?.turnId === reply.json.turnId);

    const wrong = await live.signed(phone, { method: 'POST', target: '/v1/sessions/session-a/cancel', body: { turnId: 'turn_notactive1' } });
    expect(wrong.status).toBe(409);
    expect(wrong.json.error.code).toBe('TURN_NOT_ACTIVE');

    const cancel = await live.signed(phone, { method: 'POST', target: '/v1/sessions/session-a/cancel', body: { turnId: reply.json.turnId } });
    expect(cancel.status).toBe(202);
    expect(live.adapter.cancels).toEqual([{ deviceId: phone.deviceId, sessionId: 'session-a' }]);
    await waitFor(() => live.host.events.activeTurn('session-a') === null);
  });

  it('can cancel a locally started turn by its synthesized id', async () => {
    live.adapter.startTurn('session-a', 'typed at the host');
    await waitFor(() => live.host.events.activeTurn('session-a') !== null);
    const snapshot = await live.signed(phone, { method: 'GET', target: '/v1/sessions/session-a' });
    const cancel = await live.signed(phone, { method: 'POST', target: '/v1/sessions/session-a/cancel', body: { turnId: snapshot.json.activeTurn.turnId } });
    expect(cancel.status).toBe(202);
  });
});
