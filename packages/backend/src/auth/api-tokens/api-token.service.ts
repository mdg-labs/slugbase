import { randomBytes } from "node:crypto";

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import * as argon2 from "argon2";

import { DbService } from "../../db/db.service.js";
import { ApiTokenRepository } from "./api-token.repository.js";
import type { ApiTokenRecord, ApiTokenSummary } from "./api-token.types.js";

/** `slb_` prefix + 32 random bytes as hex (64 chars). */
const TOKEN_PREFIX = "slb_";
const TOKEN_RANDOM_BYTES = 32;
/** Number of hex chars used as a DB lookup index. */
const LOOKUP_PREFIX_LENGTH = 8;
/** Maximum number of API tokens allowed per user (def §3). */
const MAX_API_TOKENS_PER_USER = 10;

export interface CreateApiTokenResult {
  record: ApiTokenSummary;
  /** Plaintext token - returned exactly once; not stored. */
  plaintext: string;
}

@Injectable()
export class ApiTokenService {
  private readonly repo: ApiTokenRepository;

  constructor(@Inject(DbService) private readonly db: DbService) {
    this.repo = new ApiTokenRepository(db.getOrm());
  }

  /** Generates a new named API token. Returns the plaintext once. */
  async createToken(
    userId: string,
    name: string,
  ): Promise<CreateApiTokenResult> {
    const count = await this.repo.countByUserId(userId);
    if (count >= MAX_API_TOKENS_PER_USER) {
      throw new UnprocessableEntityException(
        "Maximum of 10 API tokens per user reached",
      );
    }

    const plaintext = generateToken();
    const tokenPrefix = extractPrefix(plaintext);
    const tokenHash = await argon2.hash(plaintext, { type: argon2.argon2id });

    let record: ApiTokenRecord;
    try {
      record = await this.repo.create({
        userId,
        name,
        tokenHash,
        tokenPrefix,
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new ConflictException(`An API token named "${name}" already exists`);
      }
      throw err;
    }

    return { record: toSummary(record), plaintext };
  }

  /** Lists all tokens for a user (never exposes hashes). */
  async listTokens(userId: string): Promise<ApiTokenSummary[]> {
    const records = await this.repo.findAllByUserId(userId);
    return records.map(toSummary);
  }

  /** Deletes a token by ID. Throws if the token doesn't belong to the user. */
  async deleteToken(userId: string, tokenId: string): Promise<void> {
    const token = await this.repo.findByIdAndUserId(tokenId, userId);
    if (!token) {
      throw new NotFoundException("API token not found");
    }
    await this.repo.deleteByIdAndUserId(tokenId, userId);
  }

  /**
   * Verifies a raw token string. Returns the matched record (with userId)
   * or null if invalid/expired. Updates last_used_at on success.
   */
  async verifyToken(rawToken: string): Promise<ApiTokenRecord | null> {
    if (!rawToken.startsWith(TOKEN_PREFIX)) return null;

    const prefix = extractPrefix(rawToken);
    const candidates = await this.repo.findByPrefix(prefix);

    for (const candidate of candidates) {
      if (candidate.expiresAt && candidate.expiresAt <= new Date()) {
        continue;
      }

      const valid = await argon2.verify(candidate.tokenHash, rawToken);
      if (valid) {
        await this.repo.touchLastUsed(candidate.id, Date.now());
        return candidate;
      }
    }

    return null;
  }
}

function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString("hex")}`;
}

function extractPrefix(token: string): string {
  return token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + LOOKUP_PREFIX_LENGTH);
}

function toSummary(record: ApiTokenRecord): ApiTokenSummary {
  return {
    id: record.id,
    name: record.name,
    lastUsedAt: record.lastUsedAt,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  let current: unknown = err;
  while (current != null) {
    if (typeof current === "object") {
      const code = (current as { code?: string }).code;
      if (code === "23505") {
        return true;
      }
    }
    if (current instanceof Error) {
      const msg = current.message.toLowerCase();
      if (
        msg.includes("unique constraint") ||
        msg.includes("unique violation") ||
        msg.includes("duplicate key")
      ) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}
