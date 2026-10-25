import QRCode from 'qrcode';
import type { SessionAdapter } from '../core/adapter.ts';
import type { PairingOffer, RemoteHost } from '../host.ts';
import { AdminError, parseAdminRequest, runAdmin } from '../admin/ops.ts';
import type { DshFetchRoute } from './types.ts';

export const ADMIN_PATH = '/api/dsh-remote/admin';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/**
 * Owner-only admin endpoint for the `/rc` card in DSH Web. DSH Connection
 * already admits only the owner's browser cookie past its Host/Origin fence;
 * the custom header additionally forces a CORS preflight no other origin passes.
 */
export function adminRoute(host: () => RemoteHost | undefined, adapter: () => SessionAdapter | undefined): DshFetchRoute {
  return {
    path: ADMIN_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('x-dsh-remote') !== '1' || !/^application\/json/i.test(request.headers.get('content-type') ?? '')) {
        return json(400, { error: 'bad request' });
      }
      const current = host();
      const sessions = adapter();
      if (current === undefined || sessions === undefined) return json(503, { error: 'DSH Remote is not ready' });
      try {
        const admin = parseAdminRequest(await request.json());
        const result = await runAdmin(current, sessions, admin);
        if (admin.method === 'offerPairing') {
          const offer = result as PairingOffer;
          return json(200, { ...offer, qrSvg: await QRCode.toString(offer.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) });
        }
        return json(200, result);
      } catch (error) {
        return json(400, { error: error instanceof AdminError ? error.message : 'bad request' });
      }
    },
  };
}
