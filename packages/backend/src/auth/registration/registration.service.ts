import {
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";

import { AccountsService } from "../../accounts/accounts.service.js";
import { ConfigService } from "../../config/config.service.js";
import { SessionService } from "../../sessions/session.service.js";
import { EmailVerificationService } from "../verification/email-verification.service.js";
import { WorkspacesService } from "../../workspaces/workspaces.service.js";

export interface RegisterDto {
  email: string;
  name: string;
  password: string;
  workspaceName?: string;
  workspaceSlug?: string;
}

export interface RegisterResult {
  userId: string;
  cookieValue: string;
}

@Injectable()
export class RegistrationService {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(EmailVerificationService)
    private readonly emailVerification: EmailVerificationService,
  ) {}

  async register(dto: RegisterDto): Promise<RegisterResult> {
    const publicRegistration = this.config.get("PUBLIC_REGISTRATION");
    if (!publicRegistration) {
      throw new ForbiddenException(
        "Public registration is not enabled on this instance",
      );
    }

    const account = await this.accounts.registerAccount({
      email: dto.email,
      name: dto.name,
      password: dto.password,
    });

    const workspaceName = dto.workspaceName ?? `${account.name}'s workspace`;
    const workspaceSlug =
      dto.workspaceSlug ??
      account.email.split("@")[0]?.toLowerCase().replace(/[^a-z0-9-]/g, "-") ??
      account.id;

    const workspace = await this.workspaces.createWorkspace(
      {
        name: workspaceName,
        slug: workspaceSlug,
        plan: "free",
      },
      account.id,
    );

    const emailVerificationRequired = this.config.get("EMAIL_VERIFICATION_REQUIRED");
    const sessionData: Record<string, unknown> = {
      activeWorkspaceId: workspace.id,
    };
    if (emailVerificationRequired) {
      sessionData["emailVerificationPending"] = true;
    }

    const { cookieValue } = await this.sessions.createSession({
      userId: account.id,
      data: sessionData,
    });

    if (emailVerificationRequired) {
      await this.emailVerification.issueToken(account.id, account.email);
    }

    return { userId: account.id, cookieValue };
  }
}
