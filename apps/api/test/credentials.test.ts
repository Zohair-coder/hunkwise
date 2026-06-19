import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { EncryptedSecret, InstanceSecretStore } from '@hunkwise/db';
import { DecryptingInstanceCredentialProvider } from '../src/credentials.js';
import { AesGcmSecretCipher } from '../src/crypto.js';

describe('DecryptingInstanceCredentialProvider', () => {
  it('decrypts only through the narrow secret-store capability', async () => {
    const cipher = new AesGcmSecretCipher(randomBytes(32).toString('base64'));
    const encrypted = cipher.encrypt('glpat-future-gateway');
    const getEncryptedInstanceAccessToken = vi.fn().mockResolvedValue(encrypted);
    const secrets: InstanceSecretStore = { getEncryptedInstanceAccessToken };
    const provider = new DecryptingInstanceCredentialProvider(secrets, cipher);
    expect(await provider.getAccessToken('instance-id')).toBe('glpat-future-gateway');
    expect(getEncryptedInstanceAccessToken).toHaveBeenCalledWith('instance-id');
  });

  it('returns null without invoking decryption when no credential exists', async () => {
    const cipher = new AesGcmSecretCipher(randomBytes(32).toString('base64'));
    const decrypt = vi.spyOn(cipher, 'decrypt');
    const secrets: InstanceSecretStore = { getEncryptedInstanceAccessToken: async () => null as EncryptedSecret | null };
    expect(await new DecryptingInstanceCredentialProvider(secrets, cipher).getAccessToken('missing')).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
  });
});
