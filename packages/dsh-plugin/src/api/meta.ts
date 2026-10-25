import { PROTOCOL_MINOR, PROTOCOL_VERSION } from '@dsh-remote/protocol';
import type { Clock } from '../core/clock.ts';
import type { HostState } from '../core/state.ts';
import type { Route } from '../http/server.ts';

export interface MetaDeps {
  readonly state: HostState;
  readonly clock: Clock;
  readonly hostName: string;
  readonly capabilities: readonly string[];
}

/** `GET /v1/meta` — protected like every other route; it is not a public health probe. */
export function metaRoutes(deps: MetaDeps): Route[] {
  return [
    {
      method: 'GET',
      path: '/v1/meta',
      auth: 'device',
      scope: 'host:read',
      async handle({ device }) {
        return {
          status: 200,
          body: {
            v: PROTOCOL_VERSION,
            hostId: deps.state.hostId,
            hostName: deps.hostName,
            protocol: { major: PROTOCOL_VERSION, minor: PROTOCOL_MINOR },
            capabilities: deps.capabilities,
            device: { deviceId: device.deviceId, label: device.label, scopes: device.scopes, expiresAt: device.expiresAt },
            serverTime: deps.clock.now(),
          },
        };
      },
    },
  ];
}
