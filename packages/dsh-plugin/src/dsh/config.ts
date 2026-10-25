import { hostname } from 'node:os';
import { canonicalHttpsOrigin } from '@dsh-remote/protocol';

/** The `config:` block of the plugin's `cordis.patch.yml` entry. */
export interface PluginConfig {
  /** Access-protected API hostname routed by cloudflared to 127.0.0.1:port. */
  readonly publicHost: string;
  /** Public static link host (app-link association files + OAuth callback). */
  readonly linkOrigin: string;
  readonly access: { readonly teamName: string; readonly audTags: readonly string[] };
  readonly hostName: string;
  readonly port: number;
  readonly grantTtlDays: number;
  readonly remoteApprovalTimeoutSec: number;
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const TEAM_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const AUD_TAG = /^[a-f0-9]{64}$/;
const LABEL = /^[^\x00-\x1f\x7f]{1,64}$/;

function integer(value: unknown, fallback: number, min: number, max: number, name: string, problems: string[]): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer from ${min} to ${max}`);
    return fallback;
  }
  return value;
}

/** Validate the raw plugin config; every problem is reported at once. */
export function parseConfig(raw: unknown): { ok: true; config: PluginConfig } | { ok: false; problems: string[] } {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const publicHost = typeof input.publicHost === 'string' ? input.publicHost : '';
  if (!HOSTNAME.test(publicHost)) problems.push('publicHost must be a lowercase hostname such as dsh.example.com');
  const linkOrigin = typeof input.linkOrigin === 'string' ? canonicalHttpsOrigin(input.linkOrigin) : undefined;
  if (linkOrigin === undefined) problems.push('linkOrigin must be a bare https origin such as https://link.example.com');
  else if (new URL(linkOrigin).hostname === publicHost) problems.push('linkOrigin must use a different hostname than publicHost');
  const access = (typeof input.access === 'object' && input.access !== null ? input.access : {}) as Record<string, unknown>;
  const teamName = typeof access.teamName === 'string' ? access.teamName : '';
  if (!TEAM_NAME.test(teamName)) problems.push('access.teamName must be your Zero Trust team name (the <team> in <team>.cloudflareaccess.com)');
  const audTags = Array.isArray(access.audTags) ? access.audTags : [];
  if (audTags.length === 0 || !audTags.every((tag) => typeof tag === 'string' && AUD_TAG.test(tag))) problems.push('access.audTags must list the Access application AUD tag(s)');
  const hostName = input.hostName === undefined ? hostname().slice(0, 64) : input.hostName;
  if (typeof hostName !== 'string' || !LABEL.test(hostName)) problems.push('hostName must be 1-64 printable characters');
  const port = integer(input.port, 4318, 1024, 65535, 'port', problems);
  const grantTtlDays = integer(input.grantTtlDays, 90, 1, 365, 'grantTtlDays', problems);
  const remoteApprovalTimeoutSec = integer(input.remoteApprovalTimeoutSec, 900, 10, 86_400, 'remoteApprovalTimeoutSec', problems);
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: { publicHost, linkOrigin: linkOrigin!, access: { teamName, audTags: audTags as string[] }, hostName: hostName as string, port, grantTtlDays, remoteApprovalTimeoutSec },
  };
}
