// DSH Remote push gateway. Configuration comes from the environment:
//   DSHR_PUSH_STATE_DIR  key and database (default: $STATE_DIRECTORY, else ./.push-state)
//   DSHR_PUSH_RELAYS     comma-separated relay URLs, or "none" (default: nrt1)
//   DSHR_PUSH_BIND       optional host:port for the QUIC socket
//   APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC, and the key in $CREDENTIALS_DIRECTORY/apns.p8 (or APNS_KEY_FILE)
//   the FCM service account in $CREDENTIALS_DIRECTORY/fcm.json (or FCM_SERVICE_ACCOUNT_FILE)
// A platform without credentials is off: the gateway refuses its registrations.
// `--print-id` prints the gateway's EndpointId and ticket, then exits.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PushPlatform } from '@dsh-remote/protocol/push';
import { Gateway } from './gateway.ts';
import { loadOrCreateKey } from './key.ts';
import { ApnsSender } from './senders/apns.ts';
import { FcmSender, parseServiceAccount } from './senders/fcm.ts';
import type { Sender } from './senders/types.ts';
import { HandleStore } from './store.ts';
import { GatewayTransport } from './transport.ts';

const DEFAULT_RELAYS = ['https://nrt1.relay.dshremote.pentacoxian.dev/'];
const HANDLE_IDLE_MS = 90 * 86_400_000;
const STATS_INTERVAL_MS = 60_000;

const env = process.env;
const stateDir = env.DSHR_PUSH_STATE_DIR ?? env.STATE_DIRECTORY ?? '.push-state';
const relays = env.DSHR_PUSH_RELAYS === undefined ? DEFAULT_RELAYS : env.DSHR_PUSH_RELAYS === 'none' ? [] : env.DSHR_PUSH_RELAYS.split(',').map((url) => url.trim());
const credential = (name: string, override: string | undefined) => {
  const path = override ?? (env.CREDENTIALS_DIRECTORY === undefined ? undefined : join(env.CREDENTIALS_DIRECTORY, name));
  return path !== undefined && existsSync(path) ? readFileSync(path, 'utf8') : undefined;
};

function senders(): Partial<Record<PushPlatform, Sender>> {
  const result: Partial<Record<PushPlatform, Sender>> = {};
  const apnsKey = credential('apns.p8', env.APNS_KEY_FILE);
  if (apnsKey !== undefined && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC) {
    result.apns = new ApnsSender({ key: apnsKey, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_TOPIC });
  }
  const fcm = credential('fcm.json', env.FCM_SERVICE_ACCOUNT_FILE);
  if (fcm !== undefined) result.fcm = new FcmSender({ serviceAccount: parseServiceAccount(fcm) });
  return result;
}

const secretKey = await loadOrCreateKey(join(stateDir, 'endpoint-key'));
if (process.argv.includes('--print-id')) {
  const transport = await GatewayTransport.start({ secretKey, relays, onStream: (stream) => stream.destroy() });
  await transport.online(10_000);
  console.log(`${transport.endpointId}\n${transport.ticket()}`);
  await transport.close();
  process.exit(0);
}

const store = HandleStore.open(join(stateDir, 'handles.db'));
const active = senders();
const gateway = new Gateway({ store, senders: active });
const transport = await GatewayTransport.start({
  secretKey,
  relays,
  ...(env.DSHR_PUSH_BIND === undefined ? {} : { bindAddr: env.DSHR_PUSH_BIND }),
  onStream: (stream, peerId) => gateway.accept(stream, peerId),
});
const online = await transport.online(15_000);
console.log(`push-gateway: ${transport.endpointId} ${online ? 'online' : 'not yet connected to a relay'} via ${relays.length === 0 ? 'direct addresses' : relays.join(', ')}; platforms: ${Object.keys(active).join(', ') || 'none'}; ${store.size()} handles`);
console.log(`push-gateway: ticket ${transport.ticket()}`);

let last = { ...gateway.stats };
const timer = setInterval(() => {
  const now = gateway.stats;
  const delta = { delivered: now.delivered - last.delivered, gone: now.gone - last.gone, failed: now.failed - last.failed, registered: now.registered - last.registered };
  last = { ...now };
  const pruned = store.prune(Date.now() - HANDLE_IDLE_MS);
  if (Object.values(delta).some((n) => n > 0) || pruned > 0) {
    console.log(`push-gateway: last minute ${delta.delivered} delivered, ${delta.gone} gone, ${delta.failed} failed, ${delta.registered} registrations; ${pruned} idle handles pruned; ${store.size()} handles, ${transport.connections} connections`);
  }
}, STATS_INTERVAL_MS);

const stop = async () => {
  clearInterval(timer);
  await transport.close();
  gateway.server.close();
  for (const sender of Object.values(active)) sender.close();
  store.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
