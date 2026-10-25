import { hostname } from 'node:os';

/** The `config:` block of the plugin's `cordis.patch.yml` entry. */
export interface PluginConfig {
  readonly hostName: string;
  /** iroh relay URLs. `[]` disables relays: phones then reach the host only on direct or LAN addresses. */
  readonly relays: readonly string[];
  readonly grantTtlDays: number;
  readonly remoteApprovalTimeoutSec: number;
}

/** n0's public relays, until the DSH Remote relays are live. */
export const DEFAULT_RELAYS: readonly string[] = [
  'https://aps1-1.relay.n0.iroh.link./',
  'https://euc1-1.relay.n0.iroh.link./',
  'https://use1-1.relay.n0.iroh.link./',
  'https://usw1-1.relay.n0.iroh.link./',
];

const LABEL = /^[^\x00-\x1f\x7f]{1,64}$/u;
const KNOWN = new Set(['hostName', 'relays', 'grantTtlDays', 'remoteApprovalTimeoutSec']);
/** Sprint 1 settings for the Cloudflare transport. */
const RETIRED = new Set(['publicHost', 'linkOrigin', 'access', 'port']);
const MAX_RELAYS = 8;

function integer(value: unknown, fallback: number, min: number, max: number, name: string, problems: string[]): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer from ${min} to ${max}`);
    return fallback;
  }
  return value;
}

/** A bare `https://host[:port]/` relay URL: no credentials, path, query or fragment. */
function isRelayUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 256) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

/** Validate the raw plugin config; every problem is reported at once. */
export function parseConfig(raw: unknown): { ok: true; config: PluginConfig } | { ok: false; problems: string[] } {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(input)) {
    if (RETIRED.has(key)) problems.push(`${key} is no longer used: DSH Remote now connects over iroh, without Cloudflare. Remove it.`);
    else if (!KNOWN.has(key)) problems.push(`unknown setting ${key}`);
  }
  const hostName = input.hostName === undefined ? hostname().slice(0, 64) : input.hostName;
  if (typeof hostName !== 'string' || !LABEL.test(hostName)) problems.push('hostName must be 1-64 printable characters');
  const relays = input.relays === undefined ? DEFAULT_RELAYS : input.relays;
  if (!Array.isArray(relays) || relays.length > MAX_RELAYS || !relays.every(isRelayUrl)) {
    problems.push(`relays must list at most ${MAX_RELAYS} bare https URLs (or [] for direct connections only)`);
  }
  const grantTtlDays = integer(input.grantTtlDays, 90, 1, 365, 'grantTtlDays', problems);
  const remoteApprovalTimeoutSec = integer(input.remoteApprovalTimeoutSec, 900, 10, 86_400, 'remoteApprovalTimeoutSec', problems);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, config: { hostName: hostName as string, relays: [...(relays as string[])], grantTtlDays, remoteApprovalTimeoutSec } };
}
