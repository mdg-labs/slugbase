import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import {
  CryptoDecryptError,
  CryptoEncryptError,
  type CryptoService,
} from "@slugbase/shared-types";

import { ConfigService } from "../config/config.service.js";

const CIPHERTEXT_VERSION = "sb1";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

@Injectable()
export class AesGcmCryptoService implements CryptoService {
  private readonly key: Buffer;
  private readonly strictMode: boolean;

  constructor(@Inject(ConfigService) config: ConfigService) {
    const encryptionKey = config.get("ENCRYPTION_KEY");
    this.key = createHash("sha256").update(encryptionKey, "utf8").digest();
    this.strictMode = config.get("isProduction");
  }

  encrypt(plaintext: string): string {
    try {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, this.key, iv);
      const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();
      const payload = Buffer.concat([iv, authTag, encrypted]);
      return `${CIPHERTEXT_VERSION}:${payload.toString("base64url")}`;
    } catch {
      throw new CryptoEncryptError("Failed to encrypt value");
    }
  }

  decrypt(ciphertext: string): string {
    try {
      const plaintext = this.decryptOrThrow(ciphertext);
      return plaintext;
    } catch (error) {
      if (this.strictMode) {
        if (error instanceof CryptoDecryptError) {
          throw error;
        }
        throw new CryptoDecryptError("Failed to decrypt value");
      }

      return "";
    }
  }

  private decryptOrThrow(ciphertext: string): string {
    const separatorIndex = ciphertext.indexOf(":");
    if (separatorIndex === -1) {
      throw new CryptoDecryptError("Invalid ciphertext format");
    }

    const version = ciphertext.slice(0, separatorIndex);
    if (version !== CIPHERTEXT_VERSION) {
      throw new CryptoDecryptError("Unsupported ciphertext version");
    }

    const encoded = ciphertext.slice(separatorIndex + 1);
    const payload = Buffer.from(encoded, "base64url");
    const minimumLength = IV_LENGTH + AUTH_TAG_LENGTH;
    if (payload.length < minimumLength) {
      throw new CryptoDecryptError("Ciphertext payload is too short");
    }

    const iv = payload.subarray(0, IV_LENGTH);
    const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString("utf8");
  }
}
