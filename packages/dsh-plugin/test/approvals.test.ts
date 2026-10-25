import { isValid } from '@dsh-remote/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startLiveHost, waitFor, type LiveHost } from './helpers/live.ts';
import type { TestPhone } from './helpers/phone.ts';

let live: LiveHost;
afterEach(() => live.close());

async function setup(options: { remoteApprovalTimeoutMs?: number } = {}) {
  live = await startLiveHost(options);
  const phone = await live.pair();
  live.adapter.startTurn('session-a', 'please run the tests');
  return phone;
}

async function pending(phone: TestPhone) {
  await waitFor(() => live.host.approvals.list().length > 0);
  const list = await live.signed(phone, { method: 'GET', target: '/v1/approvals' });
  return list.json.items[0];
}

const respond = (phone: TestPhone, approvalId: string, decision: string, expectedRevision: number) =>
  live.signed(phone, { method: 'POST', target: `/v1/approvals/${approvalId}/responses`, body: { decision, expectedRevision } });

describe('remote approvals', () => {
  it('shows the exact action and lets a phone allow it once, withdrawing the local card', async () => {
    const phone = await setup();
    const outcome = live.adapter.askApproval('session-a', 'bash', '{"command":"pnpm test"}');
    const approval = await pending(phone);
    expect(isValid('Approval', approval)).toBe(true);
    expect(approval).toMatchObject({ sessionId: 'session-a', toolName: 'bash', revision: 1, state: 'pending' });
    expect(approval.preview.text).toContain('pnpm test');
    expect(approval.approvalId).toMatch(/^apr_00000000-/);

    const reply = await respond(phone, approval.approvalId, 'allow_once', 1);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ state: 'allowed_once', revision: 2, resolvedBy: 'device:Test Phone' });
    expect(await outcome).toBe('allowed-once');
    expect(live.adapter.localWithdrawn).toBe(1);
  });

  it('lets exactly one of two concurrent answers win', async () => {
    const phone = await setup();
    const other = await live.pair('Second Phone');
    const outcome = live.adapter.askApproval('session-a', 'bash', '{"command":"rm -rf build"}');
    const approval = await pending(phone);
    const replies = await Promise.all([respond(phone, approval.approvalId, 'allow_once', 1), respond(other, approval.approvalId, 'deny', 1)]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(replies.find((r) => r.status === 409)!.json.error.code).toBe('APPROVAL_STALE');
    const winner = replies.find((r) => r.status === 200)!.json.state;
    expect(await outcome).toBe(winner === 'allowed_once' ? 'allowed-once' : 'rejected');
  });

  it('refuses a stale revision and an already-settled approval', async () => {
    const phone = await setup();
    void live.adapter.askApproval('session-a', 'bash', '{}');
    const approval = await pending(phone);
    expect((await respond(phone, approval.approvalId, 'deny', 2)).json.error.code).toBe('APPROVAL_STALE');
    expect((await respond(phone, approval.approvalId, 'deny', 1)).status).toBe(200);
    expect((await respond(phone, approval.approvalId, 'allow_once', 2)).json.error.code).toBe('APPROVAL_STALE');
    expect((await respond(phone, 'apr_unknown0000', 'deny', 1)).status).toBe(404);
  });

  it('marks an approval the local owner answered first as stale for phones', async () => {
    const phone = await setup();
    const outcome = live.adapter.askApproval('session-a', 'bash', '{}');
    const approval = await pending(phone);
    live.adapter.answerLocally('rejected');
    expect(await outcome).toBe('rejected');
    const reply = await respond(phone, approval.approvalId, 'allow_once', 1);
    expect(reply.json.error.code).toBe('APPROVAL_STALE');
    expect(live.adapter.localWithdrawn).toBe(0);
  });

  it('pushes approval changes over the socket', async () => {
    const phone = await setup();
    const socket = await live.socket(phone);
    await socket.next((f) => f.kind === 'hello');
    void live.adapter.askApproval('session-a', 'bash', '{}');
    const changed = await socket.next((f) => f.kind === 'approvals.changed');
    expect(changed.payload.approval.state).toBe('pending');
    await respond(phone, changed.payload.approval.approvalId, 'deny', 1);
    expect((await socket.next((f) => f.kind === 'approvals.changed')).payload.approval.state).toBe('denied');
  });

  it('fails closed after the remote timeout when no local answerer exists', async () => {
    const phone = await setup({ remoteApprovalTimeoutMs: 100 });
    live.adapter.localOutcome = 'unavailable';
    const outcome = await live.adapter.askApproval('session-a', 'bash', '{}');
    expect(outcome).toBe('unavailable');
    expect((await live.signed(phone, { method: 'GET', target: '/v1/approvals' })).json.items).toEqual([]);
  });

  it('settles as cancelled when DSH withdraws the question', async () => {
    const phone = await setup();
    const abort = new AbortController();
    const outcome = live.adapter.askApproval('session-a', 'bash', '{}', abort.signal);
    await pending(phone);
    abort.abort();
    expect(await outcome).toBe('cancelled');
  });

  it('leaves unpublished sessions to the local answerers', async () => {
    live = await startLiveHost();
    live.adapter.startTurn('session-b', 'local only');
    live.adapter.localOutcome = 'allowed-once';
    expect(await live.adapter.askApproval('session-b', 'bash', '{}')).toBe('allowed-once');
    expect(live.host.approvals.list()).toEqual([]);
  });
});
