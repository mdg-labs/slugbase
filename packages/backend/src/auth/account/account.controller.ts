import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Patch,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import type {
  AccountSettingsResponse,
  UpdateAccountPasswordBody,
  UpdateAccountPreferencesBody,
  UpdateAccountProfileBody,
} from "@slugbase/shared-types";
import { ALLOWED_ACCENT_COLORS } from "@slugbase/shared-types";

import { AccountsService } from "../../accounts/accounts.service.js";
import {
  assertAccentColorValid,
  assertLanguageValid,
  assertThemeValid,
  normalizeAccentColor,
} from "../../accounts/account.validation.js";
import { PasswordService } from "../../accounts/password.service.js";
import { SessionGuard, SESSION_USER_ID_KEY } from "../../sessions/session.guard.js";
import { MfaService } from "../mfa/mfa.service.js";

@Controller("auth/account")
export class AccountController {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(MfaService) private readonly mfa: MfaService,
  ) {}

  @Get()
  @UseGuards(SessionGuard)
  async getAccount(@Req() req: Request): Promise<AccountSettingsResponse> {
    const userId = this.requireUserId(req);
    return this.buildSettingsResponse(userId);
  }

  @Patch("profile")
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async updateProfile(
    @Req() req: Request,
    @Body() body: UpdateAccountProfileBody,
  ): Promise<AccountSettingsResponse> {
    const userId = this.requireUserId(req);
    const name = body.name.trim();
    if (!name) throw new BadRequestException("Name is required");
    await this.accounts.updateProfile(userId, name);
    return this.buildSettingsResponse(userId);
  }

  @Patch("password")
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async updatePassword(
    @Req() req: Request,
    @Body() body: UpdateAccountPasswordBody,
  ): Promise<{ ok: true }> {
    const userId = this.requireUserId(req);
    const account = await this.accounts.findById(userId);
    if (!account) throw new UnauthorizedException();

    const hasPassword = this.accounts.hasPasswordCredential(account);

    if (hasPassword) {
      if (!body.currentPassword) {
        throw new BadRequestException("Current password is required");
      }
      const valid = await this.passwords.verifyPassword(
        account.passwordHash,
        body.currentPassword,
      );
      if (!valid) {
        throw new UnprocessableEntityException("Current password is incorrect");
      }
    }

    await this.accounts.updatePassword(userId, body.newPassword);
    return { ok: true };
  }

  @Patch("preferences")
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async updatePreferences(
    @Req() req: Request,
    @Body() body: UpdateAccountPreferencesBody,
  ): Promise<AccountSettingsResponse> {
    const userId = this.requireUserId(req);

    if (
      body.language === undefined &&
      body.theme === undefined &&
      body.accentColor === undefined &&
      body.aiOptOut === undefined
    ) {
      throw new BadRequestException("No preference fields provided");
    }

    if (body.language !== undefined) {
      assertLanguageValid(body.language);
    }
    if (body.theme !== undefined) {
      assertThemeValid(body.theme);
    }

    const accentColor =
      body.accentColor === undefined
        ? undefined
        : normalizeAccentColor(body.accentColor);
    if (accentColor !== undefined) {
      assertAccentColorValid(accentColor);
    }

    await this.accounts.updatePreferences(userId, {
      language: body.language,
      theme: body.theme,
      accentColor,
      aiOptOut: body.aiOptOut,
    });

    return this.buildSettingsResponse(userId);
  }

  private requireUserId(req: Request): string {
    const userId = (req as unknown as Record<string, unknown>)[SESSION_USER_ID_KEY] as
      | string
      | undefined;
    if (!userId) throw new UnauthorizedException();
    return userId;
  }

  private async buildSettingsResponse(userId: string): Promise<AccountSettingsResponse> {
    const account = await this.accounts.findById(userId);
    if (!account) throw new UnauthorizedException();

    const remainingBackupCodes =
      account.mfaState === "enrolled"
        ? await this.mfa.countUnusedBackupCodes(userId)
        : null;

    const language = account.language === "de" ? "de" : "en";
    const theme =
      account.theme === "light" || account.theme === "auto" ? account.theme : "dark";

    const normalizedAccent = account.accentColor?.toLowerCase() ?? null;
    const accentColor = ALLOWED_ACCENT_COLORS.includes(
      normalizedAccent as (typeof ALLOWED_ACCENT_COLORS)[number],
    )
      ? (normalizedAccent as AccountSettingsResponse["accentColor"])
      : null;

    return {
      id: account.id,
      email: account.email,
      name: account.name,
      emailVerified: account.emailVerified,
      mfaState: account.mfaState,
      remainingBackupCodes,
      hasPassword: this.accounts.hasPasswordCredential(account),
      language,
      theme,
      accentColor,
      aiOptOut: account.aiOptOut,
    };
  }
}
