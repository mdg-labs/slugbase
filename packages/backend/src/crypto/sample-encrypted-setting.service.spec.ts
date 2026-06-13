import { describe, expect, it, vi } from "vitest";
import type { CryptoService } from "@slugbase/shared-types";

import type { InstanceMetadataRepository } from "../db/instance-metadata.repository.js";
import {
  SAMPLE_ENCRYPTED_SETTING_KEY,
  SampleEncryptedSettingService,
} from "./sample-encrypted-setting.service.js";

describe("SampleEncryptedSettingService", () => {
  it("stores encrypted ciphertext and returns decrypted sample secret", async () => {
    const store = new Map<string, string>();
    const setMock = vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    });
    const getMock = vi.fn((key: string) =>
      Promise.resolve(store.get(key) ?? null),
    );
    const crypto: CryptoService = {
      encrypt: (plaintext) => `enc:${plaintext}`,
      decrypt: (ciphertext) => ciphertext.replace(/^enc:/, ""),
    };
    const instanceMetadata = {
      get: getMock,
      set: setMock,
    } as unknown as InstanceMetadataRepository;

    const service = new SampleEncryptedSettingService(crypto, instanceMetadata);

    await service.setSampleSecret("sample-smtp-password");
    const value = await service.getSampleSecret();

    expect(setMock).toHaveBeenCalledWith(
      SAMPLE_ENCRYPTED_SETTING_KEY,
      "enc:sample-smtp-password",
    );
    expect(value).toBe("sample-smtp-password");
  });
});
