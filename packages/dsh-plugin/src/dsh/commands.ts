import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shortPeerId } from '../core/peer.ts';
import { dshHome } from '../install/installer.ts';
import type { RemoteHost } from '../host.ts';
import type { DshCommandInvocation, DshCommandResult } from './types.ts';

export interface RcRuntime {
  host: RemoteHost | undefined;
  problems: string[];
  hostName: string;
}

/** What DSH Web shows after `/rc ` while typing. */
export const RC_HINT = 'pair | status | devices | revoke <deviceId>';
const USAGE = `Usage: /rc [${RC_HINT}]`;

/**
 * The `dsh-remote` CLI as a user can run it: the profile's bin when DSH
 * installed the plugin there (`~/.dsh/profiles/web/node_modules/.bin/dsh-remote`),
 * else the bare name.
 */
export function cliCommand(env: NodeJS.ProcessEnv = process.env): string {
  const bin = join(dshHome(env), 'profiles', 'web', 'node_modules', '.bin', 'dsh-remote');
  if (!existsSync(bin)) return 'dsh-remote';
  return bin.startsWith(`${homedir()}/`) ? `~/${bin.slice(homedir().length + 1)}` : bin;
}

/**
 * `/rc` and `/remote-control`. DSH Web shows a command's reply as plain text
 * and writes it to the session log, so it never carries a QR code or a pairing
 * challenge. In DSH Web a bare `/rc` never gets here: the plugin's client
 * module (client/client.js) opens the pairing dialog instead. Elsewhere,
 * pairing happens in a terminal, with `dsh-remote pair`.
 */
export function rcCommand(runtime: RcRuntime): (invocation: DshCommandInvocation) => Promise<DshCommandResult> {
  return async (invocation) => {
    const sessionId = invocation.agent.session?.id ?? invocation.agent.id;
    const [verb = '', ...args] = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
    const host = runtime.host;
    if (host === undefined) {
      const reasons = runtime.problems.length > 0 ? runtime.problems : ['the host is still starting'];
      return { kind: 'error', text: `DSH Remote is not ready:\n${reasons.map((p) => `- ${p}`).join('\n')}\nRun \`dsh-remote doctor\` for details.` };
    }
    switch (verb) {
      case '':
      case 'pair': {
        const devices = host.devices().filter((d) => !d.revoked);
        return {
          kind: 'success',
          text: [
            `To pair a phone, send /rc on its own in DSH Web: it shows a QR code to scan in DSH Remote (Connect host), then the phone's key fingerprint to approve.`,
            `Or run this in a terminal on this machine:`,
            `  ${cliCommand()} pair`,
            `Paired phones: ${devices.length}${devices.length === 0 ? '' : ` (${devices.map((d) => d.label).join(', ')})`}`,
          ].join('\n'),
        };
      }
      case 'status': {
        const status = host.status();
        const devices = host.devices().filter((d) => !d.revoked);
        const relay = status.transport === null ? 'not running' : (status.transport.homeRelay ?? (status.transport.relays.length === 0 ? 'direct only' : 'no relay yet'));
        return {
          kind: 'success',
          text: [
            `Host: ${status.hostName} (id ${shortPeerId(status.hostId)})`,
            `Relay: ${relay}`,
            `Paired phones: ${devices.length}${devices.length === 0 ? '' : ` (${devices.map((d) => d.label).join(', ')})`}`,
            `Waiting for approval: ${status.pendingPairings}`,
            `Notifications: ${status.push.gateway === null ? 'off (pushGateway is null)' : `on, through gateway ${shortPeerId(status.push.gateway)} (${status.push.devices} phone${status.push.devices === 1 ? '' : 's'} registered)`}`,
            ...(status.mobileUi === null ? [] : [`Phone layout: ${status.mobileUi.ok ? `dsh-mobile-maxxing ${status.mobileUi.version}` : `missing — ${status.mobileUi.problem}`}`]),
          ].join('\n'),
        };
      }
      // From the native app: phones no longer use published sessions, but `off` keeps working.
      case 'off': {
        await host.unpublish(sessionId);
        return { kind: 'success', text: 'Remote control is off for this session. Local work continues; phones can no longer see or control it.' };
      }
      case 'devices': {
        const devices = host.devices();
        if (devices.length === 0) return { kind: 'success', text: 'No paired phones.' };
        return {
          kind: 'success',
          text: devices
            .map((d) => `${d.revoked ? '[revoked] ' : ''}${d.label} (${d.platform}) ${d.deviceId}  key ${d.shortFingerprint}  ${d.lastSeenAt === null ? 'never seen' : `last seen ${new Date(d.lastSeenAt).toISOString()}`}`)
            .join('\n'),
        };
      }
      case 'revoke': {
        const deviceId = args[0];
        if (deviceId === undefined) return { kind: 'error', text: USAGE };
        return (await host.revokeDevice(deviceId))
          ? { kind: 'success', text: `Revoked ${deviceId}; its connections were closed.` }
          : { kind: 'error', text: `No active device ${deviceId}.` };
      }
      default:
        return { kind: 'error', text: USAGE };
    }
  };
}
