import { homedir } from 'node:os';
import { join } from 'node:path';
import { AdminSocket } from '../admin/socket.ts';
import { runAdmin } from '../admin/ops.ts';
import { FileAudit } from '../core/audit.ts';
import { systemClock } from '../core/clock.ts';
import { HostKey } from '../core/host-key.ts';
import { shortPeerId } from '../core/peer.ts';
import type { ReceiptsDocument } from '../core/receipts.ts';
import type { HostStateDocument } from '../core/state.ts';
import { ensurePrivateDir, JsonFileStore } from '../core/store.ts';
import { RemoteHost } from '../host.ts';
import { DshAdapter } from './adapter.ts';
import { adminRoute } from './admin-route.ts';
import { RC_HINT, rcCommand, type RcRuntime } from './commands.ts';
import type { PluginConfig } from './config.ts';
import type { DshContext } from './types.ts';
import type { WebGatewayOptions } from '../web/gateway.ts';
import { MOBILE_UI, mobileUiStatus } from './mobile-ui.ts';
import type { DshClientModules } from './types.ts';

/**
 * DSH Web as the tunnel's target: its own loopback listener and its own owner
 * login. HTTPS listeners are not tunnelled (the phone-side origin is plain HTTP).
 */
export function dshWeb(ctx: DshContext): WebGatewayOptions {
  return {
    target: () => {
      const { port, protocol } = ctx.webServer;
      if (port === undefined || protocol !== 'http:') return undefined;
      const host = ctx.webServer.host;
      return { host: host === undefined || host === '' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host, port };
    },
    launchTokenQuery: () => {
      try {
        const token = new URL(ctx.connection.authenticatedUrl('http://127.0.0.1/')).searchParams.get('token');
        return token === null ? undefined : `token=${token}`;
      } catch {
        return undefined;
      }
    },
  };
}

/** `$DSH_HOME`, else `~/.dsh` (same precedence as `@deepseek-ai/dsh-home-paths`). */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim();
  return configured ? configured : join(homedir(), '.dsh');
}

/** Where DSH Remote keeps state, keys, receipts, audit and the admin socket. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), 'remote');
}

/** Register `/rc` and `/remote-control`; replies come from whatever `runtime` holds. */
export function registerCommands(ctx: DshContext, runtime: RcRuntime): void {
  const handler = rcCommand(runtime);
  for (const name of ['rc', 'remote-control']) {
    // `input` makes DSH Web pass arguments (`/rc pair`) to the command; without it the composer sends such a line to the model.
    ctx.effect(() => ctx.commands.register({ name, description: 'Use DSH Web from the DSH Remote phone app', input: { hint: RC_HINT }, recordInput: false, handler }), `dsh-remote: /${name}`);
  }
}

/**
 * Start DSH Remote inside a DSH host. Failures are reported through `/rc`
 * rather than taking the plugin down, so the owner sees what to fix.
 */
export function startRemote(ctx: DshContext, config: PluginConfig, runtime: RcRuntime, entry: 'production' | 'test-harness' = 'production', dir = stateDir()): void {
  // DSH Web's client modules exist only where DSH Web does; read them while they do.
  let clientModules: DshClientModules | undefined;
  ctx.inject(['clientModules'], (web) => {
    web.effect(() => {
      clientModules = web.clientModules;
      return () => (clientModules = undefined);
    }, 'dsh-remote: phone layout check');
  });
  const mobileUi = () => mobileUiStatus(clientModules?.clientPath(MOBILE_UI.name));

  ctx.effect(async () => {
    let host: RemoteHost | undefined;
    let adapter: DshAdapter | undefined;
    const cleanup: (() => unknown)[] = [];
    try {
      ensurePrivateDir(dir);
      const clock = systemClock;
      const audit = new FileAudit(join(dir, 'audit.jsonl'), clock);
      host = await RemoteHost.create({
        adapter: (state) => (adapter = new DshAdapter(ctx, state)),
        clock,
        hostKey: await HostKey.loadOrCreate(join(dir, 'endpoint-key')),
        stateStore: new JsonFileStore<HostStateDocument>(join(dir, 'state.json')),
        receiptsStore: new JsonFileStore<ReceiptsDocument>(join(dir, 'receipts.json')),
        audit,
        iroh: { relays: config.relays },
        web: dshWeb(ctx),
        push: { gateway: config.pushGateway },
        log: (line) => ctx.logger?.info(line),
        mobileUi,
        hostName: config.hostName,
        grantTtlMs: config.grantTtlDays * 86_400_000,
        remoteApprovalTimeoutMs: config.remoteApprovalTimeoutSec * 1000,
        entry,
      });
      const started = host;
      const binding = adapter!;
      cleanup.push(binding.registerPolicy(), () => binding.dispose(), () => audit.flush());
      await started.start();
      cleanup.push(() => started.stop());
      const admin = new AdminSocket(join(dir, 'admin.sock'), (request) => runAdmin(started, binding, request));
      await admin.listen();
      cleanup.push(() => admin.close());
      const disposeRoute = ctx.connection.fetch.register(adminRoute(() => runtime.host, () => adapter));
      cleanup.push(disposeRoute);
      runtime.host = started;
      runtime.problems = [];
      const online = await started.endpoint!.online(10_000);
      const relay = started.endpoint!.homeRelay();
      const layout = mobileUi();
      if (!layout.ok) ctx.logger?.warn(`dsh-remote: ${layout.problem}`);
      ctx.logger?.info(`dsh-remote: host ${shortPeerId(started.hostId)} is ${relay !== null ? `reachable through ${relay}` : config.relays.length === 0 ? 'reachable on direct addresses only' : online ? 'online' : 'not yet connected to a relay'}`);
    } catch (error) {
      runtime.problems = [`could not start: ${error instanceof Error ? error.message : String(error)}`];
      ctx.logger?.error(`dsh-remote: ${runtime.problems[0]}`);
    }
    return async () => {
      runtime.host = undefined;
      for (const dispose of cleanup.reverse()) await dispose();
    };
  }, 'dsh-remote: host');
}
