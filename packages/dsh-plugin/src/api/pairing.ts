import type { HostIdentity } from '../core/host-identity.ts';
import type { Pairing, RedeemBody } from '../core/pairing.ts';
import type { ProofVerifier } from '../core/proof.ts';
import { ApiError, type Route } from '../http/server.ts';

export interface PairingDeps {
  readonly pairing: Pairing;
  readonly proof: ProofVerifier;
  readonly host: HostIdentity;
}

const PAIRING_REQUEST_ID = /^pair_[A-Za-z0-9_-]{22,64}$/;

/**
 * Phone side of pairing (spec §5): redeem a QR challenge with a fresh key, then
 * poll until the local owner decides. There is deliberately no approve route.
 */
export function pairingRoutes(deps: PairingDeps): Route[] {
  return [
    {
      method: 'POST',
      path: '/v1/pair/redeem',
      auth: 'pending',
      body: 'PairRedeemRequest',
      async handle({ identity, body, signed }) {
        const result = deps.pairing.redeem(identity, body as RedeemBody, (key, fingerprint) => deps.proof.verifyPendingKey(signed, key, fingerprint));
        if (!result.ok) throw new ApiError(result.code, undefined, result.serverTime === undefined ? {} : { serverTime: result.serverTime });
        return {
          status: 201,
          body: {
            pairingRequestId: result.request.pairingRequestId,
            expiresAt: result.request.expiresAt,
            hostKey: { publicKey: deps.host.publicKey, fingerprint: deps.host.fingerprint },
          },
        };
      },
    },
    {
      method: 'GET',
      path: '/v1/pair/requests/:pairingRequestId',
      auth: 'pending',
      async handle({ identity, params, signed }) {
        const id = params.pairingRequestId!;
        if (!PAIRING_REQUEST_ID.test(id)) throw new ApiError('NOT_FOUND');
        const result = deps.pairing.status(id, identity, (key, fingerprint) => deps.proof.verifyPendingKey(signed, key, fingerprint));
        if (!result.ok) throw new ApiError(result.code, undefined, result.serverTime === undefined ? {} : { serverTime: result.serverTime });
        return { status: 200, body: result.grant === undefined ? { state: result.state } : { state: result.state, grant: result.grant } };
      },
    },
  ];
}
