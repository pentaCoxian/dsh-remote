// DEV ONLY. A push gateway on this machine for trying notifications before (or
// instead of) the one on nrt1. Platforms with credentials in the environment
// (as for src/main.ts: APNS_KEY_FILE, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC,
// FCM_SERVICE_ACCOUNT_FILE) really send; the others only log what they would send.
//
//   node --conditions=source scripts/dev-gateway.ts [--relays default|none|<url>,<url>] [--state DIR]
//
// Prints the gateway ticket for the host's pushGateway (real-host.ts --push-gateway).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PushPlatform } from '@dsh-remote/protocol/push';
import { Gateway } from '../src/gateway.ts';
import { loadOrCreateKey } from '../src/key.ts';
import { ApnsSender } from '../src/senders/apns.ts';
import { FcmSender, parseServiceAccount } from '../src/senders/fcm.ts';
import type { OutboundPush, Sender, SendOutcome } from '../src/senders/types.ts';
import { HandleStore } from '../src/store.ts';
import { GatewayTransport } from '../src/transport.ts';

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const relaysOption = option('--relays') ?? 'default';
const relays = relaysOption === 'none' ? [] : relaysOption === 'default' ? ['https://nrt1.relay.dshremote.pentacoxian.dev/'] : relaysOption.split(',');
const state = resolve(option('--state') ?? join(import.meta.dirname, '../../../.dsh-home/dev-gateway'));
const env = process.env;

class LoggingSender implements Sender {
  readonly platform: PushPlatform;
  constructor(platform: PushPlatform) {
    this.platform = platform;
  }
  async send(push: OutboundPush): Promise<SendOutcome> {
    console.log(`[${this.platform}, not sent] ${push.urgency} push for token ${push.token.slice(0, 12)}… (${push.env ?? 'fcm'}), ${push.envelope.length}-char envelope, collapse ${push.collapseId ?? '-'}`);
    return { ok: true };
  }
  close(): void {}
}

const senders: Partial<Record<PushPlatform, Sender>> = {
  apns: env.APNS_KEY_FILE && env.APNS_KEY_ID && env.APNS_TEAM_ID
    ? new ApnsSender({ key: readFileSync(env.APNS_KEY_FILE, 'utf8'), keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_TOPIC ?? 'dev.dshremote.dshRemote' })
    : new LoggingSender('apns'),
  fcm: env.FCM_SERVICE_ACCOUNT_FILE ? new FcmSender({ serviceAccount: parseServiceAccount(readFileSync(env.FCM_SERVICE_ACCOUNT_FILE, 'utf8')) }) : new LoggingSender('fcm'),
};
const store = HandleStore.open(join(state, 'handles.db'));
const gateway = new Gateway({ store, senders });
const original = gateway.stats;
const transport = await GatewayTransport.start({ secretKey: await loadOrCreateKey(join(state, 'endpoint-key')), relays, onStream: (stream, peerId) => gateway.accept(stream, peerId) });
await transport.online(15_000);
console.log(`Dev push gateway ${transport.endpointId.slice(0, 10)} · apns ${senders.apns instanceof LoggingSender ? 'logs only' : 'sends'} · fcm ${senders.fcm instanceof LoggingSender ? 'logs only' : 'sends'} · ${store.size()} handles`);
console.log(transport.ticket());
let seen = { ...original };
setInterval(() => {
  const now = gateway.stats;
  if (now.registered !== seen.registered) console.log(`registrations: ${now.registered} (handles: ${store.size()})`);
  if (now.gone !== seen.gone || now.failed !== seen.failed) console.log(`gone ${now.gone}, failed ${now.failed}`);
  seen = { ...now };
}, 1_000);
const stop = async () => {
  await transport.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
