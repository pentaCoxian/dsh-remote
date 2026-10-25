import { PROTOCOL_MINOR, PROTOCOL_VERSION } from '@dsh-remote/protocol';
import type { Clock } from '../core/clock.ts';
import { ApiError, type Route } from '../http/server.ts';

export interface HostAddress {
  readonly ticket: string;
  readonly relayUrl: string | null;
}

export interface MetaDeps {
  /** The host's EndpointId. */
  readonly hostId: string;
  readonly clock: Clock;
  readonly hostName: string;
  readonly capabilities: readonly string[];
  /** Where the host is reachable now; undefined while no iroh endpoint runs. */
  readonly address: () => HostAddress | undefined;
}

/** `GET /v1/meta` and `GET /v1/host/address`; protected like every other route, neither is a public probe. */
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
            hostId: deps.hostId,
            hostName: deps.hostName,
            protocol: { major: PROTOCOL_VERSION, minor: PROTOCOL_MINOR },
            capabilities: deps.capabilities,
            device: { deviceId: device.deviceId, label: device.label, scopes: device.scopes, expiresAt: device.expiresAt },
            serverTime: deps.clock.now(),
          },
        };
      },
    },
    {
      method: 'GET',
      path: '/v1/host/address',
      auth: 'device',
      scope: 'host:read',
      async handle() {
        const address = deps.address();
        if (address === undefined) throw new ApiError('UNAVAILABLE');
        return { status: 200, body: { v: PROTOCOL_VERSION, hostId: deps.hostId, ticket: address.ticket, relayUrl: address.relayUrl, serverTime: deps.clock.now() } };
      },
    },
  ];
}
