/**
 * TEST-ONLY entry (`@dsh-remote/dsh-plugin/testing`) for `pnpm test:dsh`.
 * Identical to the production entry except that Access assertions are checked
 * against a local test issuer. `dsh-remote doctor` fails if this entry runs.
 * It also makes every `glob` tool call ask for approval and seeds one session.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRemoteJWKSet } from 'jose';
import { createAccessVerifier } from '../core/access.ts';
import type { RcRuntime } from '../dsh/commands.ts';
import { parseConfig } from '../dsh/config.ts';
import { registerCommands, startRemote, stateDir } from '../dsh/plugin.ts';
import type { DshContext } from '../dsh/types.ts';

export const name = 'dsh-remote-test-harness';
export const inject = ['commands', 'connection', 'typertGateway', 'remoteAccess', 'sessionController'];

interface HarnessContext extends DshContext {
  readonly sessionController: DshContext['sessionController'] & { create(request: Record<string, never>): Promise<{ sessionId: string }> };
  on(event: string, listener: (...args: any[]) => unknown, options?: { prepend: boolean }): () => void;
}

export function apply(ctx: HarnessContext, rawConfig: unknown): void {
  const issuer = process.env.DSH_REMOTE_TEST_ISSUER;
  const jwks = process.env.DSH_REMOTE_TEST_JWKS;
  const audience = process.env.DSH_REMOTE_TEST_AUD;
  if (issuer === undefined || jwks === undefined || audience === undefined) throw new Error('dsh-remote test harness: DSH_REMOTE_TEST_* is not set');
  const parsed = parseConfig(rawConfig);
  if (!parsed.ok) throw new Error(`dsh-remote test harness: ${parsed.problems.join('; ')}`);
  const runtime: RcRuntime = { host: undefined, problems: [], hostName: parsed.config.hostName };
  registerCommands(ctx, runtime);
  startRemote(ctx, parsed.config, createAccessVerifier({ issuer, audiences: [audience], keys: createRemoteJWKSet(new URL(jwks)) }), runtime, 'test-harness');

  ctx.effect(() => ctx.on('tools/pre-execute', async (exec: { name: string }, next: () => Promise<unknown>) => (exec.name === 'glob' ? { kind: 'ask', reason: 'harness: glob needs approval' } : next())), 'dsh-remote harness: glob asks');

  ctx.effect(async () => {
    const { sessionId } = await ctx.sessionController.create({});
    for (let i = 0; i < 100 && runtime.host === undefined; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    await runtime.host?.publish(sessionId);
    writeFileSync(join(stateDir(), 'harness-session'), sessionId);
    return () => {};
  }, 'dsh-remote harness: seed session');
}
