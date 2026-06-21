import { adminInvites, adminUsers } from "@slugbase/db-admin/schema";
import { and, asc, eq, isNull } from "drizzle-orm";

import type { AdminEnv } from "../config/env.schema.js";
import type { AdminDb } from "../db/create-db.js";
import { renderOperatorInviteEmail } from "../mail/operator-invite.template.js";
import type { AdminMailSender } from "../mail/smtp-mail.service.js";
import { AdminSmtpMailService } from "../mail/smtp-mail.service.js";
import type { AdminRole } from "./admin-roles.js";
import { isAdminRole } from "./admin-roles.js";
import { AdminAuditService } from "./audit.service.js";
import { AdminPasswordService } from "./password.service.js";
import { generateOpaqueToken, hashOpaqueToken } from "./token.util.js";

const INVITE_TTL_DAYS = 7;
const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

export class AdminInviteError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AdminInviteError";
  }
}

export interface AdminInviteSummary {
  id: string;
  email: string;
  role: AdminRole;
  invitedBy: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
}

export class AdminInviteService {
  private readonly mail: AdminMailSender;
  private readonly audit: AdminAuditService;

  constructor(
    private readonly adminDb: AdminDb,
    private readonly config: AdminEnv,
    private readonly passwords: AdminPasswordService = new AdminPasswordService(),
    mail?: AdminMailSender,
    audit?: AdminAuditService,
  ) {
    this.mail = mail ?? new AdminSmtpMailService(config);
    this.audit = audit ?? new AdminAuditService(adminDb);
  }

  async createInvite(input: {
    email: string;
    role: AdminRole;
    invitedByUserId: string;
  }): Promise<{ invite: AdminInviteSummary; token: string }> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const token = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(token);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const [invite] = await this.adminDb.db
      .insert(adminInvites)
      .values({
        email: normalizedEmail,
        role: input.role,
        tokenHash,
        invitedBy: input.invitedByUserId,
        expiresAt,
      })
      .returning();

    if (!invite) {
      throw new Error("Failed to create admin invite");
    }

    const inviteUrl = new URL("/accept-invite", this.config.ADMIN_URL);
    inviteUrl.searchParams.set("token", token);

    const rendered = renderOperatorInviteEmail({
      inviteUrl: inviteUrl.toString(),
      invitedEmail: normalizedEmail,
      role: input.role,
      expiresAt,
    });

    await this.mail.send({
      to: normalizedEmail,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });

    await this.audit.record({
      adminUserId: input.invitedByUserId,
      action: "admin.invite",
      targetType: "admin_invite",
      targetId: invite.id,
      metadata: {
        email: normalizedEmail,
        role: input.role,
      },
    });

    return {
      invite: toInviteSummary(invite),
      token,
    };
  }

  async listInvites(): Promise<AdminInviteSummary[]> {
    const rows = await this.adminDb.db
      .select()
      .from(adminInvites)
      .orderBy(asc(adminInvites.createdAt));

    return rows.map(toInviteSummary);
  }

  async revokeInvite(input: {
    inviteId: string;
    actorUserId: string;
  }): Promise<void> {
    const rows = await this.adminDb.db
      .select()
      .from(adminInvites)
      .where(eq(adminInvites.id, input.inviteId))
      .limit(1);

    const invite = rows[0];
    if (!invite) {
      throw new AdminInviteError("Invite not found", 404);
    }

    if (invite.acceptedAt) {
      throw new AdminInviteError("Invite already accepted", 409);
    }

    await this.adminDb.db
      .delete(adminInvites)
      .where(eq(adminInvites.id, input.inviteId));

    await this.audit.record({
      adminUserId: input.actorUserId,
      action: "admin.revoke_invite",
      targetType: "admin_invite",
      targetId: invite.id,
      metadata: {
        email: invite.email,
        role: invite.role,
      },
    });
  }

  async acceptInvite(input: {
    token: string;
    password: string;
  }): Promise<{ userId: string; email: string; role: AdminRole }> {
    const tokenHash = hashOpaqueToken(input.token);
    const now = new Date();

    const rows = await this.adminDb.db
      .select()
      .from(adminInvites)
      .where(
        and(
          eq(adminInvites.tokenHash, tokenHash),
          isNull(adminInvites.acceptedAt),
        ),
      )
      .limit(1);

    const invite = rows[0];
    if (!invite) {
      throw new AdminInviteError("Invalid or expired invitation", 400);
    }

    if (invite.expiresAt <= now) {
      throw new AdminInviteError("Invalid or expired invitation", 400);
    }

    const existingUsers = await this.adminDb.db
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.email, invite.email))
      .limit(1);

    if (existingUsers[0]) {
      throw new AdminInviteError("An account with this email already exists", 409);
    }

    if (!isAdminRole(invite.role)) {
      throw new AdminInviteError("Invite has an invalid role", 500);
    }

    const passwordHash = await this.passwords.hashPassword(input.password);

    const [user] = await this.adminDb.db
      .insert(adminUsers)
      .values({
        email: invite.email,
        passwordHash,
        role: invite.role,
      })
      .returning({
        id: adminUsers.id,
        email: adminUsers.email,
        role: adminUsers.role,
      });

    if (!user) {
      throw new Error("Failed to create admin user from invite");
    }

    await this.adminDb.db
      .update(adminInvites)
      .set({ acceptedAt: now })
      .where(eq(adminInvites.id, invite.id));

    return {
      userId: user.id,
      email: user.email,
      role: user.role as AdminRole,
    };
  }
}

function toInviteSummary(invite: typeof adminInvites.$inferSelect): AdminInviteSummary {
  if (!isAdminRole(invite.role)) {
    throw new Error(`Invalid invite role: ${invite.role}`);
  }

  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    invitedBy: invite.invitedBy,
    expiresAt: invite.expiresAt,
    acceptedAt: invite.acceptedAt,
    createdAt: invite.createdAt,
  };
}
