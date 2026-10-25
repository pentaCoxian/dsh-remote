// Phase 0 throwaway probe. Answers the runtime halves of A1, A2, A6 and A7
// against a pinned `dsh web`. Results are served as JSON on a loopback port.
import { createServer } from 'node:http';

export const name = 'dsh-remote-probe';
export const inject = ['commands', 'connection', 'typertGateway', 'remoteAccess', 'sessionController', 'approval'];

const PRINCIPAL_KIND = 'dsh-remote-probe';

export function apply(ctx, config) {
  const port = config?.port ?? 4399;
  const report = {};
  const note = (key, value) => {
    report[key] = value;
    ctx.logger?.info?.(`probe ${key}: ${JSON.stringify(value)}`);
  };
  const boundSessions = new Set();
  let pendingPhone;

  // A2: slash command; the current session comes from invocation.agent.
  ctx.effect(() => ctx.commands.register({
    name: 'rcprobe',
    description: 'DSH Remote probe',
    recordInput: false,
    handler: (invocation) => {
      note('A2.command', { agentId: invocation.agent.id, sessionId: invocation.agent.session?.id, rawInput: invocation.rawInput });
      return { kind: 'success', text: `probe ok for ${invocation.agent.id}` };
    },
  }));

  // A1: owner-only exact Fetch route below /api.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-remote-probe/ping',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      note('A1.fetchReached', true);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    },
  }));

  // A7: a non-owner principal kind with a policy over bound sessions.
  const role = { name: 'probe-controller', resource: 'session', actions: ['session/follow', 'session/page', 'session/prompt', 'session/cancel'] };
  const listRole = { name: 'probe-lister', resource: 'global', actions: ['session/list'] };
  ctx.effect(() => ctx.remoteAccess.registerPolicy(PRINCIPAL_KIND, {
    bindings: () => [
      { role: listRole, resource: { kind: 'global' } },
      ...[...boundSessions].map((id) => ({ role, resource: { kind: 'session', id } })),
    ],
  }));
  const peer = ctx.connection.createPeer({ principal: { kind: PRINCIPAL_KIND, deviceId: 'dev_probe' }, interactions: 'none' });

  // A6 driver: every `glob` call needs approval, so a scripted turn asks inside a real turn.
  ctx.on('tools/pre-execute', async function (exec, next) {
    if (exec.name === 'glob') return { kind: 'ask', reason: 'probe: glob needs approval' };
    return next();
  });

  // A6: outermost approval answerer that races a simulated phone against next().
  ctx.on('approval/request', async function (req, next) {
    const descriptor = Object.getOwnPropertyDescriptor(req, 'signal');
    const ours = new AbortController();
    let swapped = false;
    try {
      req.signal = req.signal ? AbortSignal.any([req.signal, ours.signal]) : ours.signal;
      swapped = true;
    } catch (error) {
      note('A6.swapError', String(error));
    }
    note('A6.listener', {
      frozen: Object.isFrozen(req),
      signalDescriptor: descriptor ? { writable: descriptor.writable, configurable: descriptor.configurable } : 'absent',
      swapped,
      hasLiveClient: ctx.typertGateway.hasLiveClient(),
      callId: req.callId ?? null,
    });
    const phone = new Promise((resolve) => { pendingPhone = resolve; });
    const local = next().then((outcome) => ({ by: 'local', outcome }));
    const winner = await Promise.race([local, phone.then((outcome) => ({ by: 'phone', outcome }))]);
    if (winner.by === 'phone') ours.abort(new Error('answered remotely'));
    note('A6.winner', winner);
    if (winner.by === 'local' && winner.outcome === 'unavailable') {
      note('A6.localUnavailable', true);
      return await phone;
    }
    return winner.outcome;
  }, { prepend: true });

  const routes = {
    'GET /report': async () => report,
    'POST /create': async () => ctx.sessionController.create({}),
    'GET /list': async () => ctx.sessionController.list({}, AbortSignal.timeout(5000)),
    'POST /bind': async (q) => { boundSessions.add(q.get('sessionId')); ctx.remoteAccess.invalidate(peer.principal); return [...boundSessions]; },
    'GET /peer-list': async () => tryInvoke('A7.peerList', () => ctx.typertGateway.invoke({ namespace: 'session', method: 'list', args: { _request: {} }, peer })),
    'GET /peer-follow': async (q) => tryInvoke(`A7.peerFollow.${q.get('sessionId')}`, async () => {
      const stream = await ctx.typertGateway.stream({
        namespace: 'session', method: 'follow', peer, signal: AbortSignal.timeout(3000),
        args: { request: { address: { kind: 'session', sessionId: q.get('sessionId') } } },
      });
      for await (const frame of stream) return { firstFrame: frame.type, cursor: frame.cursor, records: frame.records?.map((r) => r.event.type) };
    }),
    'POST /peer-prompt': async (q) => tryInvoke('A7.peerPrompt', () => ctx.typertGateway.invoke({
      namespace: 'session', method: 'prompt', peer,
      args: { request: { requestId: q.get('requestId') ?? 'req_probe_1', sessionId: q.get('sessionId'), mode: 'queue', content: [{ type: 'text', text: q.get('text') ?? 'probe prompt' }] } },
    })),
    'POST /approval': async (q) => {
      const resolved = await ctx.sessionController.resolveAgent(q.get('sessionId'));
      if (!resolved.agent) return { error: String(resolved.error) };
      const outcome = await ctx.approval.request({ agent: resolved.agent, toolName: 'probe', reason: 'probe approval', signal: AbortSignal.timeout(120000) });
      note('A6.outcome', outcome);
      return { outcome };
    },
    'POST /phone': async (q) => { pendingPhone?.(q.get('outcome') ?? 'allowed-once'); return { ok: Boolean(pendingPhone) }; },
  };

  async function tryInvoke(key, fn) {
    try {
      const value = await fn();
      note(key, { ok: true, value });
      return value;
    } catch (error) {
      const failure = { ok: false, code: error?.code, name: error?.name, message: error?.message };
      note(key, failure);
      return failure;
    }
  }

  ctx.effect(() => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) { res.writeHead(404).end(); return; }
      try {
        const value = await route(url.searchParams);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value ?? null, null, 2));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error?.stack ?? error) }));
      }
    });
    server.listen(port, '127.0.0.1');
    return () => { server.closeAllConnections(); server.close(); };
  });
}
