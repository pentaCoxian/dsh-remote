import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import iroh from '@number0/iroh';

/** The gateway's 32-byte iroh secret key, created 0600 on first start. Its public key is the gateway's identity. */
export async function loadOrCreateKey(path: string): Promise<number[]> {
  try {
    const bytes = await readFile(path);
    if (bytes.length !== 32) throw new Error(`${path} is not a 32-byte key`);
    return Array.from(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const key = iroh.SecretKey.generate().toBytes();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, Buffer.from(key), { mode: 0o600, flag: 'wx' });
  return key;
}
