/**
 * DSH Remote — DeepSeek Harness plugin entry. Continue an existing DSH session
 * from the DSH Remote phone app over Cloudflare Tunnel + Access. Load it into
 * the `web` profile; see docs/setup-cloudflare.md for the one-time setup.
 */
import { cloudflareAccessVerifier } from './core/access.ts';
import { parseConfig } from './dsh/config.ts';
import { registerCommands, startRemote } from './dsh/plugin.ts';
import type { RcRuntime } from './dsh/commands.ts';
import type { DshContext } from './dsh/types.ts';

export const name = 'dsh-remote';
export const inject = ['commands', 'connection', 'typertGateway', 'remoteAccess', 'sessionController'];

export function apply(ctx: DshContext, rawConfig: unknown): void {
  const parsed = parseConfig(rawConfig);
  const runtime: RcRuntime = { host: undefined, problems: parsed.ok ? [] : parsed.problems, hostName: parsed.ok ? parsed.config.hostName : 'this host' };
  registerCommands(ctx, runtime);
  if (!parsed.ok) {
    ctx.logger?.warn(`dsh-remote: not configured (${parsed.problems.length} problem(s)); run /rc for details`);
    return;
  }
  // Production identity comes only from the Zero Trust team's own issuer and JWKS.
  const access = cloudflareAccessVerifier(parsed.config.access.teamName, parsed.config.access.audTags);
  startRemote(ctx, parsed.config, access, runtime);
}
