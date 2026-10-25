import type { RemoteHost } from '../host.ts';
import type { DshCommandInvocation, DshCommandResult } from './types.ts';

export interface RcRuntime {
  host: RemoteHost | undefined;
  problems: string[];
  hostName: string;
}

const USAGE = 'Usage: /rc [status | pair | off | devices | revoke <deviceId>]';

/**
 * `/rc` and `/remote-control`. Command text is written to the DSH session log,
 * so replies carry no QR, challenge or link: the `/rc` card and
 * `dsh-remote pair` fetch those live from owner-only surfaces.
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
        await host.publish(sessionId);
        return {
          kind: 'success',
          text: [
            `Remote control is on for this session (${sessionId}).`,
            `New phone: DSH Remote → Connect Host → scan the code in this card.`,
            `Paired phone: DSH Remote → ${runtime.hostName} → Continue.`,
            `From a terminal: dsh-remote pair --session ${sessionId}`,
          ].join('\n'),
        };
      }
      case 'status': {
        const status = host.status();
        const devices = host.devices().filter((d) => !d.revoked);
        return {
          kind: 'success',
          text: [
            `Host: ${status.hostName} (${status.origin})`,
            `This session: ${host.isPublished(sessionId) ? 'remote control on' : 'remote control off'}`,
            `Published sessions: ${status.published.length}`,
            `Paired phones: ${devices.length}${devices.length === 0 ? '' : ` (${devices.map((d) => d.label).join(', ')})`}`,
            `Waiting for approval: ${status.pendingPairings}`,
            `Host key: ${status.hostKeyFingerprint}`,
          ].join('\n'),
        };
      }
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
