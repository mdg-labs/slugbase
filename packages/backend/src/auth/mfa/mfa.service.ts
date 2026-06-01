import { randomBytes } from "node:crypto";

import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import * as argon2 from "argon2";
import { generateSecret, generateURI, verifySync } from "otplib";
import { toDataURL } from "qrcode";

import type { CryptoService } from "@slugbase/shared-types";

import { AccountRepository } from "../../accounts/account.repository.js";
import { ConfigService } from "../../config/config.service.js";
import { CRYPTO } from "../../crypto/crypto.tokens.js";
import { DbService } from "../../db/db.service.js";
import { MfaBackupCodeRepository } from "./mfa-backup-code.repository.js";
import type {
  MfaEnrolConfirmResult,
  MfaEnrolStartResult,
} from "./mfa.types.js";

const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_BYTES = 10;

@Injectable()
export class MfaService {
  private readonly accountRepo: AccountRepository;
  private readonly backupCodeRepo: MfaBackupCodeRepository;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(CRYPTO) private readonly crypto: CryptoService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {
    this.accountRepo = new AccountRepository(db.getOrm(), db.dialect);
    this.backupCodeRepo = new MfaBackupCodeRepository(db.getOrm(), db.dialect);
  }

  private get issuer(): string {
    return this.config.get("MFA_TOTP_ISSUER");
  }

  /**
   * Begins enrollment: generates a TOTP secret, encrypts it, stores on the account
   * with mfa_state=pending. Returns the QR code data URI and text secret.
   */
  async enrolStart(userId: string, userEmail: string): Promise<MfaEnrolStartResult> {
    const secret = generateSecret();
    const otpAuthUri = generateURI({ issuer: this.issuer, label: userEmail, secret });
    const qrDataUri = await toDataURL(otpAuthUri);

    const secretEncrypted = this.crypto.encrypt(secret);
    await this.accountRepo.updateMfa(userId, {
      mfaState: "pending",
      mfaTotpSecretEncrypted: secretEncrypted,
    });

    return { otpAuthUri, textSecret: secret, qrDataUri };
  }

  /**
   * Confirms enrollment by verifying the first TOTP code. On success, transitions
   * mfa_state to "enrolled" and generates 10 single-use backup codes (shown once).
   */
  async enrolConfirm(
    userId: string,
    totpCode: string,
  ): Promise<MfaEnrolConfirmResult> {
    const account = await this.accountRepo.findById(userId);
    if (!account || account.mfaState !== "pending" || !account.mfaTotpSecretEncrypted) {
      throw new UnauthorizedException("MFA enrollment not started");
    }

    const secret = this.crypto.decrypt(account.mfaTotpSecretEncrypted);
    let valid = false;
    try {
      valid = verifySync({ token: totpCode, secret }).valid;
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new UnauthorizedException("Invalid TOTP code");
    }

    await this.accountRepo.updateMfa(userId, { mfaState: "enrolled" });

    const plainCodes = await this.generateAndStoreBackupCodes(userId);
    return { backupCodes: plainCodes };
  }

  /**
   * Verifies a TOTP code for an enrolled user. Returns true on success.
   */
  async verifyTotp(userId: string, totpCode: string): Promise<boolean> {
    const account = await this.accountRepo.findById(userId);
    if (!account || account.mfaState !== "enrolled" || !account.mfaTotpSecretEncrypted) {
      return false;
    }
    try {
      const secret = this.crypto.decrypt(account.mfaTotpSecretEncrypted);
      return verifySync({ token: totpCode, secret }).valid;
    } catch {
      return false;
    }
  }

  /**
   * Verifies a backup code for an enrolled user. Marks the code as used on success.
   * Returns true on success.
   */
  async verifyBackupCode(userId: string, code: string): Promise<boolean> {
    const unusedCodes = await this.backupCodeRepo.findUnusedByUserId(userId);
    for (const record of unusedCodes) {
      const match = await argon2.verify(record.codeHash, code);
      if (match) {
        await this.backupCodeRepo.markUsed(record.id, Date.now());
        return true;
      }
    }
    return false;
  }

  /**
   * Verifies a TOTP or backup code. Tries TOTP first, then backup codes.
   */
  async verifyChallengeCode(userId: string, code: string): Promise<boolean> {
    const totpValid = await this.verifyTotp(userId, code);
    if (totpValid) return true;
    return this.verifyBackupCode(userId, code);
  }

  /**
   * Disables MFA after verifying the current TOTP code.
   */
  async disable(userId: string, totpCode: string): Promise<void> {
    const valid = await this.verifyTotp(userId, totpCode);
    if (!valid) {
      throw new UnauthorizedException("Invalid TOTP code");
    }

    await this.backupCodeRepo.deleteAllByUserId(userId);
    await this.accountRepo.updateMfa(userId, {
      mfaState: "not_enrolled",
      mfaTotpSecretEncrypted: null,
    });
  }

  /**
   * Regenerates backup codes after verifying the current TOTP code.
   * Returns the new plain-text codes (shown once).
   */
  async regenerateBackupCodes(
    userId: string,
    totpCode: string,
  ): Promise<string[]> {
    const valid = await this.verifyTotp(userId, totpCode);
    if (!valid) {
      throw new UnauthorizedException("Invalid TOTP code");
    }

    await this.backupCodeRepo.deleteAllByUserId(userId);
    return this.generateAndStoreBackupCodes(userId);
  }

  async countUnusedBackupCodes(userId: string): Promise<number> {
    const codes = await this.backupCodeRepo.findUnusedByUserId(userId);
    return codes.length;
  }

  private async generateAndStoreBackupCodes(userId: string): Promise<string[]> {
    const plainCodes: string[] = [];
    const hashes: string[] = [];

    for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
      const code = randomBytes(BACKUP_CODE_BYTES).toString("hex");
      plainCodes.push(code);
      hashes.push(await argon2.hash(code, { type: argon2.argon2id }));
    }

    await this.backupCodeRepo.createMany(userId, hashes);
    return plainCodes;
  }
}
