import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AesGcmSecretCipher } from '../src/crypto.js';

describe('AesGcmSecretCipher', () => {
  it('round trips without storing plaintext', () => {
    const cipher = new AesGcmSecretCipher(randomBytes(32).toString('base64'));
    const encrypted = cipher.encrypt('glpat-super-secret');
    expect(encrypted).not.toContain('glpat-super-secret');
    expect(cipher.decrypt(encrypted)).toBe('glpat-super-secret');
  });

  it('rejects invalid keys', () => {
    expect(() => new AesGcmSecretCipher('short')).toThrow(/32 bytes/);
  });
});

