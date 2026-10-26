// Interop fixture for the phone's Rust pipe (apps/mobile/native/dshr_pipe,
// tests/interop.rs): a RemoteHost on FakeAdapter over iroh, relays off. Prints
// one JSON line {hostId, url} and runs until stdin closes.
//   node --conditions=source test/fixtures/iroh-host.ts
import { startLiveHost } from '../helpers/live.ts';

const live = await startLiveHost({ iroh: true });
const offer = live.host.offerPairing('session-a');
process.stdout.write(`${JSON.stringify({ hostId: live.host.hostId, url: offer.url })}\n`);
process.stdin.resume();
process.stdin.on('end', async () => {
  await live.close();
  process.exit(0);
});
