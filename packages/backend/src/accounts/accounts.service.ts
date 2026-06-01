import { ConflictException, Inject, Injectable } from "@nestjs/common";

import { DbService } from "../db/db.service.js";
import { AccountRepository } from "./account.repository.js";
import type { AccountRecord, CreateAccountData } from "./account.types.js";
import { OIDC_SENTINEL_PASSWORD_HASH } from "./account.types.js";
import { PasswordService } from "./password.service.js";

export interface RegisterAccountDto {
  email: string;
  name: string;
  password: string;
  language?: string;
  theme?: string;
  isInstanceAdmin?: boolean;
}

export interface CreateOidcAccountDto {
  email: string;
  name: string;
  emailVerified: boolean;
  language?: string;
  theme?: string;
}

@Injectable()
export class AccountsService {
  private readonly repo: AccountRepository;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(PasswordService) private readonly passwordService: PasswordService,
  ) {
    this.repo = new AccountRepository(db.getOrm());
  }

  async registerAccount(dto: RegisterAccountDto): Promise<AccountRecord> {
    const existing = await this.repo.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException("An account with this email already exists");
    }

    const passwordHash = await this.passwordService.hashPassword(dto.password);
    const data: CreateAccountData = {
      email: dto.email,
      name: dto.name,
      passwordHash,
      language: dto.language,
      theme: dto.theme,
      isInstanceAdmin: dto.isInstanceAdmin,
    };
    return this.repo.create(data);
  }

  /**
   * Creates a user account for an OIDC-federated user.
   * Uses a placeholder password hash since OIDC users authenticate via IdP only.
   */
  async createOidcAccount(dto: CreateOidcAccountDto): Promise<AccountRecord> {
    const existing = await this.repo.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException("An account with this email already exists");
    }
    return this.repo.createOidc({
      email: dto.email,
      name: dto.name,
      emailVerified: dto.emailVerified,
      language: dto.language,
      theme: dto.theme,
    });
  }

  async findByEmail(email: string): Promise<AccountRecord | null> {
    return this.repo.findByEmail(email);
  }

  async findById(id: string): Promise<AccountRecord | null> {
    return this.repo.findById(id);
  }

  async countAll(): Promise<number> {
    return this.repo.countAll();
  }

  async markEmailVerified(id: string): Promise<void> {
    return this.repo.updateEmailVerified(id, true);
  }

  async updatePassword(id: string, newPassword: string): Promise<void> {
    const passwordHash = await this.passwordService.hashPassword(newPassword);
    return this.repo.updatePasswordHash(id, passwordHash);
  }

  async updateProfile(id: string, name: string): Promise<AccountRecord> {
    await this.repo.updateProfile(id, { name });
    const account = await this.repo.findById(id);
    if (!account) throw new Error("Account not found after profile update");
    return account;
  }

  async updatePreferences(
    id: string,
    patch: {
      language?: string;
      theme?: string;
      accentColor?: string | null;
      aiOptOut?: boolean;
    },
  ): Promise<AccountRecord> {
    await this.repo.updatePreferences(id, patch);
    const account = await this.repo.findById(id);
    if (!account) throw new Error("Account not found after preferences update");
    return account;
  }

  hasPasswordCredential(account: AccountRecord): boolean {
    return account.passwordHash !== OIDC_SENTINEL_PASSWORD_HASH;
  }
}
