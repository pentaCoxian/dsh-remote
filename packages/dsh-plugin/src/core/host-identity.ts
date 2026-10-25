import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { grantSigningString, spkiFingerprint, type GrantFields } from '@dsh-remote/protocol';
import { writePrivateFileAtomic } from './store.ts';

/**
 * The host's own P-256 identity key. Its fingerprint goes into every pairing
 * QR, and it signs device grants so a phone can tell this host's grant from
 * anything an intermediary (including Cloudflare's TLS edge) could forge.
 */
export class HostIdentity {
  readonly publicKey: string;
  readonly fingerprint: string;

  private readonly privateKey: KeyObject;

  private constructor(privateKey: KeyObject) {
    this.privateKey = privateKey;
    const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    this.publicKey = spki.toString('base64url');
    this.fingerprint = spkiFingerprint(spki);
  }

  static generate(): HostIdentity {
    return new HostIdentity(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey);
  }

  /** Load `path` (PKCS#8 PEM), creating it owner-only on first use. */
  static async loadOrCreate(path: string): Promise<HostIdentity> {
    try {
      const key = createPrivateKey(await readFile(path, 'utf8'));
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error(`dsh-remote: ${path} is not a P-256 private key`);
      }
      return new HostIdentity(key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const identity = HostIdentity.generate();
    await writePrivateFileAtomic(path, identity.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string);
    return identity;
  }

  signGrant(grant: GrantFields): string {
    return sign('sha256', Buffer.from(grantSigningString(grant), 'utf8'), { key: this.privateKey, dsaEncoding: 'der' }).toString('base64url');
  }
}
