import { Inject, Injectable, Logger } from "@nestjs/common";

import { BookmarkRepository } from "../../bookmarks/bookmark.repository.js";
import { ConfigService } from "../../config/config.service.js";
import { DbService } from "../../db/db.service.js";
import { resolveEntitlementsForPlan } from "../plans/resolve-plan-entitlements.js";
import { WorkspaceRepository } from "../../workspaces/workspace.repository.js";
import type { WorkspacePlan, WorkspaceRecord } from "../../workspaces/workspace.types.js";
import {
  selectBookmarkIdsToArchive,
  selectBookmarkIdsToRestore,
  shouldArchiveOverflow,
} from "./archive-selection.js";

export interface DowngradeOverflowResult {
  archivedCount: number;
  restoredCount: number;
}

/**
 * Applies downgrade overflow archive and re-upgrade restore (spec §12.5, def §5).
 */
@Injectable()
export class DowngradeService {
  private readonly logger = new Logger(DowngradeService.name);
  private readonly bookmarkRepo: BookmarkRepository;
  private readonly workspaceRepo: WorkspaceRepository;

  constructor(
    @Inject(DbService) db: DbService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {
    const orm = db.getOrm();
    const dialect = db.dialect;
    this.bookmarkRepo = new BookmarkRepository(orm, dialect);
    this.workspaceRepo = new WorkspaceRepository(orm, dialect);
  }

  getGracePeriodDays(): number {
    return this.config.get("DOWNGRADE_GRACE_PERIOD_DAYS");
  }

  /**
   * Reacts to workspace plan/billing changes after subscription state is persisted.
   */
  async handlePlanTransition(
    previous: WorkspaceRecord | null,
    current: WorkspaceRecord,
    now: Date = new Date(),
  ): Promise<DowngradeOverflowResult> {
    const upgraded = this.didUpgradePlan(previous?.plan ?? "free", current.plan);
    let restoredCount = 0;
    if (upgraded) {
      restoredCount = await this.restoreArchivedBookmarks(current);
    }

    let archivedCount = 0;
    if (current.plan === "free") {
      archivedCount = await this.archiveOverflowIfDue(current, now);
    }

    return { archivedCount, restoredCount };
  }

  /**
   * Archives over-cap active bookmarks when grace has elapsed (spec §12.5).
   * Safe to call repeatedly — idempotent when already at cap.
   */
  async archiveOverflowIfDue(
    workspace: WorkspaceRecord,
    now: Date = new Date(),
  ): Promise<number> {
    if (
      !shouldArchiveOverflow(
        workspace.plan,
        workspace.billingPeriodEnd,
        this.getGracePeriodDays(),
        now,
      )
    ) {
      return 0;
    }

    const cap = resolveEntitlementsForPlan("free").bookmarkCap;
    if (cap === null) {
      return 0;
    }

    const active = await this.bookmarkRepo.listActiveInWorkspaceOrdered(workspace.id);
    const toArchive = selectBookmarkIdsToArchive(active, cap);
    if (toArchive.length === 0) {
      return 0;
    }

    await this.bookmarkRepo.bulkSetPlanArchived(workspace.id, toArchive, true);
    this.logger.log(
      `Archived ${String(toArchive.length)} overflow bookmark(s) for workspace ${workspace.id}`,
    );
    return toArchive.length;
  }

  /**
   * Restores plan-archived bookmarks up to the workspace's current cap (spec §12.5).
   */
  async restoreArchivedBookmarks(workspace: WorkspaceRecord): Promise<number> {
    const cap = resolveEntitlementsForPlan(workspace.plan).bookmarkCap;
    const activeCount = await this.bookmarkRepo.countActiveInWorkspace(workspace.id);
    const archived = await this.bookmarkRepo.listPlanArchivedInWorkspaceOrdered(workspace.id);
    const toRestore = selectBookmarkIdsToRestore(archived, activeCount, cap);
    if (toRestore.length === 0) {
      return 0;
    }

    await this.bookmarkRepo.bulkSetPlanArchived(workspace.id, toRestore, false);
    this.logger.log(
      `Restored ${String(toRestore.length)} plan-archived bookmark(s) for workspace ${workspace.id}`,
    );
    return toRestore.length;
  }

  /** Exposed for integration tests — reloads workspace then archives if due. */
  async processWorkspaceDowngrade(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<DowngradeOverflowResult> {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) {
      return { archivedCount: 0, restoredCount: 0 };
    }
    const archivedCount = await this.archiveOverflowIfDue(workspace, now);
    return { archivedCount, restoredCount: 0 };
  }

  private didUpgradePlan(previous: WorkspacePlan, current: WorkspacePlan): boolean {
    const rank: Record<WorkspacePlan, number> = {
      free: 0,
      personal: 1,
      team: 2,
    };
    return rank[current] > rank[previous];
  }
}
