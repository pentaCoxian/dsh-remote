/**
 * TEST-ONLY entry (`@dsh-remote/dsh-plugin/testing`) for `pnpm test:dsh`.
 * The production entry plus test fixtures: every `glob` tool call asks for
 * approval and one session is seeded and published. `dsh-remote doctor` fails
 * if this entry runs.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  const parsed = parseConfig(rawConfig);
  if (!parsed.ok) throw new Error(`dsh-remote test harness: ${parsed.problems.join('; ')}`);
  const runtime: RcRuntime = { host: undefined, problems: [], hostName: parsed.config.hostName };
  registerCommands(ctx, runtime);
  startRemote(ctx, parsed.config, runtime, 'test-harness');

  ctx.effect(() => ctx.on('tools/pre-execute', async (exec: { name: string }, next: () => Promise<unknown>) => (exec.name === 'glob' ? { kind: 'ask', reason: 'harness: glob needs approval' } : next())), 'dsh-remote harness: glob asks');

  ctx.effect(async () => {
    const { sessionId } = await ctx.sessionController.create({});
    for (let i = 0; i < 100 && runtime.host === undefined; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    await runtime.host?.publish(sessionId);
    writeFileSync(join(stateDir(), 'harness-session'), sessionId);
    return () => {};
  }, 'dsh-remote harness: seed session');
}
