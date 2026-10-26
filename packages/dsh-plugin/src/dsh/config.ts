import { hostname } from 'node:os';
import { TICKET } from '@dsh-remote/protocol';
import { ticketEndpointId } from '../transport/iroh.ts';

/** The `config:` block of the plugin's `cordis.patch.yml` entry. */
export interface PluginConfig {
  readonly hostName: string;
  /** iroh relay URLs. `[]` disables relays: phones then reach the host only on direct or LAN addresses. */
  readonly relays: readonly string[];
  readonly grantTtlDays: number;
  readonly remoteApprovalTimeoutSec: number;
  /** The push gateway's iroh ticket; null turns notifications off. */
  readonly pushGateway: string | null;
}

/**
 * The DSH Remote relay (Tokyo pilot, infra/), then n0's public relays as the
 * fallback for hosts far from Tokyo and for a Tokyo outage. iroh homes each
 * endpoint on the lowest-latency entry.
 */
export const DEFAULT_RELAYS: readonly string[] = [
  'https://nrt1.relay.dshremote.pentacoxian.dev/',
  'https://aps1-1.relay.n0.iroh.link./',
  'https://euc1-1.relay.n0.iroh.link./',
  'https://use1-1.relay.n0.iroh.link./',
  'https://usw1-1.relay.n0.iroh.link./',
];

/**
 * The DSH Remote push gateway on the Tokyo relay box (infra/push/). It sees
 * only sealed envelopes; null until it is deployed.
 */
export const DEFAULT_PUSH_GATEWAY: string | null = null;

const LABEL = /^[^\x00-\x1f\x7f]{1,64}$/u;
const KNOWN = new Set(['hostName', 'relays', 'grantTtlDays', 'remoteApprovalTimeoutSec', 'pushGateway']);
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
  const pushGateway = input.pushGateway === undefined ? DEFAULT_PUSH_GATEWAY : input.pushGateway;
  if (pushGateway !== null && (typeof pushGateway !== 'string' || !TICKET.test(pushGateway) || ticketEndpointId(pushGateway) === undefined)) {
    problems.push('pushGateway must be an iroh endpoint ticket, or null to turn notifications off');
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, config: { hostName: hostName as string, relays: [...(relays as string[])], grantTtlDays, remoteApprovalTimeoutSec, pushGateway: pushGateway as string | null } };
}
