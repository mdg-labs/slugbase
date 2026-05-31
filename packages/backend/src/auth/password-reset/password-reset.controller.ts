import { Body, Controller, HttpCode, Inject, Post } from "@nestjs/common";

import { SkipCsrf } from "../csrf/skip-csrf.decorator.js";
import { PasswordResetService } from "./password-reset.service.js";

interface ForgotPasswordBody {
  email: string;
}

interface ResetPasswordBody {
  token: string;
  newPassword: string;
}

@Controller("auth")
@SkipCsrf()
export class PasswordResetController {
  constructor(
    @Inject(PasswordResetService)
    private readonly passwordResetService: PasswordResetService,
  ) {}

  /**
   * Initiates the password reset flow.
   *
   * NON-ENUMERATING (spec §5.4, §5.8): always returns 200 regardless of
   * whether the email address is registered with an account.
   */
  @Post("forgot-password")
  @HttpCode(200)
  async forgotPassword(
    @Body() body: ForgotPasswordBody,
  ): Promise<{ ok: true }> {
    await this.passwordResetService.forgotPassword(body.email);
    return { ok: true };
  }

  /**
   * Completes the password reset: validates the token, sets the new password,
   * and revokes all existing sessions for the user.
   *
   * Returns 422 for an invalid, expired, or already-used token.
   */
  @Post("reset-password")
  @HttpCode(200)
  async resetPassword(
    @Body() body: ResetPasswordBody,
  ): Promise<{ ok: true }> {
    await this.passwordResetService.resetPassword(body.token, body.newPassword);
    return { ok: true };
  }
}
