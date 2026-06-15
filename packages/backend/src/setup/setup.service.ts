import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";

import { AccountsService } from "../accounts/accounts.service.js";
import { ConfigService } from "../config/config.service.js";
import { InstanceMetadataRepository, SETUP_COMPLETE_VALUE } from "../db/instance-metadata.repository.js";
import { SessionService } from "../sessions/session.service.js";
import { EmailVerificationService } from "../auth/verification/email-verification.service.js";
import { WorkspacesService } from "../workspaces/workspaces.service.js";

export const SETUP_COMPLETE_KEY = "setup_complete";

export interface SetupStatusResult {
  needsSetup: boolean;
}

export interface CompleteSetupDto {
  email: string;
  name: string;
  password: string;
  workspaceName: string;
  workspaceSlug: string;
}

export interface CompleteSetupResult {
  userId: string;
  cookieValue: string;
}

@Injectable()
export class SetupService {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(InstanceMetadataRepository)
    private readonly instanceMetadata: InstanceMetadataRepository,
    @Inject(EmailVerificationService)
    private readonly emailVerification: EmailVerificationService,
  ) {}

  async getStatus(): Promise<SetupStatusResult> {
    const userCount = await this.accounts.countAll();
    if (userCount > 0) {
      return { needsSetup: false };
    }
    // Hosted path: public registration creates the first account via /register (spec §5.2).
    if (this.config.get("PUBLIC_REGISTRATION")) {
      return { needsSetup: false };
    }
    return { needsSetup: true };
  }

  async completeSetup(dto: CompleteSetupDto): Promise<CompleteSetupResult> {
    if (this.config.get("PUBLIC_REGISTRATION")) {
      throw new ForbiddenException("Instance setup is not available when public registration is enabled");
    }

    const claimed = await this.instanceMetadata.tryClaimSetupCompletion(SETUP_COMPLETE_KEY);
    if (!claimed) {
      throw new ConflictException("Instance setup has already been completed");
    }

    try {
      return await this.completeSetupUnderLock(dto);
    } catch (error) {
      if (error instanceof ConflictException) {
        await this.instanceMetadata.set(SETUP_COMPLETE_KEY, SETUP_COMPLETE_VALUE);
      } else {
        await this.instanceMetadata.releaseSetupCompletionClaim(SETUP_COMPLETE_KEY);
      }
      throw error;
    }
  }

  private async completeSetupUnderLock(dto: CompleteSetupDto): Promise<CompleteSetupResult> {
    const userCount = await this.accounts.countAll();
    if (userCount > 0) {
      throw new ConflictException("Instance setup has already been completed");
    }

    const account = await this.accounts.registerAccount({
      email: dto.email,
      name: dto.name,
      password: dto.password,
      isInstanceAdmin: true,
    });

    const workspace = await this.workspaces.createWorkspace(
      {
        name: dto.workspaceName,
        slug: dto.workspaceSlug,
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

    await this.instanceMetadata.set(SETUP_COMPLETE_KEY, SETUP_COMPLETE_VALUE);

    if (emailVerificationRequired) {
      await this.emailVerification.issueToken(account.id, account.email);
    }

    return { userId: account.id, cookieValue };
  }
}
