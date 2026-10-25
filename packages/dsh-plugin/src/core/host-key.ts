import { createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writePrivateFileAtomic } from './store.ts';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SEED_TEXT = /^[A-Za-z0-9_-]{43}$/;

/**
 * The host's iroh secret key, an Ed25519 seed. Its public key is the host's
 * EndpointId: the pairing ticket names it and QUIC proves it on every
 * connection, so it is also the host id. Signing here matches iroh's
 * `SecretKey.sign` byte for byte (both are RFC 8032 Ed25519).
 */
export class HostKey {
  readonly endpointId: string;

  private readonly seed: Buffer;
  private readonly privateKey: KeyObject;

  private constructor(seed: Buffer) {
    this.seed = seed;
    this.privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    this.endpointId = createPublicKey(this.privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  }

  static fromSeed(seed: Uint8Array): HostKey {
    if (seed.length !== 32) throw new Error('dsh-remote: an iroh secret key is 32 bytes');
    return new HostKey(Buffer.from(seed));
  }

  static generate(): HostKey {
    return new HostKey(randomBytes(32));
  }

  /** Load `path` (base64url seed), creating it owner-only on first use. */
  static async loadOrCreate(path: string): Promise<HostKey> {
    try {
      const text = (await readFile(path, 'utf8')).trim();
      if (!SEED_TEXT.test(text)) throw new Error(`dsh-remote: ${path} is not an iroh secret key`);
      return HostKey.fromSeed(Buffer.from(text, 'base64url'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const key = HostKey.generate();
    await writePrivateFileAtomic(path, `${key.seed.toString('base64url')}\n`);
    return key;
  }

  /** The seed in the form the iroh endpoint builder takes. */
  secretKeyBytes(): number[] {
    return Array.from(this.seed);
  }

  sign(message: Uint8Array): Buffer {
    return sign(null, message, this.privateKey);
  }
}
