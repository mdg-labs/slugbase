import { createHash, randomBytes } from "node:crypto";

import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { MailService } from "@slugbase/shared-types";

import { AccountsService } from "../accounts/accounts.service.js";
import { ConfigService } from "../config/config.service.js";
import { DbService } from "../db/db.service.js";
import { EntitlementsService } from "../entitlements/entitlements.service.js";
import { MAIL } from "../mail/mail.tokens.js";
import { SessionService } from "../sessions/session.service.js";
import { WorkspaceMemberRepository } from "../workspaces/workspace-member.repository.js";
import { WorkspaceRepository } from "../workspaces/workspace.repository.js";
import { InvitationRepository } from "./invitation.repository.js";
import type { InvitationRole, WorkspaceInvitationRecord } from "./invitation.types.js";
import { assertMemberInvitationsEntitlement } from "./invitations.entitlements.js";

/** Invitation token TTL: 7 days (spec §4.2, def §5). */
export const INVITATION_TTL_DAYS = 7;
const INVITATION_TTL_MS = INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

export function generateInvitationToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export function hashInvitationToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export interface CreateInvitationDto {
  email: string;
  role: InvitationRole;
}

export interface InvitationMetadata {
  workspaceId: string;
  workspaceName: string;
  inviterName: string;
  invitedEmail: string;
  role: InvitationRole;
  expiresAt: Date;
}

export interface AcceptInvitationDto {
  name?: string;
  password?: string;
}

export interface AcceptInvitationResult {
  userId: string;
  workspaceId: string;
  cookieValue: string;
}

