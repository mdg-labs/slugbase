import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";

import {
  ALLOWED_ACCENT_COLORS,
  UpdateAccountPreferencesBodySchema,
} from "@slugbase/shared-types";
import type {
  AccountSettingsResponse,
  UpdateAccountEmailBody,
  UpdateAccountPasswordBody,
  UpdateAccountProfileBody,
} from "@slugbase/shared-types";

import { AccountsService } from "../../accounts/accounts.service.js";
import {
  assertAccentColorValid,
  assertDefaultBookmarkViewValid,
  assertLanguageValid,
  assertThemeValid,
  normalizeAccentColor,
} from "../../accounts/account.validation.js";
import { PasswordService } from "../../accounts/password.service.js";
import { SessionGuard, SESSION_USER_ID_KEY } from "../../sessions/session.guard.js";
import { MfaService } from "../mfa/mfa.service.js";
import { EmailChangeService } from "./email-change.service.js";

const updateAccountEmailBodySchema = z
  .object({
    email: z.string().trim().email(),
  })
  .strict();

@Controller("auth/account")
export class AccountController {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(MfaService) private readonly mfa: MfaService,
    @Inject(EmailChangeService) private readonly emailChange: EmailChangeService,
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

  @Patch("email")
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async requestEmailChange(
    @Req() req: Request,
    @Body() body: UpdateAccountEmailBody,
  ): Promise<AccountSettingsResponse> {
    const userId = this.requireUserId(req);
    const parsed = updateAccountEmailBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("Unable to update email address");
    }

    await this.emailChange.requestChange(userId, parsed.data.email);
    return this.buildSettingsResponse(userId);
  }

  @Post("email/resend")
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async resendEmailChange(@Req() req: Request): Promise<{ ok: true }> {
    const userId = this.requireUserId(req);
    await this.emailChange.resendPending(userId);
    return { ok: true };
  }

  @Delete("email/pending")
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async cancelEmailChange(@Req() req: Request): Promise<AccountSettingsResponse> {
    const userId = this.requireUserId(req);
    await this.emailChange.cancelPending(userId);
    return this.buildSettingsResponse(userId);
  }

  @Patch("preferences")
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async updatePreferences(
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<AccountSettingsResponse> {
    const userId = this.requireUserId(req);
    const parsed = UpdateAccountPreferencesBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("Invalid preference fields");
    }
    const preferences = parsed.data;

    if (
      preferences.language === undefined &&
      preferences.theme === undefined &&
      preferences.accentColor === undefined &&
      preferences.aiOptOut === undefined &&
      preferences.defaultBookmarkView === undefined &&
      preferences.onboardingCompleted === undefined &&
      preferences.dashboardChecklistDismissed === undefined &&
      preferences.dashboardChecklistManual === undefined
    ) {
      throw new BadRequestException("No preference fields provided");
    }

    if (preferences.language !== undefined) {
      assertLanguageValid(preferences.language);
    }
    if (preferences.theme !== undefined) {
      assertThemeValid(preferences.theme);
    }

    const accentColor =
      preferences.accentColor === undefined
        ? undefined
        : normalizeAccentColor(preferences.accentColor);
    if (accentColor !== undefined) {
      assertAccentColorValid(accentColor);
    }

    const defaultBookmarkView = preferences.defaultBookmarkView;
    if (defaultBookmarkView !== undefined) {
      assertDefaultBookmarkViewValid(defaultBookmarkView);
    }

    await this.accounts.updatePreferences(userId, {
      language: preferences.language,
      theme: preferences.theme,
      accentColor,
      aiOptOut: preferences.aiOptOut,
      defaultBookmarkView,
      onboardingCompletedAt:
        preferences.onboardingCompleted === true ? Date.now() : undefined,
      dashboardChecklistDismissed: preferences.dashboardChecklistDismissed,
      dashboardChecklistManual: preferences.dashboardChecklistManual,
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
      pendingEmail: account.pendingEmail,
      pendingEmailMasked: this.emailChange.maskPendingEmail(account.pendingEmail),
      mfaState: account.mfaState,
      remainingBackupCodes,
      hasPassword: this.accounts.hasPasswordCredential(account),
      language,
      theme,
      accentColor,
      aiOptOut: account.aiOptOut,
      defaultBookmarkView: account.defaultBookmarkView,
      onboardingCompletedAt: account.onboardingCompletedAt,
      dashboardChecklistDismissed: account.dashboardChecklistDismissed,
      dashboardChecklistManual: account.dashboardChecklistManual,
    };
  }
}
