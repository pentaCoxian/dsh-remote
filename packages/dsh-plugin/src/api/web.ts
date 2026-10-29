import { PROTOCOL_VERSION } from '@dsh-remote/protocol';
import { ApiError, type Route } from '../http/server.ts';
import type { MobileUiStatus } from '../dsh/mobile-ui.ts';
import type { WebGateway } from '../web/gateway.ts';

/**
 * `POST /v1/web/session`: open this device's DSH Web window. It needs the
 * device's hardware-key signature like every route, so a copied iroh key alone
 * cannot open the tunnel. The reply carries DSH's launch-token query for the
 * WebView's first load; DSH then sets its own owner cookie.
 */
export function webRoutes(gateway: WebGateway, mobileUi?: () => MobileUiStatus): Route[] {
  return [
    {
      method: 'POST',
      path: '/v1/web/session',
      auth: 'device',
      scope: 'web:open',
      async handle({ device }) {
        const session = await gateway.open(device);
        if (session === undefined) throw new ApiError('UNAVAILABLE', 'DSH Web cannot be opened remotely right now');
        // Whether DSH Web will look right on the phone; the app says so when not.
        const layout = mobileUi?.();
        return { status: 200, body: { v: PROTOCOL_VERSION, tokenQuery: session.tokenQuery, expiresAt: session.expiresAt, ...(layout === undefined ? {} : { mobileUi: { ok: layout.ok, version: layout.version } }) } };
      },
    },
  ];
}
