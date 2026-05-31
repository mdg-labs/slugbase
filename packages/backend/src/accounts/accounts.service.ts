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

  async findByEmail(email: string): Promise<AccountRecord | null> {
    return this.repo.findByEmail(email);
  }

  async findById(id: string): Promise<AccountRecord | null> {
    return this.repo.findById(id);
  }
}
