import { Inject, Injectable } from "@nestjs/common";
import type { CryptoService } from "@slugbase/shared-types";

import { InstanceMetadataRepository } from "../db/instance-metadata.repository.js";
import { CRYPTO } from "./crypto.tokens.js";

/** Sample instance setting key demonstrating at-rest encryption for settings values. */
export const SAMPLE_ENCRYPTED_SETTING_KEY = "settings.sample_secret";

@Injectable()
export class SampleEncryptedSettingService {
  constructor(
    @Inject(CRYPTO) private readonly crypto: CryptoService,
    private readonly instanceMetadata: InstanceMetadataRepository,
  ) {}

  async setSampleSecret(plaintext: string): Promise<void> {
    const ciphertext = this.crypto.encrypt(plaintext);
    await this.instanceMetadata.set(SAMPLE_ENCRYPTED_SETTING_KEY, ciphertext);
  }

  async getSampleSecret(): Promise<string | null> {
    const stored = await this.instanceMetadata.get(SAMPLE_ENCRYPTED_SETTING_KEY);
    if (stored === null) {
      return null;
    }

    const decrypted = this.crypto.decrypt(stored);
    return decrypted.length === 0 ? null : decrypted;
  }
}
