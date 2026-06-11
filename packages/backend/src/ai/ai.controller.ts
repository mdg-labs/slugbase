import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import type {
  AiPageMetadata,
  AiService,
  AiSuggestions,
} from "@slugbase/shared-types";

import { AccountsService } from "../accounts/accounts.service.js";
import { EntitlementsService } from "../entitlements/entitlements.service.js";
import { ActiveWorkspace } from "../workspaces/active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { AiSuggestionCacheService } from "./cache/ai-suggestion-cache.service.js";
import type { AiSuggestionCacheContext } from "./cache/ai-suggestion-cache.types.js";
import { AI } from "./ai.tokens.js";

interface AiSuggestBody {
  url: string;
  outputLanguage: string;
  metadata?: AiPageMetadata;
}

/**
 * Exposes POST /ai/suggest - returns AI-generated bookmark field suggestions.
 *
 * Gate order (spec §11.2, §12.4, §17):
 *   1. Entitlement check - workspace plan must include `ai-suggestions`.
 *   2. Per-user opt-out   - `account.aiOptOut` must be false.
 *   3. Provider check     - AI credential must be configured.
 */
@Controller("ai")
@UseGuards(TenantGuard)
export class AiController {
  constructor(
    @Inject(AI) private readonly ai: AiService,
    @Inject(AiSuggestionCacheService)
    private readonly cache: AiSuggestionCacheService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(EntitlementsService)
    private readonly entitlements: EntitlementsService,
  ) {}

  @Post("suggest")
  @HttpCode(200)
  async suggest(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: AiSuggestBody,
  ): Promise<AiSuggestions> {
    this.entitlements.assertCan(workspace, "ai-suggestions");

    const userId = req[TENANT_USER_ID_KEY] as string;
    const account = await this.accounts.findById(userId);
    if (!account) {
      throw new UnauthorizedException();
    }

    if (account.aiOptOut) {
      throw new ForbiddenException(
        "AI suggestions are disabled for your account",
      );
    }

    if (!this.ai.isAvailable()) {
      throw new ServiceUnavailableException(
        "AI provider is not configured for this instance",
      );
    }

    const context: AiSuggestionCacheContext = {
      workspaceId: workspace.id,
      userId,
    };

    return this.cache.suggestWithCache(context, body, this.ai);
  }
}
