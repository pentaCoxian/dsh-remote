// The gateway as a library, for tests that run one in-process (the plugin's push tests).
export { Gateway, type GatewayOptions } from './gateway.ts';
export type { OutboundPush, Sender, SendOutcome } from './senders/types.ts';
export { HandleStore } from './store.ts';
export { GatewayTransport } from './transport.ts';
