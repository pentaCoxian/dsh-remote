import { HEADERS } from '@dsh-remote/protocol';
import { metaRoutes } from '../../src/api/meta.ts';
import { pairingRoutes } from '../../src/api/pairing.ts';
import { MemoryAudit } from '../../src/core/audit.ts';
import { systemClock, type Clock } from '../../src/core/clock.ts';
import { HostIdentity } from '../../src/core/host-identity.ts';
import { Pairing } from '../../src/core/pairing.ts';
import { ProofVerifier } from '../../src/core/proof.ts';
import { HostState } from '../../src/core/state.ts';
import { MemoryStore } from '../../src/core/store.ts';
import { NativeApi, type Route, type UpgradeRoute } from '../../src/http/server.ts';
import { testIssuer, type TestIssuer } from './access.ts';
import { send, toBody, TestPhone, type Reply, type SendOptions } from './phone.ts';

export interface TestHostOptions {
  readonly clock?: Clock;
  /** How long ago the host process "started" (signatures before that are refused). */
  readonly bootAgeMs?: number;
  readonly routes?: (host: Omit<TestHost, 'api' | 'port' | 'close'>) => Route[];
  readonly upgrade?: (host: Omit<TestHost, 'api' | 'port' | 'close'>) => UpgradeRoute;
}

export interface TestHost {
  readonly issuer: TestIssuer;
  readonly clock: Clock;
  readonly state: HostState;
  readonly identity: HostIdentity;
  readonly proof: ProofVerifier;
  readonly pairing: Pairing;
  readonly audit: MemoryAudit;
  readonly api: NativeApi;
  readonly port: number;
  /** Send with a valid Access assertion for `sub` (default owner) plus `headers`. */
  call(options: SendOptions & { sub?: string; assertion?: string | null }): Promise<Reply>;
  /** Send signed by `phone` with a valid Access assertion. */
  signed(phone: TestPhone, options: SendOptions & { sub?: string; sign?: Parameters<TestPhone['proofHeaders']>[3] }): Promise<Reply>;
  /** Complete QR pairing for `phone` through the real routes; returns the status reply. */
  pair(phone: TestPhone, options?: { sub?: string; sessionId?: string }): Promise<Reply>;
  close(): Promise<void>;
}

export async function startTestHost(options: TestHostOptions = {}): Promise<TestHost> {
  const clock = options.clock ?? systemClock;
  const issuer = await testIssuer();
  const state = await HostState.open(new MemoryStore(), clock);
  const identity = HostIdentity.generate();
  const proof = new ProofVerifier(state, clock, clock.now() - (options.bootAgeMs ?? 5_000));
  const pairing = new Pairing(state, identity, clock, { grantTtlMs: 90 * 24 * 3600_000 });
  const audit = new MemoryAudit();
  const parts = { issuer, clock, state, identity, proof, pairing, audit } as Omit<TestHost, 'api' | 'port' | 'close'>;

  const call: TestHost['call'] = async ({ sub, assertion, ...rest }) => {
    const token = assertion === null ? undefined : (assertion ?? (await issuer.assertion(sub === undefined ? {} : { sub })));
    return send(port, { ...rest, headers: { ...(token === undefined ? {} : { [HEADERS.accessAssertion]: token }), ...rest.headers } });
  };
  const signed: TestHost['signed'] = async (phone, { sign, ...rest }) =>
    call({ ...rest, headers: { ...phone.proofHeaders(rest.method, rest.target, toBody(rest.body), sign), ...rest.headers } });

  const pair: TestHost['pair'] = async (phone, pairOptions = {}) => {
    const challenge = pairing.createChallenge(pairOptions.sessionId);
    const redeem = await signed(phone, {
      method: 'POST',
      target: '/v1/pair/redeem',
      body: { challengeId: challenge.challengeId, publicKey: phone.publicKey, deviceLabel: 'Test Phone', platform: 'android', hardwareBacked: true },
      ...(pairOptions.sub === undefined ? {} : { sub: pairOptions.sub }),
    });
    if (redeem.status !== 201) throw new Error(`redeem failed: ${redeem.text}`);
    await pairing.approve(redeem.json.pairingRequestId);
    const status = await signed(phone, { method: 'GET', target: `/v1/pair/requests/${redeem.json.pairingRequestId}`, ...(pairOptions.sub === undefined ? {} : { sub: pairOptions.sub }) });
    phone.deviceId = status.json.grant.deviceId;
    return status;
  };

  const api = new NativeApi({
    publicHost: 'dsh.example.com',
    port: 0,
    access: issuer.verifier,
    proof,
    routes: [
      ...metaRoutes({ state, clock, hostName: 'Home Lab', capabilities: ['sessions', 'approvals'] }),
      ...pairingRoutes({ pairing, proof, host: identity }),
      ...(options.routes?.(parts) ?? []),
    ],
    ...(options.upgrade === undefined ? {} : { upgrade: options.upgrade(parts) }),
    audit,
    clock,
  });
  const port = await api.listen();
  return { ...parts, api, port, call, signed, pair, close: () => api.close() };
}
