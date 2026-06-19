import type { InstanceSecretStore, SecretCipher } from '@hunkwise/db';

export type GitLabAccessToken = string & { readonly __gitLabAccessToken: unique symbol };

/** The only application capability that decrypts a stored GitLab token. */
export interface InstanceCredentialProvider {
  getAccessToken(instanceId: string): Promise<GitLabAccessToken | null>;
}

export class DecryptingInstanceCredentialProvider implements InstanceCredentialProvider {
  constructor(private readonly secrets: InstanceSecretStore, private readonly cipher: SecretCipher) {}

  async getAccessToken(instanceId: string): Promise<GitLabAccessToken | null> {
    const encrypted = await this.secrets.getEncryptedInstanceAccessToken(instanceId);
    return encrypted === null ? null : this.cipher.decrypt(encrypted) as GitLabAccessToken;
  }
}
