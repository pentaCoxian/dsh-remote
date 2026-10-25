import { metaRoutes } from '../../src/api/meta.ts';
import { pairingRoutes } from '../../src/api/pairing.ts';
import { MemoryAudit } from '../../src/core/audit.ts';
import { systemClock, type Clock } from '../../src/core/clock.ts';
import { HostKey } from '../../src/core/host-key.ts';
import { Pairing } from '../../src/core/pairing.ts';
import { ProofVerifier } from '../../src/core/proof.ts';
import { HostState } from '../../src/core/state.ts';
import { MemoryStore } from '../../src/core/store.ts';
import { NativeApi, type Route, type UpgradeRoute } from '../../src/http/server.ts';
import { randomPeerId, send, TEST_PEER_HEADER, testPeerIdentity, toBody, TestPhone, type Reply, type SendOptions } from './phone.ts';

export interface TestHostOptions {
  readonly clock?: Clock;
  /** How long ago the host process "started" (signatures before that are refused). */
  readonly bootAgeMs?: number;
  readonly routes?: (host: Omit<TestHost, 'api' | 'port' | 'close'>) => Route[];
  readonly upgrade?: (host: Omit<TestHost, 'api' | 'port' | 'close'>) => UpgradeRoute;
}

/** Who a request comes from: a peer id, the phone's own (default), or nobody (`null`). */
type Peer = { peer?: string | null };

export interface TestHost {
  readonly clock: Clock;
  readonly state: HostState;
  readonly hostKey: HostKey;
  readonly proof: ProofVerifier;
  readonly pairing: Pairing;
  readonly audit: MemoryAudit;
  readonly api: NativeApi;
  readonly port: number;
  /** Send from `peer` (default: a fresh one) with `headers`. */
  call(options: SendOptions & Peer): Promise<Reply>;
  /** Send signed by `phone`, from the phone's peer id unless `peer` says otherwise. */
  signed(phone: TestPhone, options: SendOptions & Peer & { sign?: Parameters<TestPhone['proofHeaders']>[3] }): Promise<Reply>;
  /** Complete QR pairing for `phone` through the real routes; returns the status reply. */
  pair(phone: TestPhone, options?: Peer & { sessionId?: string }): Promise<Reply>;
  close(): Promise<void>;
}

export async function startTestHost(options: TestHostOptions = {}): Promise<TestHost> {
  const clock = options.clock ?? systemClock;
  const state = await HostState.open(new MemoryStore(), clock);
  const hostKey = HostKey.generate();
  const proof = new ProofVerifier(state, clock, clock.now() - (options.bootAgeMs ?? 5_000));
  const pairing = new Pairing(state, hostKey.endpointId, clock, { grantTtlMs: 90 * 24 * 3600_000 });
  const audit = new MemoryAudit();
  const parts = { clock, state, hostKey, proof, pairing, audit } as Omit<TestHost, 'api' | 'port' | 'close'>;

  const call: TestHost['call'] = async ({ peer, ...rest }) => {
    const from = peer === undefined ? randomPeerId() : peer;
    return send(port, { ...rest, headers: { ...(from === null ? {} : { [TEST_PEER_HEADER]: from }), ...rest.headers } });
  };
  const signed: TestHost['signed'] = async (phone, { sign, peer, ...rest }) =>
    call({ ...rest, peer: peer === undefined ? phone.peerId : peer, headers: { ...phone.proofHeaders(rest.method, rest.target, toBody(rest.body), sign), ...rest.headers } });

  const pair: TestHost['pair'] = async (phone, pairOptions = {}) => {
    const challenge = pairing.createChallenge(pairOptions.sessionId);
    const from = pairOptions.peer === undefined ? {} : { peer: pairOptions.peer };
    const redeem = await signed(phone, {
      method: 'POST',
      target: '/v1/pair/redeem',
      body: { challengeId: challenge.challengeId, publicKey: phone.publicKey, deviceLabel: 'Test Phone', platform: 'android', hardwareBacked: true },
      ...from,
    });
    if (redeem.status !== 201) throw new Error(`redeem failed: ${redeem.text}`);
    await pairing.approve(redeem.json.pairingRequestId);
    const status = await signed(phone, { method: 'GET', target: `/v1/pair/requests/${redeem.json.pairingRequestId}`, ...from });
    phone.deviceId = status.json.grant.deviceId;
    return status;
  };

  const api = new NativeApi({
    proof,
    routes: [
      ...metaRoutes({ hostId: hostKey.endpointId, clock, hostName: 'Home Lab', capabilities: ['sessions', 'approvals'], address: () => undefined }),
      ...pairingRoutes({ pairing, proof }),
      ...(options.routes?.(parts) ?? []),
    ],
    ...(options.upgrade === undefined ? {} : { upgrade: options.upgrade(parts) }),
    audit,
    clock,
    loopbackIdentity: testPeerIdentity,
  });
  const port = await api.listen(0);
  return { ...parts, api, port, call, signed, pair, close: () => api.close() };
}
