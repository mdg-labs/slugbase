import {
  BadRequestException,
  Inject,
  Injectable,
} from "@nestjs/common";

import { AccountsService } from "../accounts/accounts.service.js";
import { DbService } from "../db/db.service.js";
import { EntitlementsService } from "../entitlements/entitlements.service.js";
import { WorkspaceDataGuard } from "../workspaces/workspace-data.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { WorkspacesService } from "../workspaces/workspaces.service.js";
import { AuditRepository } from "./audit.repository.js";
import type {
  AuditEventView,
  ListAuditEventsQuery,
  PaginatedAuditEvents,
  RecordAuditEventData,
} from "./audit.types.js";
import { assertAuditLogEntitlement } from "./audit.entitlements.js";
import {
  parseAuditEntityType,
  parseAuditSort,
  parsePage,
  parsePageSize,
  sanitizeAuditMetadata,
} from "./audit.validation.js";

@Injectable()
export class AuditService {
  private readonly auditRepo: AuditRepository;

  constructor(
    @Inject(DbService) db: DbService,
    @Inject(WorkspaceDataGuard) private readonly wsDataGuard: WorkspaceDataGuard,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
  ) {
    this.auditRepo = new AuditRepository(db.getOrm(), db.dialect);
  }

  /**
   * Append-only audit recording. Does not gate on entitlement — events are
   * captured for all plans so history exists when a workspace upgrades.
   */
  async recordEvent(data: RecordAuditEventData): Promise<void> {
    try {
      sanitizeAuditMetadata(data.metadata);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : "Invalid audit metadata",
      );
    }

    await this.auditRepo.append(data);
  }

  async listEvents(
    workspace: WorkspaceRecord,
    requesterId: string,
    query: ListAuditEventsQuery,
  ): Promise<PaginatedAuditEvents> {
    assertAuditLogEntitlement(this.entitlements, workspace);
    await this.workspaces.requireWorkspaceRole(workspace.id, requesterId, "ADMIN");

    let entityType;
    let sort;
    try {
      entityType = parseAuditEntityType(query.entityType);
      sort = parseAuditSort(query.sort);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : "Invalid list query",
      );
    }

    const page = parsePage(query.page);
    const pageSize = parsePageSize(query.pageSize);

    const result = await this.auditRepo.list(workspace.id, {
      q: query.q,
      actorUserId: query.actorUserId,
      entityType,
      sort,
      page,
      pageSize,
    });

    const actorIds = [...new Set(result.items.map((item) => item.actorUserId))];
    const actorMap = new Map<
      string,
      { name: string | null; email: string | null }
    >();

    await Promise.all(
      actorIds.map(async (actorId) => {
        const account = await this.accounts.findById(actorId);
        actorMap.set(actorId, {
          name: account?.name ?? null,
          email: account?.email ?? null,
        });
      }),
    );

    const items: AuditEventView[] = result.items.map((item) => {
      const verified = this.wsDataGuard.verifyOwnership(workspace.id, item);
      const actor = actorMap.get(verified.actorUserId);
      return {
        ...verified,
        actorName: actor?.name ?? null,
        actorEmail: actor?.email ?? null,
      };
    });

    return {
      items,
      total: result.total,
      page,
      pageSize,
    };
  }

  /** Used by tests and entitlement wiring (SB-61). */
  assertCanReadAuditLog(workspace: Pick<WorkspaceRecord, "plan">): void {
    assertAuditLogEntitlement(this.entitlements, workspace);
  }
}
