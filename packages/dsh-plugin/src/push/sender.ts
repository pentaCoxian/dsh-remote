import type { HttpReply } from '@dsh-remote/iroh-http';
import { sealPush, type PushMessage } from '@dsh-remote/protocol';
import type { DeviceRecord, HostState } from '../core/state.ts';

/** What the sender needs from the push gateway connection. */
export interface GatewayLink {
  /** The gateway's EndpointId; a device registered with another gateway cannot be reached. */
  readonly id: string;
  request(method: string, path: string, body?: unknown): Promise<HttpReply>;
  close(): void;
}

export interface DeliveryOptions {
  readonly urgency: 'high' | 'normal';
  readonly collapseId?: string;
}

export type DeliveryResult = 'sent' | 'gone' | 'unreachable';

const RETRY_DELAY_MS = 3_000;

/**
 * Seals a notification with the device's own key and hands it to the push
 * gateway. A handle the gateway no longer knows (or whose token APNs/FCM
 * dropped) clears the device's registration; the app registers again when it
 * next opens this host.
 */
export class PushSender {
  private readonly state: HostState;
  private readonly gateway: () => GatewayLink | undefined;

  constructor(state: HostState, gateway: () => GatewayLink | undefined) {
    this.state = state;
    this.gateway = gateway;
  }

  async deliver(device: DeviceRecord, message: PushMessage, options: DeliveryOptions): Promise<DeliveryResult> {
    const push = device.push;
    const gateway = this.gateway();
    if (push === undefined || gateway === undefined || gateway.id !== push.gateway) return 'unreachable';
    const body = {
      handle: push.handle,
      envelope: sealPush(Buffer.from(push.key, 'base64url'), push.handle, message),
      urgency: options.urgency,
      ...(options.collapseId === undefined ? {} : { collapseId: options.collapseId }),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      const reply = await gateway.request('POST', '/v1/push', body).catch(() => undefined);
      if (reply?.status === 202) return 'sent';
      if (reply?.status === 410) {
        // Only if the registration is still the one we sent to.
        if (this.state.device(device.deviceId)?.push?.handle === push.handle) await this.state.setPush(device.deviceId, undefined);
        return 'gone';
      }
      // Retry network failures and the gateway's 503 (APNs/FCM briefly unavailable) once.
      if (reply !== undefined && reply.status !== 503) return 'unreachable';
    }
    return 'unreachable';
  }
}
