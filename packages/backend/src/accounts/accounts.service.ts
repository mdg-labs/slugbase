import { ConflictException, Inject, Injectable } from "@nestjs/common";

import { DbService } from "../db/db.service.js";
import { AccountRepository } from "./account.repository.js";
import type { AccountRecord, CreateAccountData } from "./account.types.js";
import { PasswordService } from "./password.service.js";

export interface RegisterAccountDto {
  email: string;
  name: string;
  password: string;
  language?: string;
  theme?: string;
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
    this.repo = new AccountRepository(db.getOrm(), db.dialect);
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

  async markEmailVerified(id: string): Promise<void> {
    return this.repo.updateEmailVerified(id, true);
  }
}
