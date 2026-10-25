import { randomBytes } from 'node:crypto';

/** Opaque random identifier with a type prefix; 18 bytes give 24 base64url characters. */
export function randomId(prefix: 'host' | 'dev' | 'chl' | 'pair' | 'turn' | 'apr' | 'trace' | 'lease', bytes = 18): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}
