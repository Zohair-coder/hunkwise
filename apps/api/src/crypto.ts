import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptedSecret, SecretCipher } from '@hunkwise/db';

export class AesGcmSecretCipher implements SecretCipher {
  readonly #key: Buffer;

  constructor(base64Key: string) {
    this.#key = Buffer.from(base64Key, 'base64');
    if (this.#key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must decode to exactly 32 bytes');
  }

  encrypt(plaintext: string): EncryptedSecret {
    if (!plaintext) throw new Error('Cannot encrypt an empty secret');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}` as EncryptedSecret;
  }

  decrypt(ciphertext: EncryptedSecret): string {
    const [version, encodedIv, encodedTag, encodedData] = ciphertext.split(':');
    if (version !== 'v1' || !encodedIv || !encodedTag || !encodedData) throw new Error('Unsupported encrypted secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(encodedIv, 'base64'));
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encodedData, 'base64')), decipher.final()]).toString('utf8');
  }
}