export interface PendingInvitationView {
  id: string;
  workspaceId: string;
  invitedEmail: string;
  role: InvitationRole;
  invitedByUserId: string;
  invitedByName: string;
  expiresAt: Date;
  createdAt: Date;
}

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);
  private readonly invitationRepo: InvitationRepository;
  private readonly workspaceRepo: WorkspaceRepository;
  private readonly memberRepo: WorkspaceMemberRepository;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(MAIL) private readonly mail: MailService,
  ) {
    this.invitationRepo = new InvitationRepository(db.getOrm(), db.dialect);
    this.workspaceRepo = new WorkspaceRepository(db.getOrm(), db.dialect);
    this.memberRepo = new WorkspaceMemberRepository(db.getOrm(), db.dialect);
  }

  /**
   * Creates a workspace invitation and dispatches the invitation email.
   *
   * Checks the 'workspace-members' entitlement — free plan workspaces may not
   * invite members (spec §12.2, §4.2). Enforces one pending invitation per
   * (workspace, email) pair to prevent duplicate sends.
   */
  async createInvitation(
    workspaceId: string,
    inviterUserId: string,
    dto: CreateInvitationDto,
  ): Promise<WorkspaceInvitationRecord> {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new NotFoundException("Workspace not found");

    assertMemberInvitationsEntitlement(this.entitlements, workspace);

    const existing = await this.invitationRepo.findPendingByWorkspaceAndEmail(
      workspaceId,
      dto.email,
    );
    if (existing) {
      throw new ConflictException(
        "A pending invitation already exists for this email address",
      );
    }

    const plaintext = generateInvitationToken();
    const tokenHash = hashInvitationToken(plaintext);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    const invitation = await this.invitationRepo.create({
      workspaceId,
      invitedEmail: dto.email,
      role: dto.role,
      tokenHash,
      invitedByUserId: inviterUserId,
      expiresAt,
    });

    const inviter = await this.accounts.findById(inviterUserId);
    const baseUrl = this.config.get("APP_BASE_URL");
    const inviteUrl = `${baseUrl}/invitations/${plaintext}`;

    if (this.mail.isAvailable()) {
      try {
        await this.mail.send({
          to: dto.email,
          subject: `You've been invited to ${workspace.name} on SlugBase`,
          text: [
            `${inviter?.name ?? "Someone"} has invited you to join "${workspace.name}" on SlugBase as ${dto.role}.`,
            "",
            "Accept your invitation:",
            inviteUrl,
            "",
            `This invitation expires in ${String(INVITATION_TTL_DAYS)} days.`,
            "",
            "If you did not expect this invitation, you can safely ignore this email.",
          ].join("\n"),
          type: "workspace_invitation",
        });
      } catch (err) {
        this.logger.error(
          "Failed to send invitation email — invitation was created",
          { workspaceId, invitedEmail: dto.email, err },
        );
      }
    } else {
      this.logger.warn(
        "Mail transport unavailable — invitation created but email not sent",
        { workspaceId, invitedEmail: dto.email },
      );
    }

    return invitation;
  }

  async listPendingInvitations(
    workspaceId: string,
    requesterId: string,
  ): Promise<PendingInvitationView[]> {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new NotFoundException("Workspace not found");

    assertMemberInvitationsEntitlement(this.entitlements, workspace);
    await this.requireAdmin(workspaceId, requesterId);

    const pending = await this.invitationRepo.findPendingByWorkspace(workspaceId);
    const views: PendingInvitationView[] = [];

    for (const invitation of pending) {
      const inviter = await this.accounts.findById(invitation.invitedByUserId);
      views.push({
        id: invitation.id,
        workspaceId: invitation.workspaceId,
        invitedEmail: invitation.invitedEmail,
        role: invitation.role,
        invitedByUserId: invitation.invitedByUserId,
        invitedByName: inviter?.name ?? "Unknown",
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
      });
    }

    return views;
  }

  async resendInvitation(
    workspaceId: string,
    invitationId: string,
    requesterId: string,
  ): Promise<PendingInvitationView> {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new NotFoundException("Workspace not found");

    assertMemberInvitationsEntitlement(this.entitlements, workspace);
    await this.requireAdmin(workspaceId, requesterId);

    const invitation = await this.invitationRepo.findById(invitationId);
    if (!invitation || invitation.workspaceId !== workspaceId) {
      throw new NotFoundException("Invitation not found");
    }
    if (invitation.acceptedAt !== null) {
      throw new ConflictException("This invitation has already been accepted");
    }

    const plaintext = generateInvitationToken();
    const tokenHash = hashInvitationToken(plaintext);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    const updated = await this.invitationRepo.updateTokenAndExpiry(
      invitationId,
      tokenHash,
      expiresAt,
    );
    if (!updated) {
      throw new NotFoundException("Invitation not found after update");
    }

    await this.sendInvitationEmail(updated, plaintext, requesterId);

    const inviter = await this.accounts.findById(updated.invitedByUserId);
    return {
      id: updated.id,
      workspaceId: updated.workspaceId,
      invitedEmail: updated.invitedEmail,
      role: updated.role,
      invitedByUserId: updated.invitedByUserId,
      invitedByName: inviter?.name ?? "Unknown",
      expiresAt: updated.expiresAt,
      createdAt: updated.createdAt,
    };
  }

  async revokeInvitation(
    workspaceId: string,
    invitationId: string,
    requesterId: string,
  ): Promise<void> {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new NotFoundException("Workspace not found");

    assertMemberInvitationsEntitlement(this.entitlements, workspace);
    await this.requireAdmin(workspaceId, requesterId);

    const invitation = await this.invitationRepo.findById(invitationId);
    if (!invitation || invitation.workspaceId !== workspaceId) {
      throw new NotFoundException("Invitation not found");
    }
    if (invitation.acceptedAt !== null) {
      throw new ConflictException("This invitation has already been accepted");
    }

    const deleted = await this.invitationRepo.deleteById(invitationId);
    if (!deleted) {
      throw new NotFoundException("Invitation not found");
    }
  }

  private async requireAdmin(
    workspaceId: string,
    requesterId: string,
  ): Promise<void> {
    const requester = await this.memberRepo.findByWorkspaceAndUser(
      workspaceId,
      requesterId,
    );
    if (!requester || requester.role === "MEMBER") {
      throw new ForbiddenException("Insufficient role for this operation");
    }
  }

  private async sendInvitationEmail(
    invitation: WorkspaceInvitationRecord,
    plaintext: string,
    inviterUserId: string,
  ): Promise<void> {
    const workspace = await this.workspaceRepo.findById(invitation.workspaceId);
    if (!workspace) return;

    const inviter = await this.accounts.findById(inviterUserId);
    const baseUrl = this.config.get("APP_BASE_URL");
    const inviteUrl = `${baseUrl}/invitations/${plaintext}`;

    if (this.mail.isAvailable()) {
      try {
        await this.mail.send({
          to: invitation.invitedEmail,
          subject: `You've been invited to ${workspace.name} on SlugBase`,
          text: [
            `${inviter?.name ?? "Someone"} has invited you to join "${workspace.name}" on SlugBase as ${invitation.role}.`,
            "",
            "Accept your invitation:",
            inviteUrl,
            "",
            `This invitation expires in ${String(INVITATION_TTL_DAYS)} days.`,
            "",
            "If you did not expect this invitation, you can safely ignore this email.",
          ].join("\n"),
          type: "workspace_invitation",
        });
      } catch (err) {
        this.logger.error(
          "Failed to send invitation email",
          { workspaceId: invitation.workspaceId, invitedEmail: invitation.invitedEmail, err },
        );
      }
    }
  }

  /**
   * Returns invitation metadata for display on the accept page.
   * Does NOT accept the invitation. Returns 404 for missing tokens and 410 for
   * expired or already-accepted invitations.
   */
  async getInvitationMetadata(plaintext: string): Promise<InvitationMetadata> {
    const tokenHash = hashInvitationToken(plaintext);
    const invitation = await this.invitationRepo.findByTokenHash(tokenHash);

    if (!invitation) {
      throw new NotFoundException("Invitation not found");
    }

    if (invitation.acceptedAt !== null) {
      throw new HttpException(
        "This invitation has already been accepted",
        HttpStatus.GONE,
      );
    }

    if (invitation.expiresAt <= new Date()) {
      throw new HttpException("This invitation has expired", HttpStatus.GONE);
    }

    const workspace = await this.workspaceRepo.findById(invitation.workspaceId);
    if (!workspace) throw new NotFoundException("Workspace not found");

    const inviter = await this.accounts.findById(invitation.invitedByUserId);

    return {
      workspaceId: invitation.workspaceId,
      workspaceName: workspace.name,
      inviterName: inviter?.name ?? "Unknown",
      invitedEmail: invitation.invitedEmail,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * Accepts a workspace invitation.
   *
   * - If no account exists for the invited email: creates one (name + password required).
   * - If an account exists: adds as member regardless of whether they have a session.
   * - Marks `accepted_at` and creates a server-side session for the new member.
   * - Returns 409 if the invitation was already accepted or the user is already a member.
   * - Returns 410 if the invitation has expired.
   */
  async acceptInvitation(
    plaintext: string,
    dto: AcceptInvitationDto,
  ): Promise<AcceptInvitationResult> {
    const tokenHash = hashInvitationToken(plaintext);
    const invitation = await this.invitationRepo.findByTokenHash(tokenHash);

    if (!invitation) {
      throw new NotFoundException("Invitation not found");
    }

    if (invitation.acceptedAt !== null) {
      throw new ConflictException("This invitation has already been accepted");
    }

    if (invitation.expiresAt <= new Date()) {
      throw new HttpException("This invitation has expired", HttpStatus.GONE);
    }

    const workspace = await this.workspaceRepo.findById(invitation.workspaceId);
    if (!workspace) throw new NotFoundException("Workspace not found");

    assertMemberInvitationsEntitlement(this.entitlements, workspace);

    let account = await this.accounts.findByEmail(invitation.invitedEmail);

    if (!account) {
      if (!dto.name || !dto.password) {
        throw new UnprocessableEntityException(
          "Name and password are required when accepting an invitation without an existing account",
        );
      }
      account = await this.accounts.registerAccount({
        email: invitation.invitedEmail,
        name: dto.name,
        password: dto.password,
      });
      await this.accounts.markEmailVerified(account.id);
    }

    const existingMember = await this.memberRepo.findByWorkspaceAndUser(
      invitation.workspaceId,
      account.id,
    );
    if (existingMember) {
      await this.invitationRepo.markAccepted(invitation.id, Date.now());
      throw new ConflictException("User is already a member of this workspace");
    }

    await this.memberRepo.create({
      workspaceId: invitation.workspaceId,
      userId: account.id,
      role: invitation.role,
    });

    await this.invitationRepo.markAccepted(invitation.id, Date.now());

    const { cookieValue } = await this.sessions.createSession({
      userId: account.id,
      data: { activeWorkspaceId: invitation.workspaceId },
    });

    return {
      userId: account.id,
      workspaceId: invitation.workspaceId,
      cookieValue,
    };
  }
}
