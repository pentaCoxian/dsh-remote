import { randomBytes } from 'node:crypto';
import { decodeBase64Url, DEFAULT_PUSH_EVENTS, PROTOCOL_VERSION, type PushEvents, type PushPlatform } from '@dsh-remote/protocol';
import type { Clock } from '../core/clock.ts';
import type { DeviceRecord, HostState } from '../core/state.ts';
import { ApiError, type Route } from '../http/server.ts';
import type { PushSender } from '../push/sender.ts';

/** The push gateway this host sends through: its ticket (for phones) and EndpointId. */
export interface PushGatewayConfig {
  readonly ticket: string;
  readonly id: string;
}

export interface PushRouteDeps {
  readonly state: HostState;
  readonly clock: Clock;
  readonly hostId: string;
  readonly hostName: string;
  /** Undefined: notifications are off on this host. */
  readonly gateway: PushGatewayConfig | undefined;
  readonly sender: PushSender;
}

interface RegistrationBody {
  readonly gateway: string;
  readonly handle: string;
  readonly key: string;
  readonly platform: PushPlatform;
  readonly events: PushEvents;
}

/**
 * `/v1/push`: the phone tells the host where and how to notify it. The phone
 * registers its device token with the host's gateway itself (the host never
 * sees it) and sends the handle it got, plus a fresh key that only it and this
 * host hold, over this signed request.
 */
export function pushRoutes(deps: PushRouteDeps): Route[] {
  const status = (device: DeviceRecord | undefined) => ({
    v: PROTOCOL_VERSION,
    gateway: deps.gateway?.ticket ?? null,
    registered: device?.push !== undefined && device.push.gateway === deps.gateway?.id,
    events: device?.push?.events ?? DEFAULT_PUSH_EVENTS,
  });
  return [
    {
      method: 'GET',
      path: '/v1/push',
      auth: 'device',
      scope: 'push:register',
      async handle({ device }) {
        return { status: 200, body: status(device) };
      },
    },
    {
      method: 'PUT',
      path: '/v1/push',
      auth: 'device',
      scope: 'push:register',
      body: 'PushRegistrationRequest',
      async handle({ device, body }) {
        const request = body as RegistrationBody;
        if (deps.gateway === undefined) throw new ApiError('UNAVAILABLE', 'Notifications are off on this host');
        if (request.gateway !== deps.gateway.id) throw new ApiError('BAD_REQUEST', 'Register with this host’s push gateway');
        if (decodeBase64Url(request.key)?.length !== 32) throw new ApiError('BAD_REQUEST');
        await deps.state.setPush(device.deviceId, { gateway: request.gateway, handle: request.handle, key: request.key, platform: request.platform, events: request.events, registeredAt: deps.clock.now() });
        return { status: 200, body: status(deps.state.device(device.deviceId)) };
      },
    },
    {
      method: 'DELETE',
      path: '/v1/push',
      auth: 'device',
      scope: 'push:register',
      async handle({ device }) {
        await deps.state.setPush(device.deviceId, undefined);
        return { status: 200, body: status(deps.state.device(device.deviceId)) };
      },
    },
    {
      method: 'POST',
      path: '/v1/push/test',
      auth: 'device',
      scope: 'push:register',
      async handle({ device }) {
        if (!status(device).registered) throw new ApiError('NOT_FOUND', 'This phone is not registered for notifications');
        const message = { v: 1 as const, id: `n_${randomBytes(12).toString('base64url')}`, kind: 'test' as const, hostId: deps.hostId, hostName: deps.hostName, title: 'Test notification', body: 'Notifications from this host work.', ts: deps.clock.now() };
        const result = await deps.sender.deliver(device, message, { urgency: 'high' });
        if (result === 'gone') throw new ApiError('HANDLE_GONE', 'The push gateway no longer reaches this phone; register again');
        if (result !== 'sent') throw new ApiError('UNAVAILABLE', 'The push gateway cannot be reached right now');
        return { status: 202, body: { v: PROTOCOL_VERSION } };
      },
    },
  ];
}
